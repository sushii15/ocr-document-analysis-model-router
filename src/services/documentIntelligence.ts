import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import { DocumentProfile, TaskType } from "../types.js";
import { OcrResult, UploadedDocument } from "./ocrService.js";
import { withSupabaseDb } from "./supabaseDb.js";

export interface DocumentIntelligenceRecord {
  id: string;
  sessionId: string;
  userId?: string;
  runId?: string;
  requestId?: string;
  fileSha256: string;
  fileName: string;
  fileMimeType: string;
  fileSize: number;
  storageBucket?: string;
  storagePath?: string;
  documentType?: string;
  taskType?: TaskType;
  sourceInstitution?: string;
  layoutFingerprint: string;
  visualFingerprint: string;
  ocrEngine: string;
  ocrCharacterCount: number;
  ocrWordCount: number;
  ocrLineCount: number;
  ocrDigitRatio: number;
  ocrCurrencyCount: number;
  ocrDateCount: number;
  ocrTableSignal: number;
  documentProfile: DocumentProfile;
  documentFeatures: Record<string, unknown>;
  selectedModelId?: string;
  evaluation?: Record<string, unknown>;
  userFeedback?: "happy" | "not_happy";
  createdAt: string;
}

export async function buildDocumentIntelligenceRecord(input: {
  id: string;
  sessionId: string;
  userId?: string;
  runId?: string;
  requestId?: string;
  file: UploadedDocument;
  ocr: OcrResult;
  documentProfile: DocumentProfile;
  taskType: TaskType;
  selectedModelId?: string;
  evaluation?: Record<string, unknown>;
  storageRef?: { bucket?: string; path?: string };
}): Promise<DocumentIntelligenceRecord> {
  const hash = await hashFile(input.file.path);
  const features = extractFeatures(input.ocr.text, input.documentProfile, input.file);
  return {
    id: input.id,
    sessionId: input.sessionId,
    userId: input.userId,
    runId: input.runId,
    requestId: input.requestId,
    fileSha256: hash,
    fileName: input.file.originalName,
    fileMimeType: input.file.mimeType,
    fileSize: input.file.size,
    storageBucket: input.storageRef?.bucket,
    storagePath: input.storageRef?.path,
    documentType: input.documentProfile.document_type,
    taskType: input.taskType,
    sourceInstitution: input.documentProfile.source_institution,
    layoutFingerprint: fingerprint([
      input.documentProfile.document_type,
      input.documentProfile.source_institution,
      input.documentProfile.page_count,
      input.documentProfile.layout_complexity,
      input.documentProfile.table_density,
      features.lineCountBucket,
      features.tableSignalBucket,
      features.digitRatioBucket,
    ]),
    visualFingerprint: fingerprint([
      input.file.mimeType,
      features.fileSizeBucket,
      input.documentProfile.file_type,
      input.documentProfile.image_quality,
      input.documentProfile.text_layer_quality,
      input.documentProfile.has_handwriting,
      input.documentProfile.has_tables,
    ]),
    ocrEngine: input.ocr.engine,
    ocrCharacterCount: input.ocr.text.length,
    ocrWordCount: features.wordCount,
    ocrLineCount: features.lineCount,
    ocrDigitRatio: features.digitRatio,
    ocrCurrencyCount: features.currencyCount,
    ocrDateCount: features.dateCount,
    ocrTableSignal: features.tableSignal,
    documentProfile: input.documentProfile,
    documentFeatures: features,
    selectedModelId: input.selectedModelId,
    evaluation: input.evaluation,
    createdAt: new Date().toISOString(),
  };
}

export async function saveDocumentIntelligence(record: DocumentIntelligenceRecord) {
  await writeDocumentIntelligenceLocal(record);
  await mirrorDocumentIntelligence(record);
}

export async function updateDocumentIntelligenceFeedback(runId: string | undefined, feedback: "happy" | "not_happy") {
  if (!runId) return;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    await withSupabaseDb((client) => client.query(
      `update public.docrouter_v2_document_intelligence set user_feedback=$1 where id=$2 or run_id=$2`,
      [feedback, runId],
    ));
    return;
  }
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await supabase
    .from("docrouter_v2_document_intelligence")
    .update({ user_feedback: feedback })
    .or(`id.eq.${runId},run_id.eq.${runId}`);
  if (error) throw error;
}

async function hashFile(filePath: string) {
  const hash = crypto.createHash("sha256");
  const buffer = await fs.readFile(filePath);
  hash.update(buffer);
  return hash.digest("hex");
}

function extractFeatures(text: string, profile: DocumentProfile, file: UploadedDocument) {
  const normalized = text || "";
  const lines = normalized.split(/\n+/).filter((line) => line.trim());
  const words = normalized.match(/\b[\w.-]+\b/g) || [];
  const digits = normalized.match(/\d/g) || [];
  const currency = normalized.match(/[$]|(?:usd|eur|gbp|inr)\b/gi) || [];
  const dates = normalized.match(/\b(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}[/-]\d{1,2}[/-]\d{1,2})\b/g) || [];
  const tableishLines = lines.filter((line) => {
    const separators = (line.match(/\s{2,}|\t|\|/g) || []).length;
    const numericCells = (line.match(/[-+]?\d[\d,]*(?:\.\d+)?/g) || []).length;
    return separators >= 2 || numericCells >= 3;
  });
  const digitRatio = normalized.length ? digits.length / normalized.length : 0;
  const tableSignal = lines.length ? tableishLines.length / lines.length : (profile.has_tables ? 0.5 : 0);
  return {
    wordCount: words.length,
    lineCount: lines.length,
    digitRatio: round4(digitRatio),
    currencyCount: currency.length,
    dateCount: dates.length,
    tableSignal: round4(tableSignal),
    lineCountBucket: bucket(lines.length, [20, 80, 200]),
    wordCountBucket: bucket(words.length, [200, 1200, 5000]),
    digitRatioBucket: bucket(digitRatio, [0.05, 0.12, 0.22]),
    tableSignalBucket: bucket(tableSignal, [0.08, 0.25, 0.5]),
    fileSizeBucket: bucket(file.size, [100_000, 1_000_000, 8_000_000]),
    hasCurrency: currency.length > 0,
    hasDates: dates.length > 0,
    hasDenseNumbers: digitRatio > 0.15,
    hasTableLikeText: tableSignal > 0.2,
    hasSparseOcr: normalized.length < 80,
  };
}

async function writeDocumentIntelligenceLocal(record: DocumentIntelligenceRecord) {
  const dir = process.env.V2_DOCUMENT_INTELLIGENCE_DIR || ".docrouter/v2-document-intelligence";
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(`${dir}/documents.jsonl`, `${JSON.stringify(record)}\n`);
}

async function mirrorDocumentIntelligence(record: DocumentIntelligenceRecord) {
  const row = toRow(record);
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    await withSupabaseDb((client) => client.query(
      `insert into public.docrouter_v2_document_intelligence
        (id, session_id, user_id, run_id, request_id, file_sha256, file_name, file_mime_type, file_size,
         storage_bucket, storage_path, document_type, task_type, source_institution, layout_fingerprint, visual_fingerprint, ocr_engine,
         ocr_character_count, ocr_word_count, ocr_line_count, ocr_digit_ratio, ocr_currency_count, ocr_date_count,
         ocr_table_signal, document_profile, document_features, selected_model_id, evaluation, user_feedback, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)
       on conflict (id) do update set request_id=excluded.request_id, selected_model_id=excluded.selected_model_id,
         storage_bucket=excluded.storage_bucket, storage_path=excluded.storage_path,
         evaluation=excluded.evaluation, user_feedback=excluded.user_feedback`,
      [
        row.id, row.session_id, row.user_id, row.run_id, row.request_id, row.file_sha256, row.file_name, row.file_mime_type,
        row.file_size, row.storage_bucket, row.storage_path, row.document_type, row.task_type, row.source_institution, row.layout_fingerprint, row.visual_fingerprint,
        row.ocr_engine, row.ocr_character_count, row.ocr_word_count, row.ocr_line_count, row.ocr_digit_ratio,
        row.ocr_currency_count, row.ocr_date_count, row.ocr_table_signal, row.document_profile, row.document_features,
        row.selected_model_id, row.evaluation, row.user_feedback, row.created_at,
      ],
    ));
    return;
  }
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await supabase.from("docrouter_v2_document_intelligence").upsert(row, { onConflict: "id" });
  if (error) throw error;
}

function toRow(record: DocumentIntelligenceRecord) {
  return {
    id: record.id,
    session_id: record.sessionId,
    user_id: record.userId || null,
    run_id: record.runId || null,
    request_id: record.requestId || null,
    file_sha256: record.fileSha256,
    file_name: record.fileName,
    file_mime_type: record.fileMimeType,
    file_size: record.fileSize,
    storage_bucket: record.storageBucket || null,
    storage_path: record.storagePath || null,
    document_type: record.documentType || null,
    task_type: record.taskType || null,
    source_institution: record.sourceInstitution || null,
    layout_fingerprint: record.layoutFingerprint,
    visual_fingerprint: record.visualFingerprint,
    ocr_engine: record.ocrEngine,
    ocr_character_count: record.ocrCharacterCount,
    ocr_word_count: record.ocrWordCount,
    ocr_line_count: record.ocrLineCount,
    ocr_digit_ratio: record.ocrDigitRatio,
    ocr_currency_count: record.ocrCurrencyCount,
    ocr_date_count: record.ocrDateCount,
    ocr_table_signal: record.ocrTableSignal,
    document_profile: record.documentProfile,
    document_features: record.documentFeatures,
    selected_model_id: record.selectedModelId || null,
    evaluation: record.evaluation || null,
    user_feedback: record.userFeedback || null,
    created_at: record.createdAt,
  };
}

function fingerprint(parts: unknown[]) {
  return crypto.createHash("sha256").update(parts.map((part) => String(part ?? "unknown")).join("|")).digest("hex").slice(0, 16);
}

function bucket(value: number, cuts: number[]) {
  if (value <= cuts[0]) return "low";
  if (value <= cuts[1]) return "medium";
  if (value <= cuts[2]) return "high";
  return "very_high";
}

function round4(value: number) {
  return Math.round(value * 10000) / 10000;
}
