import { ExecuteRequest, ExecuteResult } from "../types.js";
import { executeWithProvider } from "./providerAdapters.js";
import { recordOutcome, route } from "./routingEngine.js";

export async function executeRequest(request: ExecuteRequest): Promise<ExecuteResult> {
  const decision = route(request);
  const execution = await executeWithProvider(decision, request);

  if (request.record_outcome) {
    recordOutcome({
      request_id: decision.requestId,
      success: !execution.dryRun,
      validation_passed: !execution.dryRun,
      needed_escalation: execution.finishReason === "fallback_required",
      quality_score: execution.dryRun ? 0.5 : undefined,
      actual_cost_usd: execution.actualCostUsd ?? decision.estimatedCostUsd,
      actual_latency_ms: execution.actualLatencyMs,
      error_type: execution.dryRun ? "dry_run" : undefined,
      evaluator_type: execution.dryRun ? "test" : "validator",
      notes: execution.dryRun
        ? "Dry-run execution recorded for local integration testing."
        : "Provider execution completed; replace with task-specific eval for production quality scoring.",
    });
  }

  return { decision, execution };
}
