import { listModels } from "./services/modelCatalog.js";
import { executeRequest } from "./services/executionEngine.js";
import { estimateCost, getLearnedScores, getStats, getTrajectory, recordOutcome, route } from "./services/routingEngine.js";
import { routeV3 } from "./services/routingEngineV3.js";
import { routeV4 } from "./services/routingEngineV4.js";
import { evaluateExtraction, logV2Event } from "./services/v2Learning.js";
import { ModelProvider, ModelTier, RoutingPolicy, TaskType } from "./types.js";

const toolDefinitions = [
  {
    name: "router_route_request",
    title: "Route document extraction request",
    description: "Call before OCR, PDF parsing, document extraction, validation, or reconciliation. Returns optimal model plus cost, latency, fallback, and reasoning.",
    inputSchema: {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: { type: "string" },
        task_type: { type: "string" },
        step_type: { type: "string" },
        trajectory_id: { type: "string" },
        agent_id: { type: "string" },
        estimated_input_tokens: { type: "number" },
        estimated_output_tokens: { type: "number" },
        document_profile: { type: "object" },
        policy: { type: "object" },
      },
    },
  },
  {
    name: "router_route_request_v3",
    title: "Route document extraction request V3",
    description: "Experimental V3 router with Claude-reviewed scoring separation and server-returned applied weights.",
    inputSchema: {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: { type: "string" },
        task_type: { type: "string" },
        step_type: { type: "string" },
        trajectory_id: { type: "string" },
        agent_id: { type: "string" },
        estimated_input_tokens: { type: "number" },
        estimated_output_tokens: { type: "number" },
        document_profile: { type: "object" },
        policy: { type: "object" },
      },
    },
  },
  {
    name: "router_route_request_v4",
    title: "Route document extraction request V4",
    description: "V4 OCR/document router with preflight document profile plus benchmark-backed priors from MMR-Bench, MMDocBench, and CC-OCR V2.",
    inputSchema: {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: { type: "string" },
        task_type: { type: "string" },
        step_type: { type: "string" },
        trajectory_id: { type: "string" },
        agent_id: { type: "string" },
        estimated_input_tokens: { type: "number" },
        estimated_output_tokens: { type: "number" },
        document_profile: { type: "object" },
        policy: { type: "object" },
      },
    },
  },
  {
    name: "router_execute_request",
    title: "Route and execute document extraction request",
    description: "Routes a document OCR/extraction prompt, calls the selected provider when credentials are configured, and returns dry-run output otherwise.",
    inputSchema: {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: { type: "string" },
        system_prompt: { type: "string" },
        task_type: { type: "string" },
        step_type: { type: "string" },
        trajectory_id: { type: "string" },
        agent_id: { type: "string" },
        estimated_input_tokens: { type: "number" },
        estimated_output_tokens: { type: "number" },
        document_profile: { type: "object" },
        temperature: { type: "number" },
        max_output_tokens: { type: "number" },
        dry_run: { type: "boolean" },
        record_outcome: { type: "boolean" },
        policy: { type: "object" },
      },
    },
  },
  {
    name: "router_list_models",
    title: "List routable models",
    description: "Browse the model catalog with pricing, capabilities, compliance, and filters.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "router_get_trajectory",
    title: "Get trajectory state",
    description: "Returns spend and step history for a multi-step agent trajectory.",
    inputSchema: { type: "object", required: ["trajectory_id"], properties: { trajectory_id: { type: "string" } } },
  },
  {
    name: "router_get_stats",
    title: "Get routing statistics",
    description: "Aggregate routing stats, cost, savings, model usage, and trajectories.",
    inputSchema: { type: "object", properties: { limit: { type: "number" }, since_minutes: { type: "number" } } },
  },
  {
    name: "router_estimate_cost",
    title: "Estimate model costs",
    description: "Pre-flight cost estimate across every model in the catalog for a prompt.",
    inputSchema: { type: "object", required: ["prompt"], properties: { prompt: { type: "string" }, estimated_output_tokens: { type: "number" } } },
  },
  {
    name: "router_record_outcome",
    title: "Record routing outcome",
    description: "Eval agent calls this after execution to store success, quality, latency, cost, and escalation signals.",
    inputSchema: {
      type: "object",
      required: ["request_id", "success"],
      properties: {
        request_id: { type: "string" },
        success: { type: "boolean" },
        validation_passed: { type: "boolean" },
        needed_escalation: { type: "boolean" },
        quality_score: { type: "number" },
        actual_cost_usd: { type: "number" },
        actual_latency_ms: { type: "number" },
        error_type: { type: "string" },
        evaluator_type: { type: "string" },
        evaluator_model_id: { type: "string" },
        notes: { type: "string" },
        metadata: { type: "object" },
      },
    },
  },
  {
    name: "router_get_learned_scores",
    title: "Get learned model task scores",
    description: "Returns adaptive scoring aggregates learned from recorded outcomes.",
    inputSchema: { type: "object", properties: { task_type: { type: "string" }, model_id: { type: "string" } } },
  },
  {
    name: "v2_log_event",
    title: "Log V2 learning event",
    description: "Records V2 BYOK routing choices, clicks, evals, and feedback without storing raw API keys.",
    inputSchema: {
      type: "object",
      required: ["session_id", "event_type"],
      properties: {
        session_id: { type: "string" },
        user_id: { type: "string" },
        event_type: { type: "string" },
        request_id: { type: "string" },
        model_id: { type: "string" },
        task_type: { type: "string" },
        document_profile: { type: "object" },
        extraction_instruction: { type: "string" },
        payload: { type: "object" },
      },
    },
  },
  {
    name: "v2_evaluate_extraction",
    title: "Evaluate extraction deterministically",
    description: "Runs mathematical/rule-based validation for invoice, bank statement, and generic document extraction outputs.",
    inputSchema: {
      type: "object",
      required: ["task_type", "extraction"],
      properties: {
        task_type: { type: "string" },
        document_profile: { type: "object" },
        extraction: { type: "object" },
      },
    },
  },
];

export async function handleJsonRpc(body: any): Promise<any> {
  if (Array.isArray(body)) return Promise.all(body.map(handleJsonRpc));
  const id = body && Object.prototype.hasOwnProperty.call(body, "id") ? body.id : null;

  try {
    if (body.method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: body.params?.protocolVersion || "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "llm-router-mcp-server", version: "1.0.0" },
        },
      };
    }

    if (body.method === "tools/list") {
      return { jsonrpc: "2.0", id, result: { tools: toolDefinitions } };
    }

    if (body.method === "tools/call") {
      const result = await callTool(body.params?.name, body.params?.arguments || {});
      return { jsonrpc: "2.0", id, result };
    }

    if (body.method === "notifications/initialized") return null;

    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${body.method}` },
    };
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
    };
  }
}

async function callTool(name: string, args: Record<string, any>) {
  try {
    const structuredContent = await runTool(name, args);
    return {
      content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

async function runTool(name: string, args: Record<string, any>) {
  if (name === "router_route_request") {
    return formatDecision(route({
      prompt: String(args.prompt || ""),
      task_type: args.task_type as TaskType | undefined,
      step_type: args.step_type,
      trajectory_id: args.trajectory_id,
      agent_id: args.agent_id,
      estimated_input_tokens: args.estimated_input_tokens,
      estimated_output_tokens: args.estimated_output_tokens,
      document_profile: args.document_profile,
      policy: args.policy as RoutingPolicy | undefined,
    }));
  }

  if (name === "router_route_request_v3") {
    return formatDecision(routeV3({
      prompt: String(args.prompt || ""),
      task_type: args.task_type as TaskType | undefined,
      step_type: args.step_type,
      trajectory_id: args.trajectory_id,
      agent_id: args.agent_id,
      estimated_input_tokens: args.estimated_input_tokens,
      estimated_output_tokens: args.estimated_output_tokens,
      document_profile: args.document_profile,
      policy: args.policy as RoutingPolicy | undefined,
    }));
  }

  if (name === "router_route_request_v4") {
    return formatDecision(routeV4({
      prompt: String(args.prompt || ""),
      task_type: args.task_type as TaskType | undefined,
      step_type: args.step_type,
      trajectory_id: args.trajectory_id,
      agent_id: args.agent_id,
      estimated_input_tokens: args.estimated_input_tokens,
      estimated_output_tokens: args.estimated_output_tokens,
      document_profile: args.document_profile,
      policy: args.policy as RoutingPolicy | undefined,
    }));
  }

  if (name === "router_list_models") {
    const models = listModels({
      tier_filter: args.tier_filter as ModelTier | undefined,
      provider_filter: args.provider_filter as ModelProvider | undefined,
      open_weight_only: args.open_weight_only,
      compliance_required: args.compliance_required,
    });
    return { count: models.length, models: models.map(formatModel) };
  }

  if (name === "router_execute_request") {
    const result = await executeRequest({
      prompt: String(args.prompt || ""),
      system_prompt: args.system_prompt,
      task_type: args.task_type as TaskType | undefined,
      step_type: args.step_type,
      trajectory_id: args.trajectory_id,
      agent_id: args.agent_id,
      estimated_input_tokens: args.estimated_input_tokens,
      estimated_output_tokens: args.estimated_output_tokens,
      document_profile: args.document_profile,
      temperature: args.temperature,
      max_output_tokens: args.max_output_tokens,
      dry_run: args.dry_run,
      record_outcome: args.record_outcome,
      policy: args.policy as RoutingPolicy | undefined,
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
  }

  if (name === "router_get_trajectory") {
    const trajectory = getTrajectory(String(args.trajectory_id || ""));
    if (!trajectory) throw new Error(`Trajectory not found: ${args.trajectory_id}`);
    return trajectory;
  }

  if (name === "router_get_stats") {
    return getStats({ limit: args.limit, since_minutes: args.since_minutes });
  }

  if (name === "router_estimate_cost") {
    const result = estimateCost(String(args.prompt || ""), args.estimated_output_tokens);
    return {
      ...result,
      rows: result.rows.map((row) => ({ model: formatModel(row.model), estimated_cost_usd: row.estimated_cost_usd })),
    };
  }

  if (name === "router_record_outcome") {
    const result = recordOutcome({
      request_id: String(args.request_id || ""),
      success: Boolean(args.success),
      validation_passed: args.validation_passed,
      needed_escalation: args.needed_escalation,
      quality_score: args.quality_score,
      actual_cost_usd: args.actual_cost_usd,
      actual_latency_ms: args.actual_latency_ms,
      error_type: args.error_type,
      evaluator_type: args.evaluator_type,
      evaluator_model_id: args.evaluator_model_id,
      notes: args.notes,
      metadata: args.metadata,
    });
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
  }

  if (name === "router_get_learned_scores") {
    return {
      scores: getLearnedScores({
        task_type: args.task_type as TaskType | undefined,
        model_id: args.model_id,
      }),
    };
  }

  if (name === "v2_log_event") {
    return {
      event: logV2Event({
        sessionId: String(args.session_id || ""),
        userId: args.user_id,
        eventType: args.event_type,
        requestId: args.request_id,
        modelId: args.model_id,
        taskType: args.task_type as TaskType | undefined,
        documentProfile: args.document_profile,
        extractionInstruction: args.extraction_instruction,
        payload: args.payload || {},
      }),
    };
  }

  if (name === "v2_evaluate_extraction") {
    return {
      evaluation: evaluateExtraction({
        taskType: args.task_type as TaskType,
        documentProfile: args.document_profile,
        extraction: args.extraction || {},
      }),
    };
  }

  throw new Error(`Unknown tool: ${name}`);
}

function formatDecision(decision: ReturnType<typeof route>) {
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
    applied_weights: decision.appliedWeights || null,
    appliedWeights: decision.appliedWeights || null,
    recommended_models: decision.modelScores
      .filter((score) => !score.filteredReason)
      .slice(0, 20)
      .map((score) => {
        const model = listModels().find((candidate) => candidate.id === score.modelId);
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
          document_fit_score: Math.round((score.documentFitScore || 0) * 10000) / 10000,
          raw_document_fit_score: Math.round((score.rawDocumentFitScore || 0) * 10000) / 10000,
          document_fit_reasons: score.documentFitReasons || [],
          tier_bonus: Math.round((score.tierBonus || 0) * 10000) / 10000,
          benchmark_prior_score: Math.round((score.benchmarkPriorScore || 0) * 10000) / 10000,
          benchmark_prior_confidence: Math.round((score.benchmarkPriorConfidence || 0) * 10000) / 10000,
          benchmark_prior_reasons: score.benchmarkPriorReasons || [],
          benchmark_prior_sources: score.benchmarkPriorSources || [],
          benchmark_categories: score.benchmarkCategories || [],
        };
      }),
  };
}

function formatModel(model: any) {
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
