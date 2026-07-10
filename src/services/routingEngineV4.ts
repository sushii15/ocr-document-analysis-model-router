import { randomUUID } from "node:crypto";
import { benchmarkPriorForModelV4, BENCHMARK_SOURCES_V4 } from "./benchmarkPriorsV4.js";
import { MODEL_CATALOG } from "./modelCatalog.js";
import { routeV3 } from "./routingEngineV3.js";
import { ModelScore, RouteRequest, RoutingDecision, RoutingStrategy } from "../types.js";

const STATIC_SCORE_MAX = 1.08;

export function routeV4(req: RouteRequest): RoutingDecision {
  const base = routeV3(req);
  const strategy = base.policyApplied.strategy || "balanced";
  const adjustedScores = base.modelScores.map((score) => applyBenchmarkPrior(score, base, strategy));
  const sortedScores = adjustedScores.sort((a, b) => compareScoresV4(a, b, strategy));
  const eligible = sortedScores.filter((score) => !score.filteredReason);
  if (!eligible.length) throw new Error("No eligible V4 model found after benchmark prior scoring.");

  const selectedScore = eligible[0];
  const fallbackScore = eligible[1];
  const selectedModel = mustFindModel(selectedScore.modelId);
  const fallbackModel = fallbackScore ? mustFindModel(fallbackScore.modelId) : undefined;

  return {
    ...base,
    requestId: randomUUID(),
    selectedModel,
    fallbackModel,
    modelScores: sortedScores,
    estimatedCostUsd: roundMoney(selectedScore.estimatedCostUsd),
    estimatedLatencyMs: selectedModel.avgLatencyMs,
    alternativesConsidered: eligible.slice(1, 5).map((score) => score.modelId),
    reasoning: buildReasoning(base, selectedScore, strategy),
  };
}

function applyBenchmarkPrior(score: ModelScore, decision: RoutingDecision, strategy: RoutingStrategy): ModelScore {
  if (score.filteredReason) return score;
  const model = mustFindModel(score.modelId);
  const prior = benchmarkPriorForModelV4(model, decision.detectedTaskType, decision.documentProfile, decision.documentDifficulty);
  const qualityScore = calibratedQualityScore(score.qualityScore, prior.score, model);
  const staticScore = qualityScore * (decision.appliedWeights?.quality || 0.45)
    + score.costScore * (decision.appliedWeights?.cost || 0.35)
    + score.latencyScore * (decision.appliedWeights?.latency || 0.2)
    + (score.tierBonus || 0);
  return {
    ...score,
    qualityScore,
    documentFitScore: (score.documentFitScore || 0) + prior.score,
    documentFitReasons: [...(score.documentFitReasons || []), ...prior.reasons].slice(0, 8),
    staticScore,
    learnedScore: scoreForStrategy(strategy, score.costScore, qualityScore, score.latencyScore, staticScore),
    score: scoreForStrategy(strategy, score.costScore, qualityScore, score.latencyScore, staticScore),
    benchmarkPriorScore: prior.score,
    benchmarkPriorConfidence: prior.confidence,
    benchmarkPriorReasons: prior.reasons,
    benchmarkPriorSources: prior.sources,
    benchmarkCategories: prior.categories,
  };
}

function scoreForStrategy(strategy: RoutingStrategy, costScore: number, qualityScore: number, latencyScore: number, staticScore: number) {
  if (strategy === "quality") return qualityScore;
  if (strategy === "cost") return costScore;
  if (strategy === "latency") return latencyScore;
  return clamp(staticScore / STATIC_SCORE_MAX);
}

function compareScoresV4(a: ModelScore, b: ModelScore, strategy: RoutingStrategy) {
  const scoreDelta = b.score - a.score;
  if (scoreDelta !== 0) return scoreDelta;
  if (strategy === "quality") return b.qualityScore - a.qualityScore || a.estimatedCostUsd - b.estimatedCostUsd;
  if (strategy === "latency") return b.latencyScore - a.latencyScore || b.qualityScore - a.qualityScore || a.estimatedCostUsd - b.estimatedCostUsd;
  if (strategy === "cost") return b.costScore - a.costScore || b.qualityScore - a.qualityScore || b.latencyScore - a.latencyScore;
  return a.estimatedCostUsd - b.estimatedCostUsd || b.qualityScore - a.qualityScore || b.latencyScore - a.latencyScore;
}

function buildReasoning(decision: RoutingDecision, selectedScore: ModelScore, strategy: RoutingStrategy) {
  const sourceNames = BENCHMARK_SOURCES_V4
    .filter((source) => selectedScore.benchmarkPriorSources?.includes(source.id))
    .map((source) => source.name)
    .join(", ");
  const priorText = selectedScore.benchmarkPriorReasons?.slice(0, 2).join("; ") || "no additional benchmark adjustment";
  return `V4 selected ${mustFindModel(selectedScore.modelId).name} using ${strategy} strategy after V3 scoring plus benchmark-backed document/task priors. Sources: ${sourceNames || "MMR-Bench, MMDocBench, CC-OCR V2"}. Prior signal: ${priorText}.`;
}

function mustFindModel(modelId: string) {
  const model = MODEL_CATALOG.find((candidate) => candidate.id === modelId);
  if (!model) throw new Error(`Model not found: ${modelId}`);
  return model;
}

function clamp(value: number) {
  return Math.min(0.99, Math.max(0.025, value));
}

function calibratedQualityScore(v3QualityScore: number, benchmarkPriorScore: number, model: ReturnType<typeof mustFindModel>) {
  const catalogCeiling = 0.55 + (model.qualityScore / 100) * 0.42;
  const capabilityCeiling = catalogCeiling
    + (model.supportsVision ? 0.018 : -0.035)
    + (model.supportsStructuredOutput ? 0.012 : -0.015);
  const adjusted = v3QualityScore + benchmarkPriorScore * 0.38;
  return clamp(Math.min(adjusted, capabilityCeiling));
}

function roundMoney(value: number) {
  return Math.round(value * 1000000) / 1000000;
}
