import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { executeRequest } from "../services/executionEngine.js";
import { listModels } from "../services/modelCatalog.js";
import { estimateCost, getLearnedScores, getStats, getTrajectory, recordOutcome, route } from "../services/routingEngine.js";
import { evaluateExtraction, logV2Event } from "../services/v2Learning.js";
import { ModelProvider, ModelSpec, ModelTier, RoutingPolicy, TaskType } from "../types.js";

const ModelTierSchema = z.enum(["nano", "small", "mid", "frontier"]);
const ProviderSchema = z.enum(["anthropic", "openai", "google", "mistral", "meta", "qwen", "deepseek"]);
const TaskTypeSchema = z.enum([
  "ocr",
  "document_classification",
  "field_extraction",
  "table_extraction",
  "invoice_extraction",
  "bank_statement_extraction",
  "long_document_extraction",
  "handwriting_extraction",
  "validation",
  "reconciliation",
  "unknown",
]);
const RoutingPolicySchema = z.object({
  strategy: z.enum(["cost", "quality", "latency", "balanced"]).optional(),
  maxCostPer1kTokens: z.number().positive().optional(),
  maxLatencyMs: z.number().positive().optional(),
  minQualityScore: z.number().min(0).max(100).optional(),
  requiredCompliance: z.array(z.string()).optional(),
  allowedModels: z.array(z.string()).optional(),
  allowedTiers: z.array(ModelTierSchema).optional(),
  allowedProviders: z.array(ProviderSchema).optional(),
  allowSelfHosted: z.boolean().optional(),
  forceTier: ModelTierSchema.optional(),
}).strict();
const DocumentProfileSchema = z.object({
  file_type: z.enum(["pdf", "image", "tiff", "unknown"]).optional(),
  page_count: z.number().int().positive().optional(),
  character_count: z.number().int().nonnegative().optional(),
  has_text_layer: z.boolean().optional(),
  text_layer_quality: z.enum(["good", "partial", "poor", "none", "unknown"]).optional(),
  document_type: z.enum(["invoice", "bank_statement", "receipt", "tax_form", "contract", "loan_document", "financial_report", "unknown"]).optional(),
  source_institution: z.string().optional(),
  known_layout_id: z.string().optional(),
  image_quality: z.enum(["high", "medium", "low", "unknown"]).optional(),
  layout_complexity: z.enum(["simple", "mixed", "table_heavy", "dense", "multi_column", "unknown"]).optional(),
  has_tables: z.boolean().optional(),
  table_count: z.number().int().nonnegative().optional(),
  table_density: z.number().min(0).max(1).optional(),
  has_handwriting: z.boolean().optional(),
  language: z.string().optional(),
  requires_reconciliation: z.boolean().optional(),
  contains_financial_data: z.boolean().optional(),
  target_schema: z.string().optional(),
  prior_validation_failed: z.boolean().optional(),
  confidence: z.number().min(0).max(1).optional(),
}).strict();
const OutcomeInputSchema = {
  request_id: z.string().min(1),
  success: z.boolean(),
  validation_passed: z.boolean().optional(),
  needed_escalation: z.boolean().optional(),
  quality_score: z.number().min(0).max(1).optional(),
  actual_cost_usd: z.number().min(0).optional(),
  actual_latency_ms: z.number().int().min(0).optional(),
  error_type: z.string().optional(),
  evaluator_type: z.enum(["rule", "llm_judge", "human", "test", "validator"]).optional(),
  evaluator_model_id: z.string().optional(),
  notes: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
};

export function registerRoutingTools(server: McpServer) {
  server.registerTool(
    "router_route_request",
    {
      title: "Route LLM request",
      description: "Call before OCR, PDF parsing, document extraction, validation, or reconciliation. Returns the optimal model, fallback, estimated cost, and reasoning.",
      inputSchema: {
        prompt: z.string().min(1).max(100000),
        task_type: TaskTypeSchema.optional(),
        step_type: z.string().optional(),
        trajectory_id: z.string().optional(),
        agent_id: z.string().optional(),
        estimated_input_tokens: z.number().int().positive().optional(),
        estimated_output_tokens: z.number().int().positive().optional(),
        document_profile: DocumentProfileSchema.optional(),
        policy: RoutingPolicySchema.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (params) => respond(() => formatDecision(route({
      prompt: params.prompt,
      task_type: params.task_type as TaskType | undefined,
      step_type: params.step_type,
      trajectory_id: params.trajectory_id,
      agent_id: params.agent_id,
      estimated_input_tokens: params.estimated_input_tokens,
      estimated_output_tokens: params.estimated_output_tokens,
      document_profile: params.document_profile,
      policy: params.policy as RoutingPolicy | undefined,
    }))),
  );

  server.registerTool(
    "router_list_models",
    {
      title: "List routable models",
      description: "Browse the model catalog with pricing, capabilities, compliance, and filters.",
      inputSchema: {
        tier_filter: ModelTierSchema.optional(),
        provider_filter: ProviderSchema.optional(),
        open_weight_only: z.boolean().optional(),
        compliance_required: z.array(z.string()).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (params) => respond(() => {
      const models = listModels({
        tier_filter: params.tier_filter as ModelTier | undefined,
        provider_filter: params.provider_filter as ModelProvider | undefined,
        open_weight_only: params.open_weight_only,
        compliance_required: params.compliance_required,
      });
      return { count: models.length, models: models.map(formatModel) };
  }),
);

  server.registerTool(
    "router_execute_request",
    {
      title: "Route and execute LLM request",
      description: "Routes a document OCR/extraction prompt, calls the selected provider when credentials are configured, and returns dry-run output otherwise.",
      inputSchema: {
        prompt: z.string().min(1).max(100000),
        system_prompt: z.string().optional(),
        task_type: TaskTypeSchema.optional(),
        step_type: z.string().optional(),
        trajectory_id: z.string().optional(),
        agent_id: z.string().optional(),
        estimated_input_tokens: z.number().int().positive().optional(),
        estimated_output_tokens: z.number().int().positive().optional(),
        document_profile: DocumentProfileSchema.optional(),
        temperature: z.number().min(0).max(2).optional(),
        max_output_tokens: z.number().int().positive().optional(),
        dry_run: z.boolean().optional(),
        record_outcome: z.boolean().optional(),
        policy: RoutingPolicySchema.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => respond(async () => {
      const result = await executeRequest({
        prompt: params.prompt,
        system_prompt: params.system_prompt,
        task_type: params.task_type as TaskType | undefined,
        step_type: params.step_type,
        trajectory_id: params.trajectory_id,
        agent_id: params.agent_id,
        estimated_input_tokens: params.estimated_input_tokens,
        estimated_output_tokens: params.estimated_output_tokens,
        document_profile: params.document_profile,
        temperature: params.temperature,
        max_output_tokens: params.max_output_tokens,
        dry_run: params.dry_run,
        record_outcome: params.record_outcome,
        policy: params.policy as RoutingPolicy | undefined,
      });
      return {
        decision: formatDecision(result.decision),
        execution: {
          provider: result.execution.provider,
          model_id: result.execution.modelId,
          output_text: result.execution.outputText,
          input_tokens: result.execution.inputTokens,
          output_tokens: result.execution.outputTokens,
          actual_cost_usd: result.execution.actualCostUsd,
          actual_latency_ms: result.execution.actualLatencyMs,
          dry_run: result.execution.dryRun,
          finish_reason: result.execution.finishReason,
        },
      };
    }),
  );

  server.registerTool(
    "router_get_trajectory",
    {
      title: "Get trajectory state",
      description: "Returns spend and step history for a multi-step agent trajectory.",
      inputSchema: { trajectory_id: z.string().min(1) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ trajectory_id }) => respond(() => {
      const trajectory = getTrajectory(trajectory_id);
      if (!trajectory) throw new Error(`Trajectory not found: ${trajectory_id}`);
      return trajectory;
    }),
  );

  server.registerTool(
    "router_get_stats",
    {
      title: "Get routing statistics",
      description: "Aggregate routing stats, cost, savings vs all-frontier baseline, model usage, and trajectories.",
      inputSchema: {
        limit: z.number().int().min(1).max(1000).optional(),
        since_minutes: z.number().positive().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (params) => respond(() => getStats({ limit: params.limit, since_minutes: params.since_minutes })),
  );

  server.registerTool(
    "router_estimate_cost",
    {
      title: "Estimate model costs",
      description: "Pre-flight cost estimate across every model in the catalog for a prompt.",
      inputSchema: {
        prompt: z.string().min(1),
        estimated_output_tokens: z.number().int().positive().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ prompt, estimated_output_tokens }) => respond(() => {
      const result = estimateCost(prompt, estimated_output_tokens);
      return {
        ...result,
        rows: result.rows.map((row) => ({ model: formatModel(row.model), estimated_cost_usd: row.estimated_cost_usd })),
      };
    }),
  );

  server.registerTool(
    "router_record_outcome",
    {
      title: "Record routing outcome",
      description: "Eval agent calls this after execution to store success, quality, latency, cost, and escalation signals for adaptive routing.",
      inputSchema: OutcomeInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (params) => respond(() => {
      const result = recordOutcome(params);
      return {
        outcome: {
          id: result.outcome.id,
          request_id: result.outcome.requestId,
          model_id: result.outcome.modelId,
          task_type: result.outcome.taskType,
          success: result.outcome.success,
          quality_score: result.outcome.qualityScore,
          needed_escalation: result.outcome.neededEscalation,
        },
        learned_score: result.modelTaskScore,
      };
    }),
  );

  server.registerTool(
    "router_get_learned_scores",
    {
      title: "Get learned model task scores",
      description: "Returns adaptive scoring aggregates learned from recorded outcomes.",
      inputSchema: {
        task_type: TaskTypeSchema.optional(),
        model_id: z.string().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (params) => respond(() => ({
      scores: getLearnedScores({
        task_type: params.task_type as TaskType | undefined,
        model_id: params.model_id,
      }),
    })),
  );

  server.registerTool(
    "v2_log_event",
    {
      title: "Log V2 learning event",
      description: "Records user clicks, model choices, feedback, and V2 learning events without storing raw API keys.",
      inputSchema: {
        session_id: z.string().min(1),
        user_id: z.string().optional(),
        event_type: z.string().min(1),
        request_id: z.string().optional(),
        model_id: z.string().optional(),
        task_type: TaskTypeSchema.optional(),
        document_profile: DocumentProfileSchema.optional(),
        extraction_instruction: z.string().optional(),
        payload: z.record(z.string(), z.unknown()).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (params) => respond(() => ({
      event: logV2Event({
        sessionId: params.session_id,
        userId: params.user_id,
        eventType: params.event_type as any,
        requestId: params.request_id,
        modelId: params.model_id,
        taskType: params.task_type as TaskType | undefined,
        documentProfile: params.document_profile,
        extractionInstruction: params.extraction_instruction,
        payload: params.payload || {},
      }),
    })),
  );

  server.registerTool(
    "v2_evaluate_extraction",
    {
      title: "Evaluate extraction deterministically",
      description: "Runs mathematical/rule-based validation for invoice, bank statement, and document extraction outputs.",
      inputSchema: {
        task_type: TaskTypeSchema,
        document_profile: DocumentProfileSchema.optional(),
        extraction: z.record(z.string(), z.unknown()),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (params) => respond(() => ({
      evaluation: evaluateExtraction({
        taskType: params.task_type as TaskType,
        documentProfile: params.document_profile,
        extraction: params.extraction,
      }),
    })),
  );
}

async function respond(build: () => unknown | Promise<unknown>) {
  try {
    const structuredContent = await build() as Record<string, unknown>;
    return {
      content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
  }
}

function formatDecision(decision: ReturnType<typeof route>): Record<string, unknown> {
  return {
    request_id: decision.requestId,
    timestamp: decision.timestamp,
    selected_model: formatModel(decision.selectedModel),
    fallback_model: decision.fallbackModel ? { id: decision.fallbackModel.id, name: decision.fallbackModel.name } : null,
    detected_task_type: decision.detectedTaskType,
    classification_confidence: decision.classificationConfidence,
    estimated_input_tokens: decision.estimatedInputTokens,
    estimated_output_tokens: decision.estimatedOutputTokens,
    estimated_cost_usd: decision.estimatedCostUsd,
    estimated_latency_ms: decision.estimatedLatencyMs,
    reasoning: decision.reasoning,
    alternatives_considered: decision.alternativesConsidered,
    trajectory_id: decision.trajectoryId || null,
    policy_applied: decision.policyApplied,
    document_difficulty: decision.documentDifficulty,
    document_profile: decision.documentProfile || null,
    recommended_models: decision.modelScores
      .filter((score) => !score.filteredReason)
      .slice(0, 8)
      .map((score) => {
        const model = decision.selectedModel.id === score.modelId
          ? decision.selectedModel
          : decision.fallbackModel?.id === score.modelId
            ? decision.fallbackModel
            : listModels().find((candidate) => candidate.id === score.modelId);
        return {
          model_id: score.modelId,
          name: model?.name || score.modelId,
          provider: model?.provider || null,
          tier: model?.tier || null,
          score: Math.round(score.score * 10000) / 10000,
          static_score: Math.round((score.staticScore || 0) * 10000) / 10000,
          learned_score: Math.round((score.learnedScore || 0) * 10000) / 10000,
          learned_blend: Math.round((score.learnedBlend || 0) * 10000) / 10000,
          estimated_cost_usd: Math.round(score.estimatedCostUsd * 1000000) / 1000000,
          cost_per_1k_input_tokens: model?.costPer1kInputTokens ?? null,
          cost_per_1k_output_tokens: model?.costPer1kOutputTokens ?? null,
          cost_score: Math.round(score.costScore * 10000) / 10000,
          quality_score: Math.round(score.qualityScore * 10000) / 10000,
          latency_score: Math.round(score.latencyScore * 10000) / 10000,
          tier_bonus: Math.round((score.tierBonus || 0) * 10000) / 10000,
        };
      }),
  };
}

function formatModel(model: ModelSpec): Record<string, unknown> {
  return {
    id: model.id,
    name: model.name,
    provider: model.provider,
    tier: model.tier,
    hosting: model.hosting,
    is_open_weight: model.isOpenWeight,
    cost_per_1k_input_tokens: model.costPer1kInputTokens,
    cost_per_1k_output_tokens: model.costPer1kOutputTokens,
    avg_latency_ms: model.avgLatencyMs,
    quality_score: model.qualityScore,
    supports_vision: model.supportsVision,
    supports_function_calling: model.supportsFunctionCalling,
    supports_structured_output: model.supportsStructuredOutput,
    max_output_tokens: model.maxOutputTokens,
    compliance_tags: model.complianceTags,
  };
}
