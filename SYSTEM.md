# SYSTEM.md — LLM Router MCP Server

> For coding agents (Claude Code, Cursor, Copilot): read this file first.
> It defines the architecture, type system, tool contracts, and code locations
> you need to navigate and modify this codebase correctly.

---

## What this system does

A Model Context Protocol (MCP) server. It exposes routing and eval tools that agents call
before every LLM API call. The router classifies the task, scores all models
in the catalog against a routing policy, and returns the best model ID plus
reasoning. It never proxies the actual LLM call — that is the agent's job.

```
agent calls router_route_request(prompt, policy, trajectory_id)
    → router classifies task, scores models, applies policy
    → returns { selected_model.id, estimated_cost_usd, reasoning }
agent calls LLM directly using selected_model.id
```

---

## Repository layout

```
llm-router-mcp/
├── src/
│   ├── index.ts                   entry point — transport selection, server init
│   ├── types.ts                   ALL types and interfaces — read this before editing
│   ├── services/
│   │   ├── modelCatalog.ts        MODEL_CATALOG array — edit to add/update models
│   │   └── routingEngine.ts       core routing logic, trajectory store, decision log
│   └── tools/
│       └── routingTools.ts        MCP tool registrations — edit to add/change tools
├── docs/
│   ├── troubleshooting.md
│   ├── docker.md
│   ├── extending.md
│   ├── testing.md
│   └── v2-roadmap.md
├── SYSTEM.md                      ← you are here
├── DEVELOPMENT.md                 build commands, env vars, run instructions
└── README.md                      high-level summary only
```

---

## Type system — read before editing any file

All types live in `src/types.ts`. Never define new types inline in other files —
add them to `src/types.ts` and import. Key types:

### ModelSpec

Describes one model in the catalog. Every field is required.

```typescript
interface ModelSpec {
  id: string                    // exact API model string, e.g. "claude-haiku-4-5"
  name: string                  // human-readable
  provider: ModelProvider       // union: "anthropic"|"openai"|"google"|"mistral"|"meta"|"qwen"|"deepseek"
  tier: ModelTier               // union: "nano"|"small"|"mid"|"frontier"
  hosting: ModelHosting         // union: "cloud"|"self-hosted"|"local"
  costPer1kInputTokens: number  // USD, from published rate card
  costPer1kOutputTokens: number
  contextWindow: number         // max input tokens
  avgLatencyMs: number          // p50
  supportsVision: boolean
  supportsFunctionCalling: boolean
  supportsStructuredOutput: boolean
  maxOutputTokens: number
  qualityScore: number          // 0–100, benchmark-derived
  complianceTags: string[]      // e.g. ["soc2","hipaa","gdpr"]
  isOpenWeight: boolean
}
```

### RoutingPolicy

Passed per-request to override default routing behaviour. All fields optional.

```typescript
interface RoutingPolicy {
  strategy?: "cost"|"quality"|"latency"|"balanced"
  maxCostPer1kTokens?: number
  maxLatencyMs?: number
  minQualityScore?: number
  requiredCompliance?: string[]
  allowedTiers?: ModelTier[]
  allowedProviders?: ModelProvider[]
  allowSelfHosted?: boolean
  forceTier?: ModelTier
}
```

### RoutingDecision

The object returned by `route()` and serialised into the tool response.

```typescript
interface RoutingDecision {
  requestId: string
  timestamp: string
  agentId?: string
  trajectoryId?: string
  stepType?: string
  detectedTaskType: TaskType
  classificationConfidence: number      // 0–1
  selectedModel: ModelSpec
  fallbackModel?: ModelSpec
  policyApplied: RoutingPolicy
  modelScores: ModelScore[]
  estimatedCostUsd: number
  estimatedLatencyMs: number
  reasoning: string                     // human-readable explanation
  alternativesConsidered: string[]
}
```

### TaskType union

```typescript
type TaskType =
  | "simple_qa"
  | "tool_selection"
  | "code_generation"
  | "code_review"
  | "reasoning"
  | "summarization"
  | "extraction"
  | "planning"
  | "synthesis"
  | "creative"
  | "embedding"
  | "unknown"
```

### TrajectoryState

Stored in the in-memory `trajectoryStore` Map keyed by `trajectoryId`.

```typescript
interface TrajectoryState {
  trajectoryId: string
  agentId?: string
  startModel: string
  currentModel: string
  stepCount: number
  totalCostUsd: number
  budgetRemainingUsd?: number
  stepHistory: Array<{
    step: number
    stepType: string
    modelId: string
    costUsd: number
    latencyMs: number
  }>
  startedAt: string
  lastUpdatedAt: string
}
```

---

## Tool contracts

These are the 5 MCP tools agents can call. The table maps tool name → handler
function → file location. When you add or modify a tool, all three columns must
stay in sync.

| Tool name | Handler in | Defined in |
|---|---|---|
| `router_route_request` | `registerRoutingTools()` | `src/tools/routingTools.ts` |
| `router_list_models` | `registerRoutingTools()` | `src/tools/routingTools.ts` |
| `router_get_trajectory` | `registerRoutingTools()` | `src/tools/routingTools.ts` |
| `router_get_stats` | `registerRoutingTools()` | `src/tools/routingTools.ts` |
| `router_estimate_cost` | `registerRoutingTools()` | `src/tools/routingTools.ts` |
| `router_record_outcome` | `registerRoutingTools()` | `src/tools/routingTools.ts` |
| `router_get_learned_scores` | `registerRoutingTools()` | `src/tools/routingTools.ts` |

### router_route_request — input schema

```typescript
{
  prompt: string                        // required, 1–100000 chars
  task_type?: TaskType                  // skip classifier if known
  step_type?: string                    // agent step label, e.g. "planning"
  trajectory_id?: string               // for multi-step budget tracking
  agent_id?: string
  estimated_input_tokens?: number
  estimated_output_tokens?: number
  policy?: RoutingPolicy
}
```

### router_route_request — output schema

```typescript
{
  request_id: string
  timestamp: string
  selected_model: {
    id: string
    name: string
    provider: string
    tier: string
    hosting: string
    is_open_weight: boolean
    cost_per_1k_input_tokens: number
    cost_per_1k_output_tokens: number
    avg_latency_ms: number
    quality_score: number
    supports_vision: boolean
    supports_function_calling: boolean
    max_output_tokens: number
    compliance_tags: string[]
  }
  fallback_model: { id: string, name: string } | null
  detected_task_type: string
  classification_confidence: number
  estimated_cost_usd: number
  estimated_latency_ms: number
  reasoning: string
  alternatives_considered: string[]
  trajectory_id: string | null
}
```

### router_list_models — input schema

```typescript
{
  tier_filter?: "nano"|"small"|"mid"|"frontier"
  provider_filter?: ModelProvider
  open_weight_only?: boolean
  compliance_required?: string[]
}
```

### router_get_trajectory — input schema

```typescript
{ trajectory_id: string }   // returns TrajectoryState or error
```

### router_get_stats — input schema

```typescript
{
  limit?: number            // default 100, max 1000
  since_minutes?: number    // filter to last N minutes
}
```

### router_estimate_cost — input schema

```typescript
{
  prompt: string
  estimated_output_tokens?: number   // default 300
}
```

---

## Core functions — where logic lives

| Function | File | What it does |
|---|---|---|
| `route(req)` | `routingEngine.ts` | Main entry — classify, score, select, log |
| `classifyTask(prompt, stepType?)` | `routingEngine.ts` | Keyword heuristic classifier → TaskType |
| `scoreModels(candidates, policy, ...)` | `routingEngine.ts` | Score all models, apply hard filters |
| `strategyWeights(strategy)` | `routingEngine.ts` | Returns cost/quality/latency weight triple |
| `getTrajectory(id)` | `routingEngine.ts` | Read trajectory state from in-memory store |
| `getAllTrajectories()` | `routingEngine.ts` | Read all trajectories |
| `getDecisionLog()` | `routingEngine.ts` | Read decision ring buffer |
| `registerRoutingTools(server)` | `routingTools.ts` | Register all router tools on the MCP server |

---

## Data flow — one request end to end

```
routingTools.ts: router_route_request handler receives params
    │
    ▼
routingEngine.ts: route(req)
    │
    ├─ merge DEFAULT_POLICY with req.policy
    │
    ├─ classifyTask(req.prompt, req.stepType)
    │     └─ returns { taskType, confidence, estimatedComplexity }
    │
    ├─ preferredTierForTask(taskType, complexity)
    │     └─ returns ordered tier preference list e.g. ["nano","small"]
    │
    ├─ trajectory continuity check (getTrajectory)
    │     └─ prevents >1 tier downgrade mid-session for planning/synthesis steps
    │
    ├─ budget guard (forceTier="nano" if budget exhausted)
    │
    ├─ scoreModels(MODEL_CATALOG, policy, inputTokens, outputTokens, preferredTiers)
    │     └─ per model: apply hard filters → compute cost/quality/latency scores
    │               → composite score = weighted sum + tier preference bonus
    │
    ├─ sort eligible models by compositeScore, pick [0] as selected, [1] as fallback
    │
    ├─ buildReasoning(...)  → human-readable string
    │
    ├─ upsertTrajectory(...)  → update in-memory store
    │
    ├─ push to decisionLog ring buffer
    │
    └─ return RoutingDecision
```

---

## State — what is stored in memory

Two in-memory stores. Both reset on server restart. Persistence is a v2 feature.

```typescript
// In routingEngine.ts
const trajectoryStore = new Map<string, TrajectoryState>()  // keyed by trajectoryId
const decisionLog: RoutingDecision[] = []                   // ring buffer, max 10000
```

Do not add more global state without documenting it here.

---

## Transport modes

Controlled by the `TRANSPORT` environment variable.

| Mode | Value | Used for | Protocol |
|---|---|---|---|
| stdio | `TRANSPORT=stdio` (default) | Claude Desktop, local agents | JSON-RPC over stdin/stdout |
| HTTP | `TRANSPORT=http` | Remote agents, multi-agent | StreamableHTTP POST to `/mcp` |

Transport selection happens in `src/index.ts` at the bottom of the file.
The health endpoint (`GET /health`) is only available in HTTP mode.

---

## Adding a new tool — checklist

When adding a tool to this MCP server, complete all steps or the tool will not be discoverable:

- [ ] Define input/output types in `src/types.ts` if new types are needed
- [ ] Implement the handler logic in `src/services/routingEngine.ts` if it needs new engine functions
- [ ] Register the tool using `server.registerTool(name, schema, handler)` inside `registerRoutingTools()` in `src/tools/routingTools.ts`
- [ ] Add the tool to the "Tool contracts" table in this file (`SYSTEM.md`)
- [ ] Add a test curl command to `docs/testing.md`
- [ ] Run `npm run build` and verify with the smoke test

---

## Constraints — do not violate these

- Never define types outside `src/types.ts`
- Never add a new global variable to `routingEngine.ts` without documenting it in the "State" section above
- Never change a tool's input schema without updating the Zod schema in `routingTools.ts` and the contract table in this file
- The router must never make an LLM API call — it is a decision engine only
- The decision log ring buffer max is `10000` — do not increase without considering memory impact
- All tool names must be prefixed with `router_` for namespace safety in multi-tool agents
