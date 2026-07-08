import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { buildCredentialMap, CredentialProvider } from "./credentialStore.js";
import { executeRequest } from "./executionEngine.js";
import { runNonLlmOcr, UploadedDocument } from "./ocrService.js";
import { evaluateExtraction, logV2Event } from "./v2Learning.js";
import { listModels } from "./modelCatalog.js";
import { DocumentProfile, ExecuteRequest, RoutingPolicy, TaskType } from "../types.js";
import { recordOutcome } from "./routingEngine.js";
import { withSupabaseDb } from "./supabaseDb.js";
import { getEnabledModelIdsForUser } from "./userProfileStore.js";
import { buildDocumentIntelligenceRecord, saveDocumentIntelligence } from "./documentIntelligence.js";
import { storeUploadedDocument } from "./storageService.js";
import { runtimeDataDir } from "./runtimePaths.js";

export interface V2ExtractInput {
  sessionId: string;
  userId?: string;
  instruction: string;
  documentProfile?: DocumentProfile;
  allowedModels: string[];
  policy?: RoutingPolicy;
  providerCredentials?: ExecuteRequest["provider_credentials"];
  dryRun?: boolean;
  file: UploadedDocument;
}

export async function runV2Extraction(input: V2ExtractInput) {
  const uploadId = randomUUID();
  const startedAt = new Date().toISOString();
  const ocr = await runNonLlmOcr(input.file);
  const storageRef = await storeUploadedDocument({
    userId: input.userId,
    sessionId: input.sessionId,
    runId: uploadId,
    file: input.file,
  });
  const documentProfile = {
    ...(input.documentProfile || {}),
    ...ocr.profilePatch,
  };
  const taskType = taskTypeFromProfile(documentProfile);
  const prompt = buildExtractionPrompt(input.instruction, documentProfile, ocr.text, ocr.warnings);
  const userEnabledModels = getEnabledModelIdsForUser(input.userId);
  const allowedModels = input.allowedModels.length
    ? input.allowedModels
    : userEnabledModels?.length
      ? userEnabledModels
      : listModels().map((model) => model.id);
  const storedProviderCredentials = buildCredentialMap(
    input.sessionId,
    input.userId,
    providersForModels(allowedModels),
  );
  const providerCredentials = {
    ...storedProviderCredentials,
    ...(input.providerCredentials || {}),
  };

  await logV2Event({
    sessionId: input.sessionId,
    userId: input.userId,
    eventType: "document_profiled",
    taskType,
    documentProfile,
    extractionInstruction: input.instruction,
    payload: {
      upload_id: uploadId,
      file_name: input.file.originalName,
      file_size: input.file.size,
      storage_bucket: storageRef.bucket,
      storage_path: storageRef.path,
      storage_skipped_reason: storageRef.skippedReason,
      ocr_engine: ocr.engine,
      ocr_warnings: ocr.warnings,
    },
  });

  const result = await executeRequest({
    prompt,
    system_prompt: buildSystemPrompt(input.instruction),
    task_type: taskType,
    document_profile: documentProfile,
    estimated_input_tokens: estimateTokens(prompt),
    estimated_output_tokens: estimateOutputTokens(documentProfile),
    dry_run: input.dryRun,
    record_outcome: false,
    policy: {
      ...(input.policy || {}),
      allowedModels,
    },
    provider_credentials: providerCredentials,
    temperature: 0,
    max_output_tokens: 1800,
  });

  await logV2Event({
    sessionId: input.sessionId,
    userId: input.userId,
    eventType: result.execution.dryRun ? "extraction_simulated" : "extraction_executed",
    requestId: result.decision.requestId,
    modelId: result.decision.selectedModel.id,
    taskType,
    documentProfile,
    extractionInstruction: input.instruction,
    payload: {
      upload_id: uploadId,
      dry_run: result.execution.dryRun,
      provider: result.execution.provider,
      input_tokens: result.execution.inputTokens,
      output_tokens: result.execution.outputTokens,
      cost_usd: result.execution.actualCostUsd ?? result.decision.estimatedCostUsd,
      latency_ms: result.execution.actualLatencyMs,
      ocr_engine: ocr.engine,
    },
  });

  const extraction = parseExtractionJson(result.execution.outputText, taskType);
  const evaluation = evaluateExtraction({ taskType, documentProfile, extraction });
  const documentIntelligence = await buildDocumentIntelligenceRecord({
    id: uploadId,
    sessionId: input.sessionId,
    userId: input.userId,
    runId: uploadId,
    requestId: result.decision.requestId,
    file: input.file,
    ocr,
    documentProfile,
    taskType,
    selectedModelId: result.decision.selectedModel.id,
    evaluation: evaluation as unknown as Record<string, unknown>,
    storageRef,
  });
  await saveDocumentIntelligence(documentIntelligence);

  await logV2Event({
    sessionId: input.sessionId,
    userId: input.userId,
    eventType: "eval_completed",
    requestId: result.decision.requestId,
    modelId: result.decision.selectedModel.id,
    taskType,
    documentProfile,
    extractionInstruction: input.instruction,
    payload: { upload_id: uploadId, evaluation },
  });

  recordOutcome({
    request_id: result.decision.requestId,
    success: evaluation.validationPassed && !result.execution.dryRun,
    validation_passed: evaluation.validationPassed,
    needed_escalation: !evaluation.validationPassed,
    quality_score: evaluation.qualityScore,
    actual_cost_usd: result.execution.actualCostUsd ?? result.decision.estimatedCostUsd,
    actual_latency_ms: result.execution.actualLatencyMs,
    error_type: result.execution.dryRun ? "dry_run" : evaluation.errors[0],
    evaluator_type: "rule",
    notes: "V2 extraction evaluated by deterministic math/rule checks.",
    metadata: { upload_id: uploadId, ocr_engine: ocr.engine, ocr_warnings: ocr.warnings },
  });

  const response = {
    upload_id: uploadId,
    started_at: startedAt,
    file: {
      name: input.file.originalName,
      mime_type: input.file.mimeType,
      size: input.file.size,
      storage_bucket: storageRef.bucket,
      storage_path: storageRef.path,
      storage_skipped_reason: storageRef.skippedReason,
    },
    ocr,
    document_profile: documentProfile,
    task_type: taskType,
    decision: result.decision,
    execution: {
      ...result.execution,
      raw: undefined,
    },
    extraction,
    evaluation,
    document_intelligence: {
      file_sha256: documentIntelligence.fileSha256,
      layout_fingerprint: documentIntelligence.layoutFingerprint,
      visual_fingerprint: documentIntelligence.visualFingerprint,
      features: documentIntelligence.documentFeatures,
    },
  };

  await mirrorRun(input, response);
  return response;
}

export function buildSystemPrompt(instruction: string) {
  return [
    "You are DocRouter's document extraction worker.",
    "Return only strict JSON. Do not include markdown fences or explanation.",
    "Use null for missing fields. Preserve numeric values as numbers, not strings.",
    "For invoices include vendor, invoice_number, invoice_date, subtotal, tax, fees, discount, total, line_items, and confidence when relevant.",
    "For bank statements include account_last4 or account_number, opening_balance, closing_balance, transactions, and confidence when relevant.",
    `User goal: ${instruction}`,
  ].join("\n");
}

function buildExtractionPrompt(instruction: string, profile: DocumentProfile, ocrText: string, warnings: string[]) {
  return [
    `Extraction instruction: ${instruction}`,
    `Document profile: ${JSON.stringify(profile)}`,
    warnings.length ? `OCR warnings: ${warnings.join("; ")}` : "OCR warnings: none",
    "OCR text:",
    ocrText || "[No OCR text was available. Use document profile and provider vision capabilities if the provider supports uploaded images in a future adapter.]",
  ].join("\n\n");
}

function parseExtractionJson(outputText: string, taskType: TaskType) {
  const stripped = outputText.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(stripped.slice(start, end + 1));
    } catch {
      // Fall through to deterministic failure payload.
    }
  }
  return {
    parse_error: true,
    task_type: taskType,
    raw_output_preview: outputText.slice(0, 2000),
  };
}

function taskTypeFromProfile(profile: DocumentProfile): TaskType {
  if (profile.document_type === "invoice") return "invoice_extraction";
  if (profile.document_type === "bank_statement") return "bank_statement_extraction";
  if (profile.has_handwriting) return "handwriting_extraction";
  if (profile.has_tables || (profile.table_density || 0) > 0.4) return "table_extraction";
  if ((profile.page_count || 0) > 20) return "long_document_extraction";
  return "field_extraction";
}

function providersForModels(modelIds: string[]): CredentialProvider[] {
  const providers = new Set<CredentialProvider>();
  for (const model of listModels().filter((candidate) => modelIds.includes(candidate.id))) {
    providers.add(model.hosting === "self-hosted" ? "self_hosted" : model.provider);
  }
  return Array.from(providers);
}

function estimateTokens(text: string) {
  return Math.max(1, Math.ceil(text.length / 4));
}

function estimateOutputTokens(profile: DocumentProfile) {
  return Math.ceil(700 + (profile.page_count || 1) * 90 + (profile.table_count || 0) * 70);
}

async function mirrorRun(input: V2ExtractInput, response: any) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const row = {
    id: response.upload_id,
    session_id: input.sessionId,
    user_id: input.userId || null,
    request_id: response.decision.requestId,
    model_id: response.decision.selectedModel.id,
    task_type: response.task_type,
    file_name: response.file.name,
    file_mime_type: response.file.mime_type,
    file_size: response.file.size,
    storage_bucket: response.file.storage_bucket || null,
    storage_path: response.file.storage_path || null,
    ocr_engine: response.ocr.engine,
    ocr_warnings: response.ocr.warnings,
    document_profile: response.document_profile,
    extraction_instruction: input.instruction,
    extraction: response.extraction,
    evaluation: response.evaluation,
    dry_run: response.execution.dryRun,
    estimated_cost_usd: response.decision.estimatedCostUsd,
    actual_cost_usd: response.execution.actualCostUsd || null,
    latency_ms: response.execution.actualLatencyMs,
    created_at: response.started_at,
  };
  if (!url || !key) {
    await withSupabaseDb((client) => client.query(
      `insert into public.docrouter_v2_runs
        (id, session_id, user_id, request_id, model_id, task_type, file_name, file_mime_type, file_size, ocr_engine,
         ocr_warnings, document_profile, extraction_instruction, extraction, evaluation, dry_run, estimated_cost_usd,
         actual_cost_usd, latency_ms, storage_bucket, storage_path, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       on conflict (id) do nothing`,
      [
        row.id,
        row.session_id,
        row.user_id,
        row.request_id,
        row.model_id,
        row.task_type,
        row.file_name,
        row.file_mime_type,
        row.file_size,
        row.ocr_engine,
        row.ocr_warnings,
        row.document_profile,
        row.extraction_instruction,
        row.extraction,
        row.evaluation,
        row.dry_run,
        row.estimated_cost_usd,
        row.actual_cost_usd,
        row.latency_ms,
        row.storage_bucket,
        row.storage_path,
        row.created_at,
      ],
    ));
    return;
  }
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await supabase.from("docrouter_v2_runs").insert(row);
  if (error) throw error;
}

export function ensureUploadDir() {
  const uploadDir = process.env.V2_UPLOAD_DIR || runtimeDataDir("v2-uploads");
  fs.mkdirSync(uploadDir, { recursive: true });
  return uploadDir;
}
