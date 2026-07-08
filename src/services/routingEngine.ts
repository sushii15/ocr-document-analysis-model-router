import { randomUUID } from "node:crypto";
import { evaluateDocumentDifficulty } from "./documentProfile.js";
import { hasCompliance, MODEL_CATALOG } from "./modelCatalog.js";
import { createRouterStateStore } from "./persistence.js";
import {
  ModelScore,
  ModelSpec,
  ModelTaskScore,
  ModelTier,
  OutcomeInput,
  RouterOutcome,
  RouteRequest,
  RoutingDecision,
  RoutingPolicy,
  RoutingStrategy,
  TaskType,
  TrajectoryState,
} from "../types.js";

const DEFAULT_POLICY: RoutingPolicy = {
  strategy: "balanced",
  allowSelfHosted: true,
};

const maxDecisionLog = Number(process.env.MAX_DECISIONS_LOG || 10000);
const stateStore = createRouterStateStore();
const initialState = stateStore.load();
const decisionLog: RoutingDecision[] = initialState.decisions.slice(-maxDecisionLog);
const trajectoryStore = new Map<string, TrajectoryState>(
  initialState.trajectories.map((trajectory) => [trajectory.trajectoryId, trajectory]),
);
const outcomeLog: RouterOutcome[] = initialState.outcomes || [];
const modelTaskScoreStore = new Map<string, ModelTaskScore>(
  (initialState.modelTaskScores || []).map((score) => [scoreKey(score.modelId, score.taskType), score]),
);

export function route(req: RouteRequest): RoutingDecision {
  const timestamp = new Date().toISOString();
  const documentDifficulty = evaluateDocumentDifficulty(req.prompt, req.document_profile, req.task_type, req.step_type);
  const inputTokens = req.estimated_input_tokens ?? estimateTokens(req.prompt, req.document_profile);
  const classification = req.task_type
    ? { taskType: req.task_type, confidence: 1, complexity: documentDifficulty.complexity }
    : classifyTask(req.prompt, req.step_type, documentDifficulty);
  const outputTokens = req.estimated_output_tokens ?? estimateOutputTokens(classification.taskType, documentDifficulty.score);
  const policy = normalizePolicy(req.policy);
  const trajectory = req.trajectory_id ? trajectoryStore.get(req.trajectory_id) : undefined;
  const preferredTiers = preferredTierForTask(classification.taskType, classification.complexity, trajectory);
  const scored = scoreModels(MODEL_CATALOG, policy, inputTokens, outputTokens, preferredTiers, classification.taskType);
  const eligible = scored.filter((score) => !score.filteredReason).sort((a, b) => b.score - a.score);

  if (!eligible.length) {
    throw new Error("No eligible model found for this request. Relax policy filters or inspect router_list_models.");
  }

  const selectedScore = eligible[0];
  const fallbackScore = eligible[1];
  const selectedModel = mustFindModel(selectedScore.modelId);
  const fallbackModel = fallbackScore ? mustFindModel(fallbackScore.modelId) : undefined;
  const decision: RoutingDecision = {
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
    modelScores: scored.sort((a, b) => b.score - a.score),
    estimatedInputTokens: inputTokens,
    estimatedOutputTokens: outputTokens,
    estimatedCostUsd: roundMoney(selectedScore.estimatedCostUsd),
    estimatedLatencyMs: selectedModel.avgLatencyMs,
    reasoning: buildReasoning(selectedModel, fallbackModel, classification.taskType, policy, selectedScore, documentDifficulty),
    alternativesConsidered: eligible.slice(1, 5).map((score) => score.modelId),
    documentProfile: req.document_profile,
    documentDifficulty,
  };

  if (req.trajectory_id) {
    upsertTrajectory(req.trajectory_id, decision, req.agent_id, req.step_type || classification.taskType);
  }
  pushDecision(decision);
  persistState();
  return decision;
}

export function classifyTask(prompt: string, stepType?: string, documentDifficulty = evaluateDocumentDifficulty(prompt, undefined, undefined, stepType)): { taskType: TaskType; confidence: number; complexity: "low" | "medium" | "high" } {
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
    if (regex.test(text)) return { taskType: documentDifficulty.recommendedTaskType !== "unknown" ? documentDifficulty.recommendedTaskType : taskType, confidence, complexity: documentDifficulty.complexity };
  }
  return { taskType: documentDifficulty.recommendedTaskType, confidence: 0.45, complexity: documentDifficulty.complexity };
}

export function scoreModels(
  models: ModelSpec[],
  policy: RoutingPolicy,
  inputTokens: number,
  outputTokens: number,
  preferredTiers: ModelTier[],
  taskType: TaskType = "unknown",
): ModelScore[] {
  const weights = strategyWeights(policy.strategy || "balanced");
  const maxCost = Math.max(...models.map((model) => costFor(model, inputTokens, outputTokens)));
  const maxLatency = Math.max(...models.map((model) => model.avgLatencyMs));

  return models.map((model) => {
    const filteredReason = filterReason(model, policy);
    const estimatedCostUsd = costFor(model, inputTokens, outputTokens);
    const costScore = 1 - estimatedCostUsd / maxCost;
    const qualityScore = model.qualityScore / 100;
    const latencyScore = 1 - model.avgLatencyMs / maxLatency;
    const tierBonus = preferredTiers.includes(model.tier) ? 0.12 - preferredTiers.indexOf(model.tier) * 0.03 : 0;
    const learned = modelTaskScoreStore.get(scoreKey(model.id, taskType));
    const learnedBlend = learned ? learnedBlendWeight(learned.sampleCount) : 0;
    const staticScore = costScore * weights.cost + qualityScore * weights.quality + latencyScore * weights.latency + tierBonus;
    const learnedScore = learned?.learnedScore ?? staticScore;
    const score = filteredReason
      ? -1
      : staticScore * (1 - learnedBlend) + learnedScore * learnedBlend;

    return {
      modelId: model.id,
      score,
      costScore,
      qualityScore,
      latencyScore,
      tierBonus,
      staticScore,
      learnedScore,
      learnedBlend,
      estimatedCostUsd,
      filteredReason,
    };
  });
}

export function estimateCost(prompt: string, estimatedOutputTokens = 300) {
  const inputTokens = estimateTokens(prompt);
  const rows = MODEL_CATALOG
    .map((model) => ({
      model,
      estimated_cost_usd: roundMoney(costFor(model, inputTokens, estimatedOutputTokens)),
    }))
    .sort((a, b) => a.estimated_cost_usd - b.estimated_cost_usd);
  const frontier = rows.find((row) => row.model.tier === "frontier") || rows[rows.length - 1];
  const cheapest = rows[0];
  return {
    input_tokens: inputTokens,
    output_tokens: estimatedOutputTokens,
    rows,
    summary: {
      cheapest_model: cheapest.model.id,
      frontier_baseline_model: frontier.model.id,
      savings_routing_vs_frontier_usd: roundMoney(frontier.estimated_cost_usd - cheapest.estimated_cost_usd),
    },
  };
}

export function getTrajectory(trajectoryId: string) {
  return trajectoryStore.get(trajectoryId);
}

export function getStats({ limit = 100, since_minutes }: { limit?: number; since_minutes?: number } = {}) {
  const cutoff = since_minutes ? Date.now() - since_minutes * 60 * 1000 : 0;
  const decisions = decisionLog
    .filter((decision) => new Date(decision.timestamp).getTime() >= cutoff)
    .slice(-Math.min(limit, 1000));
  const allFrontier = decisions.reduce((sum, decision) => {
    const frontier = cheapestFrontier(decision);
    return sum + (frontier ? frontier.estimatedCostUsd : decision.estimatedCostUsd);
  }, 0);
  const total = decisions.reduce((sum, decision) => sum + decision.estimatedCostUsd, 0);

  return {
    total_requests: decisions.length,
    cost: {
      total_cost_usd: roundMoney(total),
      all_frontier_baseline_usd: roundMoney(allFrontier),
      estimated_savings_usd: roundMoney(allFrontier - total),
      savings_pct: allFrontier ? Math.round(((allFrontier - total) / allFrontier) * 100) : 0,
    },
    by_model: countBy(decisions, (decision) => decision.selectedModel.id),
    by_tier: countBy(decisions, (decision) => decision.selectedModel.tier),
    by_task_type: countBy(decisions, (decision) => decision.detectedTaskType),
    learning: getLearningStats(),
    active_trajectories: trajectoryStore.size,
  };
}

export function recordOutcome(input: OutcomeInput) {
  const decision = decisionLog.find((candidate) => candidate.requestId === input.request_id);
  if (!decision) throw new Error(`Decision not found for request_id=${input.request_id}`);

  const timestamp = new Date().toISOString();
  const outcome: RouterOutcome = {
    id: randomUUID(),
    requestId: input.request_id,
    timestamp,
    trajectoryId: decision.trajectoryId,
    agentId: decision.agentId,
    modelId: decision.selectedModel.id,
    taskType: decision.detectedTaskType,
    success: input.success,
    validationPassed: input.validation_passed,
    neededEscalation: input.needed_escalation ?? false,
    qualityScore: clamp01(input.quality_score),
    actualCostUsd: input.actual_cost_usd,
    actualLatencyMs: input.actual_latency_ms,
    errorType: input.error_type,
    evaluatorType: input.evaluator_type || "rule",
    evaluatorModelId: input.evaluator_model_id,
    notes: input.notes,
    metadata: input.metadata || {},
  };

  outcomeLog.push(outcome);
  upsertModelTaskScore(outcome);
  persistState();
  return {
    outcome,
    modelTaskScore: modelTaskScoreStore.get(scoreKey(outcome.modelId, outcome.taskType)),
  };
}

export function getLearnedScores({ task_type, model_id }: { task_type?: TaskType; model_id?: string } = {}) {
  return Array.from(modelTaskScoreStore.values())
    .filter((score) => !task_type || score.taskType === task_type)
    .filter((score) => !model_id || score.modelId === model_id)
    .sort((a, b) => b.learnedScore - a.learnedScore || b.sampleCount - a.sampleCount);
}

function normalizePolicy(policy?: RoutingPolicy): RoutingPolicy {
  return { ...DEFAULT_POLICY, ...(policy || {}) };
}

function filterReason(model: ModelSpec, policy: RoutingPolicy) {
  if (policy.allowedModels && !policy.allowedModels.includes(model.id)) return "model not enabled by user";
  if (policy.forceTier && model.tier !== policy.forceTier) return `forceTier=${policy.forceTier}`;
  if (policy.allowedTiers && !policy.allowedTiers.includes(model.tier)) return `tier ${model.tier} not allowed`;
  if (policy.allowedProviders && !policy.allowedProviders.includes(model.provider)) return `provider ${model.provider} not allowed`;
  if (policy.allowSelfHosted === false && model.hosting === "self-hosted") return "self-hosted disabled";
  if (policy.requiredCompliance && !hasCompliance(model, policy.requiredCompliance)) return "missing compliance tag";
  if (policy.maxLatencyMs && model.avgLatencyMs > policy.maxLatencyMs) return "latency ceiling exceeded";
  if (policy.minQualityScore && model.qualityScore < policy.minQualityScore) return "quality floor not met";
  if (policy.maxCostPer1kTokens && model.costPer1kInputTokens + model.costPer1kOutputTokens > policy.maxCostPer1kTokens) return "cost ceiling exceeded";
  return undefined;
}

function preferredTierForTask(taskType: TaskType, complexity: "low" | "medium" | "high", trajectory?: TrajectoryState): ModelTier[] {
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
  const preferred = map[taskType][complexity] || map.unknown.medium;
  if (!trajectory || ["long_document_extraction", "reconciliation"].includes(taskType)) return preferred;
  return preferred;
}

function strategyWeights(strategy: RoutingStrategy) {
  return {
    cost: { cost: 0.7, quality: 0.2, latency: 0.1 },
    quality: { cost: 0.1, quality: 0.75, latency: 0.15 },
    latency: { cost: 0.15, quality: 0.2, latency: 0.65 },
    balanced: { cost: 0.35, quality: 0.45, latency: 0.2 },
  }[strategy];
}

function upsertTrajectory(trajectoryId: string, decision: RoutingDecision, agentId: string | undefined, stepType: string) {
  const existing = trajectoryStore.get(trajectoryId);
  if (!existing) {
    trajectoryStore.set(trajectoryId, {
      trajectoryId,
      agentId,
      startModel: decision.selectedModel.id,
      currentModel: decision.selectedModel.id,
      stepCount: 1,
      totalCostUsd: decision.estimatedCostUsd,
      stepHistory: [{ step: 1, stepType, modelId: decision.selectedModel.id, costUsd: decision.estimatedCostUsd, latencyMs: decision.estimatedLatencyMs }],
      startedAt: decision.timestamp,
      lastUpdatedAt: decision.timestamp,
    });
    return;
  }

  existing.currentModel = decision.selectedModel.id;
  existing.stepCount += 1;
  existing.totalCostUsd = roundMoney(existing.totalCostUsd + decision.estimatedCostUsd);
  existing.stepHistory.push({ step: existing.stepCount, stepType, modelId: decision.selectedModel.id, costUsd: decision.estimatedCostUsd, latencyMs: decision.estimatedLatencyMs });
  existing.lastUpdatedAt = decision.timestamp;
}

function pushDecision(decision: RoutingDecision) {
  decisionLog.push(decision);
  if (decisionLog.length > maxDecisionLog) decisionLog.shift();
}

function persistState() {
  stateStore.save({
    decisions: decisionLog,
    trajectories: Array.from(trajectoryStore.values()),
    outcomes: outcomeLog,
    modelTaskScores: Array.from(modelTaskScoreStore.values()),
  });
}

function upsertModelTaskScore(outcome: RouterOutcome) {
  const key = scoreKey(outcome.modelId, outcome.taskType);
  const existing = modelTaskScoreStore.get(key);
  const sampleCount = (existing?.sampleCount || 0) + 1;
  const successCount = (existing?.successCount || 0) + (outcome.success ? 1 : 0);
  const failureCount = sampleCount - successCount;
  const quality = outcome.qualityScore ?? (outcome.success ? 1 : 0);
  const cost = outcome.actualCostUsd ?? 0;
  const latency = outcome.actualLatencyMs ?? 0;
  const escalation = outcome.neededEscalation ? 1 : 0;

  const avgQualityScore = rollingAverage(existing?.avgQualityScore || 0, quality, sampleCount);
  const avgCostUsd = rollingAverage(existing?.avgCostUsd || 0, cost, sampleCount);
  const avgLatencyMs = rollingAverage(existing?.avgLatencyMs || 0, latency, sampleCount);
  const escalationRate = rollingAverage(existing?.escalationRate || 0, escalation, sampleCount);
  const successRate = round4(successCount / sampleCount);
  const learnedScore = round4(
    successRate * 0.5 +
      avgQualityScore * 0.3 +
      (1 - Math.min(escalationRate, 1)) * 0.15 +
      (outcome.success ? 0.05 : 0),
  );

  modelTaskScoreStore.set(key, {
    modelId: outcome.modelId,
    taskType: outcome.taskType,
    sampleCount,
    successCount,
    failureCount,
    successRate,
    avgQualityScore: round4(avgQualityScore),
    avgCostUsd: roundMoney(avgCostUsd),
    avgLatencyMs: Math.round(avgLatencyMs),
    escalationRate: round4(escalationRate),
    learnedScore,
    lastOutcomeAt: outcome.timestamp,
    updatedAt: outcome.timestamp,
  });
}

function getLearningStats() {
  const scores = Array.from(modelTaskScoreStore.values());
  const samples = scores.reduce((sum, score) => sum + score.sampleCount, 0);
  return {
    total_outcomes: outcomeLog.length,
    scored_model_tasks: scores.length,
    total_samples: samples,
    top_scores: scores
      .sort((a, b) => b.learnedScore - a.learnedScore || b.sampleCount - a.sampleCount)
      .slice(0, 5),
  };
}

function learnedBlendWeight(sampleCount: number) {
  if (sampleCount < 20) return 0.1;
  if (sampleCount < 100) return 0.35;
  return 0.6;
}

function scoreKey(modelId: string, taskType: TaskType) {
  return `${modelId}::${taskType}`;
}

function rollingAverage(currentAverage: number, nextValue: number, sampleCount: number) {
  return ((currentAverage * (sampleCount - 1)) + nextValue) / sampleCount;
}

function clamp01(value?: number) {
  if (value === undefined) return undefined;
  return Math.min(1, Math.max(0, value));
}

function round4(value: number) {
  return Math.round(value * 10000) / 10000;
}

function buildReasoning(model: ModelSpec, fallback: ModelSpec | undefined, task: TaskType, policy: RoutingPolicy, score: ModelScore, difficulty?: ReturnType<typeof evaluateDocumentDifficulty>) {
  const strategy = policy.strategy || "balanced";
  const fallbackText = fallback ? ` Fallback: ${fallback.name}.` : "";
  const difficultyText = difficulty
    ? ` Document difficulty ${difficulty.score}/100 (${difficulty.complexity}) from ${difficulty.reasons.slice(0, 3).join("; ") || "base profile"}.`
    : "";
  return `Selected ${model.name} for ${task} using ${strategy} strategy. Estimated cost $${roundMoney(score.estimatedCostUsd)} and p50 latency ${model.avgLatencyMs}ms.${difficultyText}${fallbackText}`;
}

function mustFindModel(modelId: string) {
  const model = MODEL_CATALOG.find((candidate) => candidate.id === modelId);
  if (!model) throw new Error(`Model not found: ${modelId}`);
  return model;
}

function cheapestFrontier(decision: RoutingDecision) {
  return decision.modelScores
    .filter((score) => mustFindModel(score.modelId).tier === "frontier" && !score.filteredReason)
    .sort((a, b) => a.estimatedCostUsd - b.estimatedCostUsd)[0];
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

function countBy<T>(items: T[], getKey: (item: T) => string) {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = getKey(item);
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count);
}

function roundMoney(value: number) {
  return Math.round(value * 1000000) / 1000000;
}
