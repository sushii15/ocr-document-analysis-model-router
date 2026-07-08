import fs from "node:fs";
import path from "node:path";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { ModelTaskScore, RouterOutcome, RoutingDecision, TrajectoryState } from "../types.js";

export interface RouterStateSnapshot {
  decisions: RoutingDecision[];
  trajectories: TrajectoryState[];
  outcomes: RouterOutcome[];
  modelTaskScores: ModelTaskScore[];
}

export interface RouterStateStore {
  load(): RouterStateSnapshot;
  save(snapshot: RouterStateSnapshot): void;
}

export class MemoryRouterStateStore implements RouterStateStore {
  load(): RouterStateSnapshot {
    return { decisions: [], trajectories: [], outcomes: [], modelTaskScores: [] };
  }

  save(_snapshot: RouterStateSnapshot): void {
    // Intentionally empty for tests or ephemeral deployments.
  }
}

export class JsonFileRouterStateStore implements RouterStateStore {
  private readonly filePath: string;

  constructor(stateDir = process.env.ROUTER_STATE_DIR || path.join(process.cwd(), ".docrouter", "router-state")) {
    this.filePath = path.join(stateDir, "state.json");
  }

  load(): RouterStateSnapshot {
    try {
      if (!fs.existsSync(this.filePath)) return { decisions: [], trajectories: [], outcomes: [], modelTaskScores: [] };
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<RouterStateSnapshot>;
      return {
        decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
        trajectories: Array.isArray(parsed.trajectories) ? parsed.trajectories : [],
        outcomes: Array.isArray(parsed.outcomes) ? parsed.outcomes : [],
        modelTaskScores: Array.isArray(parsed.modelTaskScores) ? parsed.modelTaskScores : [],
      };
    } catch (error) {
      console.error(`Failed to load router state from ${this.filePath}:`, error);
      return { decisions: [], trajectories: [], outcomes: [], modelTaskScores: [] };
    }
  }

  save(snapshot: RouterStateSnapshot): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(snapshot, null, 2));
    fs.renameSync(tempPath, this.filePath);
  }
}

export class SupabaseMirrorRouterStateStore implements RouterStateStore {
  private readonly localStore: RouterStateStore;
  private readonly supabase: SupabaseClient;

  constructor(localStore: RouterStateStore, url: string, secretKey: string) {
    this.localStore = localStore;
    this.supabase = createClient(url, secretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  load(): RouterStateSnapshot {
    return this.localStore.load();
  }

  save(snapshot: RouterStateSnapshot): void {
    this.localStore.save(snapshot);
    void this.mirror(snapshot).catch((error) => {
      console.error("Failed to mirror router state to Supabase:", error);
    });
  }

  private async mirror(snapshot: RouterStateSnapshot) {
    if (snapshot.decisions.length) {
      const { error } = await this.supabase
        .from("llm_router_decisions")
        .upsert(snapshot.decisions.map(toDecisionRow), { onConflict: "id" });
      if (error) throw error;
    }

    if (snapshot.trajectories.length) {
      const { error } = await this.supabase
        .from("llm_router_trajectories")
        .upsert(snapshot.trajectories.map(toTrajectoryRow), { onConflict: "id" });
      if (error) throw error;
    }

    if (snapshot.outcomes.length) {
      const { error } = await this.supabase
        .from("llm_router_outcomes")
        .upsert(snapshot.outcomes.map(toOutcomeRow), { onConflict: "id" });
      if (error) throw error;
    }

    if (snapshot.modelTaskScores.length) {
      const { error } = await this.supabase
        .from("llm_router_model_task_scores")
        .upsert(snapshot.modelTaskScores.map(toModelTaskScoreRow), { onConflict: "model_id,task_type" });
      if (error) throw error;
    }
  }
}

function toOutcomeRow(outcome: RouterOutcome) {
  return {
    id: outcome.id,
    request_id: outcome.requestId,
    trajectory_id: outcome.trajectoryId || null,
    agent_id: outcome.agentId || null,
    model_id: outcome.modelId,
    task_type: outcome.taskType,
    success: outcome.success,
    validation_passed: outcome.validationPassed ?? null,
    needed_escalation: outcome.neededEscalation,
    quality_score: outcome.qualityScore ?? null,
    actual_cost_usd: outcome.actualCostUsd ?? null,
    actual_latency_ms: outcome.actualLatencyMs ?? null,
    error_type: outcome.errorType || null,
    evaluator_type: outcome.evaluatorType,
    evaluator_model_id: outcome.evaluatorModelId || null,
    notes: outcome.notes || null,
    metadata: outcome.metadata || {},
    created_at: outcome.timestamp,
  };
}

function toModelTaskScoreRow(score: ModelTaskScore) {
  return {
    model_id: score.modelId,
    task_type: score.taskType,
    sample_count: score.sampleCount,
    success_count: score.successCount,
    failure_count: score.failureCount,
    success_rate: score.successRate,
    avg_quality_score: score.avgQualityScore,
    avg_cost_usd: score.avgCostUsd,
    avg_latency_ms: score.avgLatencyMs,
    escalation_rate: score.escalationRate,
    learned_score: score.learnedScore,
    last_outcome_at: score.lastOutcomeAt || null,
    updated_at: score.updatedAt,
  };
}

export function createRouterStateStore(): RouterStateStore {
  if (process.env.ROUTER_PERSISTENCE === "memory") return new MemoryRouterStateStore();
  const localStore = new JsonFileRouterStateStore();
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseSecret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (supabaseUrl && supabaseSecret) return new SupabaseMirrorRouterStateStore(localStore, supabaseUrl, supabaseSecret);
  return localStore;
}

function toDecisionRow(decision: RoutingDecision) {
  return {
    id: decision.requestId,
    trajectory_id: decision.trajectoryId || null,
    agent_id: decision.agentId || null,
    step_type: decision.stepType || null,
    detected_task_type: decision.detectedTaskType,
    selected_model_id: decision.selectedModel.id,
    selected_model_provider: decision.selectedModel.provider,
    selected_model_tier: decision.selectedModel.tier,
    fallback_model_id: decision.fallbackModel?.id || null,
    estimated_cost_usd: decision.estimatedCostUsd,
    estimated_latency_ms: decision.estimatedLatencyMs,
    classification_confidence: decision.classificationConfidence,
    policy_applied: decision.policyApplied,
    model_scores: decision.modelScores,
    alternatives_considered: decision.alternativesConsidered,
    reasoning: decision.reasoning,
    raw_decision: decision,
    created_at: decision.timestamp,
  };
}

function toTrajectoryRow(trajectory: TrajectoryState) {
  return {
    id: trajectory.trajectoryId,
    agent_id: trajectory.agentId || null,
    start_model_id: trajectory.startModel,
    current_model_id: trajectory.currentModel,
    step_count: trajectory.stepCount,
    total_cost_usd: trajectory.totalCostUsd,
    budget_remaining_usd: trajectory.budgetRemainingUsd ?? null,
    step_history: trajectory.stepHistory,
    started_at: trajectory.startedAt,
    last_updated_at: trajectory.lastUpdatedAt,
  };
}
