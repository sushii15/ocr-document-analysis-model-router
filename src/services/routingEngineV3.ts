import { randomUUID } from "node:crypto";
import { evaluateDocumentDifficultyV3 } from "./documentProfileV3.js";
import { hasCompliance, MODEL_CATALOG } from "./modelCatalog.js";
import {
  ModelScore,
  ModelSpec,
  ModelTier,
  RouteRequest,
  RoutingDecision,
  RoutingPolicy,
  RoutingStrategy,
  TaskType,
} from "../types.js";

const DEFAULT_POLICY: RoutingPolicy = {
  strategy: "balanced",
  allowSelfHosted: true,
};

const STATIC_SCORE_MAX = 1.08;

export function routeV3(req: RouteRequest): RoutingDecision {
  const timestamp = new Date().toISOString();
  const documentDifficulty = evaluateDocumentDifficultyV3(req.prompt, req.document_profile, req.task_type, req.step_type);
  const inputTokens = req.estimated_input_tokens ?? estimateTokens(req.prompt, req.document_profile);
  const classification = req.task_type
    ? { taskType: req.task_type, confidence: 1, complexity: documentDifficulty.complexity }
    : classifyTaskV3(req.prompt, req.step_type, documentDifficulty);
  const outputTokens = req.estimated_output_tokens ?? estimateOutputTokens(classification.taskType, documentDifficulty.score);
  const policy = normalizePolicy(req.policy);
  const preferredTiers = preferredTierForTask(classification.taskType, classification.complexity);
  const appliedWeights = adjustedStrategyWeights(policy.strategy || "balanced", classification.taskType, req.document_profile, documentDifficulty);
  const scored = scoreModelsV3(MODEL_CATALOG, policy, inputTokens, outputTokens, preferredTiers, classification.taskType, req.document_profile, documentDifficulty, appliedWeights);
  const eligible = scored.filter((score) => !score.filteredReason).sort((a, b) => compareScores(a, b, policy.strategy || "balanced"));

  if (!eligible.length) {
    throw new Error("No eligible model found for this request. Relax policy filters or inspect router_list_models.");
  }

  const selectedScore = eligible[0];
  const fallbackScore = eligible[1];
  const selectedModel = mustFindModel(selectedScore.modelId);
  const fallbackModel = fallbackScore ? mustFindModel(fallbackScore.modelId) : undefined;

  return {
    requestId: randomUUID(),
    timestamp,
    agentId: req.agent_id,
    trajectoryId: req.trajectory_id,
    stepType: req.step_type,
    detectedTaskType: classification.taskType,
    classificationConfidence: classification.confidence,
    selectedModel,
    fallbackModel,
    policyApplied: policy,
    modelScores: scored.sort((a, b) => compareScores(a, b, policy.strategy || "balanced")),
    estimatedInputTokens: inputTokens,
    estimatedOutputTokens: outputTokens,
    estimatedCostUsd: roundMoney(selectedScore.estimatedCostUsd),
    estimatedLatencyMs: selectedModel.avgLatencyMs,
    reasoning: buildReasoning(selectedModel, fallbackModel, classification.taskType, policy, selectedScore, documentDifficulty),
    alternativesConsidered: eligible.slice(1, 5).map((score) => score.modelId),
    documentProfile: req.document_profile,
    documentDifficulty,
    appliedWeights,
  };
}

export function scoreModelsV3(
  models: ModelSpec[],
  policy: RoutingPolicy,
  inputTokens: number,
  outputTokens: number,
  preferredTiers: ModelTier[],
  taskType: TaskType = "unknown",
  documentProfile?: RouteRequest["document_profile"],
  documentDifficulty?: ReturnType<typeof evaluateDocumentDifficultyV3>,
  appliedWeights = adjustedStrategyWeights(policy.strategy || "balanced", taskType, documentProfile, documentDifficulty),
): ModelScore[] {
  const modelCosts = models.map((model) => costFor(model, inputTokens, outputTokens));
  const minCost = Math.min(...modelCosts);
  const maxCost = Math.max(...modelCosts);
  const maxLatency = Math.max(...models.map((model) => model.avgLatencyMs));

  return models.map((model) => {
    const filteredReason = filterReason(model, policy, inputTokens, outputTokens);
    const estimatedCostUsd = costFor(model, inputTokens, outputTokens);
    const documentFit = documentFitForModelV3(model, taskType, documentProfile, documentDifficulty);
    const costScore = costScoreFor(estimatedCostUsd, minCost, maxCost);
    const qualityScore = qualityScoreFor(model.qualityScore, documentFit.qualityDelta);
    const latencyScore = clampScore(1 - model.avgLatencyMs / maxLatency + documentFit.latencyDelta);
    const tierBonus = preferredTiers.includes(model.tier) ? 0.08 - preferredTiers.indexOf(model.tier) * 0.04 : 0;
    const staticScore = policy.strategy === "cost"
      ? costScore * 0.82 + qualityScore * 0.12 + latencyScore * 0.06 + tierBonus
      : costScore * appliedWeights.cost + qualityScore * appliedWeights.quality + latencyScore * appliedWeights.latency + tierBonus;
    const normalizedScore = clampScore(staticScore / STATIC_SCORE_MAX);

    return {
      modelId: model.id,
      score: filteredReason ? -1 : normalizedScore,
      costScore,
      qualityScore,
      latencyScore,
      documentFitScore: documentFit.qualityDelta,
      rawDocumentFitScore: undefined,
      documentFitReasons: documentFit.reasons,
      tierBonus,
      staticScore,
      learnedScore: normalizedScore,
      learnedBlend: 0,
      estimatedCostUsd,
      filteredReason,
    };
  });
}

function classifyTaskV3(prompt: string, stepType?: string, documentDifficulty = evaluateDocumentDifficultyV3(prompt, undefined, undefined, stepType)): { taskType: TaskType; confidence: number; complexity: "low" | "medium" | "high" } {
  const text = `${stepType || ""}\n${prompt}`;
  const signals: Array<[RegExp, TaskType, number]> = [
    [/\b(bank statement|statement|transaction|debit|credit|balance|account number|routing number)\b/i, "bank_statement_extraction", 0.92],
    [/\b(invoice|receipt|purchase order|po number|vendor|subtotal|tax|line item|amount due)\b/i, "invoice_extraction", 0.92],
    [/\b(long document|contract|policy|prospectus|annual report|hundreds of pages|multi-page|multi page)\b/i, "long_document_extraction", 0.88],
    [/\b(table|tabular|columns|rows|line items|transaction table|schedule)\b/i, "table_extraction", 0.86],
    [/\b(handwriting|handwritten|cursive|signature|scanned form)\b/i, "handwriting_extraction", 0.86],
    [/\b(classify|detect document type|document type|is this an invoice|is this a statement)\b/i, "document_classification", 0.84],
    [/\b(reconcile|balance|match totals|sum transactions|line item total|debits and credits)\b/i, "reconciliation", 0.88],
    [/\b(validate|validation|required fields|schema|confidence|verify totals)\b/i, "validation", 0.84],
    [/\b(ocr|scan|scanned|image pdf|extract text|text layer|read pdf)\b/i, "ocr", 0.86],
    [/\b(extract|parse|pdf|document|field|structured data|json)\b/i, "field_extraction", 0.82],
  ];

  for (const [regex, taskType, confidence] of signals) {
    if (!regex.test(text)) continue;
    const recommended = documentDifficulty.recommendedTaskType;
    if (recommended !== "unknown" && recommended !== taskType) {
      return { taskType: recommended, confidence: Math.min(confidence, 0.75), complexity: documentDifficulty.complexity };
    }
    return { taskType: recommended !== "unknown" ? recommended : taskType, confidence, complexity: documentDifficulty.complexity };
  }
  return { taskType: documentDifficulty.recommendedTaskType, confidence: 0.45, complexity: documentDifficulty.complexity };
}

function compareScores(a: ModelScore, b: ModelScore, strategy: RoutingStrategy) {
  const scoreDelta = b.score - a.score;
  if (scoreDelta !== 0) return scoreDelta;
  if (strategy === "quality") return b.qualityScore - a.qualityScore || a.estimatedCostUsd - b.estimatedCostUsd;
  if (strategy === "latency") return b.latencyScore - a.latencyScore || a.estimatedCostUsd - b.estimatedCostUsd;
  return a.estimatedCostUsd - b.estimatedCostUsd || b.qualityScore - a.qualityScore || b.latencyScore - a.latencyScore;
}

function normalizePolicy(policy?: RoutingPolicy): RoutingPolicy {
  return { ...DEFAULT_POLICY, ...(policy || {}) };
}

function filterReason(model: ModelSpec, policy: RoutingPolicy, inputTokens: number, outputTokens: number) {
  if (policy.allowedModels && !policy.allowedModels.includes(model.id)) return "model not enabled by user";
  if (policy.forceTier && model.tier !== policy.forceTier) return `forceTier=${policy.forceTier}`;
  if (policy.allowedTiers && !policy.allowedTiers.includes(model.tier)) return `tier ${model.tier} not allowed`;
  if (policy.allowedProviders && !policy.allowedProviders.includes(model.provider)) return `provider ${model.provider} not allowed`;
  if (policy.allowSelfHosted === false && model.hosting === "self-hosted") return "self-hosted disabled";
  if (policy.requiredCompliance && !hasCompliance(model, policy.requiredCompliance)) return "missing compliance tag";
  if (policy.maxLatencyMs && model.avgLatencyMs > policy.maxLatencyMs) return "latency ceiling exceeded";
  if (policy.minQualityScore && model.qualityScore < policy.minQualityScore) return "quality floor not met";
  if (policy.maxCostPer1kTokens) {
    const effectiveCostPer1k = (costFor(model, inputTokens, outputTokens) / Math.max(1, inputTokens + outputTokens)) * 1000;
    if (effectiveCostPer1k > policy.maxCostPer1kTokens) return "cost ceiling exceeded";
  }
  return undefined;
}

function preferredTierForTask(taskType: TaskType, complexity: "low" | "medium" | "high"): ModelTier[] {
  const map: Record<TaskType, Record<string, ModelTier[]>> = {
    ocr: { low: ["nano", "small"], medium: ["small", "mid"], high: ["mid", "frontier"] },
    document_classification: { low: ["nano", "small"], medium: ["small", "nano"], high: ["mid", "small"] },
    field_extraction: { low: ["small", "nano"], medium: ["mid", "small"], high: ["frontier", "mid"] },
    table_extraction: { low: ["small", "nano"], medium: ["mid", "small"], high: ["frontier", "mid"] },
    invoice_extraction: { low: ["small", "nano"], medium: ["mid", "small"], high: ["frontier", "mid"] },
    bank_statement_extraction: { low: ["mid", "small"], medium: ["mid", "frontier"], high: ["frontier", "mid"] },
    long_document_extraction: { low: ["mid", "small"], medium: ["frontier", "mid"], high: ["frontier", "mid"] },
    handwriting_extraction: { low: ["mid", "small"], medium: ["frontier", "mid"], high: ["frontier", "mid"] },
    validation: { low: ["nano", "small"], medium: ["small", "mid"], high: ["mid", "frontier"] },
    reconciliation: { low: ["small", "nano"], medium: ["mid", "small"], high: ["frontier", "mid"] },
    unknown: { low: ["small", "nano"], medium: ["mid", "small"], high: ["mid", "frontier"] },
  };
  return map[taskType][complexity] || map.unknown.medium;
}

function strategyWeights(strategy: RoutingStrategy) {
  return {
    cost: { cost: 0.82, quality: 0.12, latency: 0.06 },
    quality: { cost: 0.1, quality: 0.75, latency: 0.15 },
    latency: { cost: 0.15, quality: 0.2, latency: 0.65 },
    balanced: { cost: 0.35, quality: 0.45, latency: 0.2 },
  }[strategy];
}

function adjustedStrategyWeights(
  strategy: RoutingStrategy,
  taskType: TaskType,
  profile?: RouteRequest["document_profile"],
  difficulty?: ReturnType<typeof evaluateDocumentDifficultyV3>,
) {
  const base = { ...strategyWeights(strategy) };
  const isSimple = difficulty?.complexity === "low" && profile?.text_layer_quality === "good" && profile?.layout_complexity === "simple";
  const isHardFinancial = ["reconciliation", "bank_statement_extraction"].includes(taskType) || Boolean(profile?.requires_reconciliation);

  if (strategy === "balanced" && (["long_document_extraction"].includes(taskType) || difficulty?.complexity === "high")) {
    return normalizeWeights({ quality: base.quality + 0.12, cost: base.cost - 0.08, latency: base.latency - 0.04 });
  }
  if (strategy === "balanced" && (taskType === "invoice_extraction" || taskType === "field_extraction") && isSimple) {
    return normalizeWeights({ quality: base.quality - 0.1, cost: base.cost + 0.07, latency: base.latency + 0.03 });
  }
  if (isHardFinancial && base.quality < 0.25) {
    return normalizeWeights({ ...base, quality: 0.25, latency: strategy === "latency" ? Math.max(0.5, base.latency - 0.05) : base.latency });
  }
  return normalizeWeights(base);
}

function normalizeWeights(weights: { cost: number; quality: number; latency: number }) {
  const cost = Math.max(0.05, weights.cost);
  const quality = Math.max(0.05, weights.quality);
  const latency = Math.max(0.05, weights.latency);
  const total = cost + quality + latency;
  return { cost: cost / total, quality: quality / total, latency: latency / total };
}

function documentFitForModelV3(
  model: ModelSpec,
  taskType: TaskType,
  profile?: RouteRequest["document_profile"],
  difficulty?: ReturnType<typeof evaluateDocumentDifficultyV3>,
) {
  let qualityDelta = 0;
  let latencyDelta = 0;
  const reasons: string[] = [];
  const isVisionRequired = profile?.file_type === "image" || profile?.has_text_layer === false || ["none", "poor"].includes(profile?.text_layer_quality || "");
  const hasComplexTables = Boolean(profile?.has_tables && (profile.table_density || 0) >= 0.45) || ["table_heavy", "dense", "multi_column"].includes(profile?.layout_complexity || "");
  const isFinancial = Boolean(profile?.contains_financial_data || ["bank_statement", "invoice", "tax_form", "loan_document", "financial_report"].includes(profile?.document_type || ""));
  const isLong = (profile?.page_count || 0) >= 15 || taskType === "long_document_extraction";
  const isCleanSimple = profile?.text_layer_quality === "good" && profile?.image_quality === "high" && ["simple", "mixed"].includes(profile?.layout_complexity || "");

  applyTaskAffinity();

  if (isVisionRequired) {
    if (model.supportsVision) add(0.08, 0, "vision OCR required");
    else add(-0.2, 0, "no vision support for scanned/image input");
  }
  if (hasComplexTables && model.supportsStructuredOutput) add(0.05, 0, "structured output helps table extraction");
  if (profile?.requires_reconciliation || taskType === "reconciliation") {
    if (model.supportsStructuredOutput && model.supportsFunctionCalling) add(0.05, 0, "structured tool support helps reconciliation");
    else add(-0.08, 0, "limited reconciliation structure support");
  }
  if (isFinancial && model.supportsStructuredOutput) add(0.03, 0, "financial extraction needs strict structured fields");
  if (isLong) {
    if (model.contextWindow >= 200000) add(0.06, -0.02, "large context window fits long documents");
    else if (model.contextWindow < 128000) add(-0.08, 0, "context window is tighter for long documents");
  }
  if (profile?.image_quality === "low") {
    if (model.qualityScore >= 90) add(0.05, -0.02, "high base quality offsets poor scan quality");
    else add(-0.07, 0, "low image quality increases OCR risk");
  }
  if (profile?.known_layout_id || profile?.source_institution) {
    if (model.supportsStructuredOutput) add(0.04, -0.01, "known institution/layout profile needs precise structure");
    else add(-0.04, 0.02, "known layout may need stronger extraction");
  }
  if (isCleanSimple) {
    if (["nano", "small"].includes(model.tier)) add(0.04, 0.04, "clean simple document favors cheaper fast models");
    if (model.tier === "frontier") add(0, -0.02, "frontier model may be overkill for clean simple text");
  }
  if (difficulty?.complexity === "high" && ["nano", "small"].includes(model.tier)) add(-0.06, 0.02, "high difficulty penalizes small models");

  return {
    qualityDelta: Math.max(-0.16, Math.min(0.16, qualityDelta)),
    latencyDelta: Math.max(-0.08, Math.min(0.08, latencyDelta)),
    reasons: reasons.slice(0, 5),
  };

  function add(q: number, l: number, reason: string) {
    qualityDelta += q;
    latencyDelta += l;
    if (!reasons.includes(reason)) reasons.push(reason);
  }

  function applyTaskAffinity() {
    const affinities: Record<string, Partial<Record<TaskType | "receipt_extraction" | "simple_invoice" | "complex_invoice" | "scanned_ocr", number>>> = {
      "gemini-2.0-flash": { receipt_extraction: 0.08, simple_invoice: 0.07, scanned_ocr: 0.06, invoice_extraction: 0.03, bank_statement_extraction: -0.05, long_document_extraction: -0.04, reconciliation: -0.05 },
      "mistral-small-3.1": { receipt_extraction: 0.07, simple_invoice: 0.08, invoice_extraction: 0.05, field_extraction: 0.06, scanned_ocr: 0.02, bank_statement_extraction: -0.05, long_document_extraction: -0.05, reconciliation: -0.05 },
      "gpt-4o-mini": { receipt_extraction: 0.06, simple_invoice: 0.07, invoice_extraction: 0.04, field_extraction: 0.05, scanned_ocr: 0.05, bank_statement_extraction: -0.04 },
      "claude-haiku-4-5": { receipt_extraction: 0.04, simple_invoice: 0.04, field_extraction: 0.04, long_document_extraction: 0.02, bank_statement_extraction: -0.03 },
      "gpt-4o": { scanned_ocr: 0.08, complex_invoice: 0.06, invoice_extraction: 0.04, bank_statement_extraction: 0.06, table_extraction: 0.05, reconciliation: 0.05, long_document_extraction: 0.02 },
      "claude-sonnet-4-6": { complex_invoice: 0.07, bank_statement_extraction: 0.07, table_extraction: 0.06, reconciliation: 0.08, long_document_extraction: 0.07, validation: 0.07 },
      "gemini-2.5-pro": { scanned_ocr: 0.08, bank_statement_extraction: 0.09, table_extraction: 0.07, reconciliation: 0.07, long_document_extraction: 0.09, complex_invoice: 0.05 },
    };
    for (const key of affinityKeys()) {
      const delta = affinities[model.id]?.[key];
      if (!delta) continue;
      qualityDelta += delta;
      reasons.push(`task affinity ${key.replace(/_/g, " ")} ${delta > 0 ? "+" : ""}${delta.toFixed(2)}`);
    }
  }

  function affinityKeys(): Array<TaskType | "receipt_extraction" | "simple_invoice" | "complex_invoice" | "scanned_ocr"> {
    const keys: Array<TaskType | "receipt_extraction" | "simple_invoice" | "complex_invoice" | "scanned_ocr"> = [taskType];
    if (profile?.document_type === "receipt") keys.push("receipt_extraction");
    if (profile?.document_type === "invoice" && isCleanSimple && !hasComplexTables) keys.push("simple_invoice");
    if (profile?.document_type === "invoice" && (hasComplexTables || difficulty?.complexity === "high")) keys.push("complex_invoice");
    if (isVisionRequired) keys.push("scanned_ocr");
    return Array.from(new Set(keys));
  }
}

function costScoreFor(cost: number, minCost: number, maxCost: number) {
  if (maxCost <= minCost) return 0.99;
  const safeCost = Math.max(cost, 0.0000001);
  const safeMin = Math.max(minCost, 0.0000001);
  const safeMax = Math.max(maxCost, safeMin + 0.0000001);
  return clampScore(1 - Math.log(safeCost / safeMin) / Math.log(safeMax / safeMin));
}

function qualityScoreFor(catalogQuality: number, qualityDelta: number) {
  const calibratedBase = 0.35 + (catalogQuality / 100) * 0.55;
  return clampScore(calibratedBase + qualityDelta);
}

function clampScore(value: number) {
  return Math.min(0.99, Math.max(0.01, value));
}

function estimateTokens(text: string, profile?: RouteRequest["document_profile"]) {
  if (profile?.character_count) return Math.max(1, Math.ceil(profile.character_count / 4));
  const pageTokens = profile?.page_count ? profile.page_count * (profile.has_text_layer ? 650 : 1100) : 0;
  return Math.max(1, Math.ceil(text.length / 4), pageTokens);
}

function estimateOutputTokens(taskType: TaskType, difficultyScore = 0) {
  const map: Record<TaskType, number> = {
    ocr: 600,
    document_classification: 100,
    field_extraction: 500,
    table_extraction: 900,
    invoice_extraction: 800,
    bank_statement_extraction: 1200,
    long_document_extraction: 1600,
    handwriting_extraction: 900,
    validation: 250,
    reconciliation: 500,
    unknown: 300,
  };
  const difficultyMultiplier = difficultyScore >= 55 ? 1.35 : difficultyScore >= 25 ? 1.15 : 1;
  return Math.ceil(map[taskType] * difficultyMultiplier);
}

function costFor(model: ModelSpec, inputTokens: number, outputTokens: number) {
  return (inputTokens / 1000) * model.costPer1kInputTokens + (outputTokens / 1000) * model.costPer1kOutputTokens;
}

function buildReasoning(model: ModelSpec, fallback: ModelSpec | undefined, task: TaskType, policy: RoutingPolicy, score: ModelScore, difficulty?: ReturnType<typeof evaluateDocumentDifficultyV3>) {
  const strategy = policy.strategy || "balanced";
  const fallbackText = fallback ? ` Fallback: ${fallback.name}.` : "";
  const difficultyText = difficulty
    ? ` Document difficulty ${difficulty.score}/100 (${difficulty.complexity}) from ${difficulty.reasons.slice(0, 3).join("; ") || "base profile"}.`
    : "";
  return `V3 selected ${model.name} for ${task} using ${strategy} strategy. Estimated cost $${roundMoney(score.estimatedCostUsd)} and p50 latency ${model.avgLatencyMs}ms.${difficultyText}${fallbackText}`;
}

function mustFindModel(modelId: string) {
  const model = MODEL_CATALOG.find((candidate) => candidate.id === modelId);
  if (!model) throw new Error(`Model not found: ${modelId}`);
  return model;
}

function roundMoney(value: number) {
  return Math.round(value * 1000000) / 1000000;
}
