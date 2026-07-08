# Extending the router

---

## Add a new model

All models live in `src/services/modelCatalog.ts` in the `MODEL_CATALOG` array.

### Step 1 — check if the provider exists

Open `src/types.ts` and find:

```typescript
export type ModelProvider = "anthropic" | "openai" | "google" | "mistral" | "meta" | "qwen" | "deepseek";
```

If your provider is not in this union, add it:

```typescript
export type ModelProvider = "anthropic" | "openai" | "google" | "mistral" | "meta" | "qwen" | "deepseek" | "cohere";
```

### Step 2 — add the model entry

Open `src/services/modelCatalog.ts` and add to the `MODEL_CATALOG` array:

```typescript
{
  id: "command-r-plus",            // exact string the provider's API expects
  name: "Cohere Command R+",
  provider: "cohere",
  tier: "mid",                     // "nano" | "small" | "mid" | "frontier"
  hosting: "cloud",                // "cloud" | "self-hosted" | "local"
  costPer1kInputTokens: 0.003,     // from published rate card, USD
  costPer1kOutputTokens: 0.015,
  contextWindow: 128000,
  avgLatencyMs: 850,               // p50 in milliseconds
  supportsVision: false,
  supportsFunctionCalling: true,
  supportsStructuredOutput: true,
  maxOutputTokens: 4096,
  qualityScore: 78,                // derive from public benchmarks (MMLU, MT-Bench)
  complianceTags: ["soc2", "gdpr"],
  isOpenWeight: false,
},
```

### Step 3 — rebuild and verify

```bash
npm run build
```

Then confirm the model appears:

```bash
curl -s -X POST http://localhost:3100/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":"1","method":"tools/call","params":{"name":"router_list_models","arguments":{"provider_filter":"cohere"}}}' \
  | python3 -m json.tool
```

No other files need to change. The routing engine picks up new models automatically.

---

## Update an existing model's pricing

Find the model by `id` in `MODEL_CATALOG` and update the cost fields:

```typescript
// Before
costPer1kInputTokens: 0.003,
costPer1kOutputTokens: 0.015,

// After (e.g. provider dropped prices)
costPer1kInputTokens: 0.002,
costPer1kOutputTokens: 0.010,
```

Rebuild. All future routing decisions use the new prices immediately.
Historic decisions in the ring buffer still reflect the old prices — this is expected.

---

## Add a new routing strategy

Strategies define how cost, quality, and latency scores are weighted.

### Step 1 — add weights to `strategyWeights()`

In `src/services/routingEngine.ts`, find:

```typescript
function strategyWeights(strategy: string) {
  const strategies: Record<string, { cost: number; quality: number; latency: number }> = {
    cost:     { cost: 0.70, quality: 0.20, latency: 0.10 },
    quality:  { cost: 0.10, quality: 0.75, latency: 0.15 },
    latency:  { cost: 0.15, quality: 0.20, latency: 0.65 },
    balanced: { cost: 0.35, quality: 0.45, latency: 0.20 },
  };
  return strategies[strategy] ?? strategies.balanced;
}
```

Add your strategy:

```typescript
// Optimised for regulated healthcare: cost-focused but never sacrifices quality
hipaa_optimised: { cost: 0.55, quality: 0.35, latency: 0.10 },
```

Weights must sum to 1.0.

### Step 2 — add to the Zod schema

In `src/tools/routingTools.ts`, find:

```typescript
const RoutingStrategySchema = z.enum(["cost", "quality", "latency", "balanced"]);
```

Add the new value:

```typescript
const RoutingStrategySchema = z.enum(["cost", "quality", "latency", "balanced", "hipaa_optimised"]);
```

### Step 3 — update types

In `src/types.ts`, find:

```typescript
export type RoutingStrategy = "cost" | "quality" | "latency" | "balanced";
```

Add the new value:

```typescript
export type RoutingStrategy = "cost" | "quality" | "latency" | "balanced" | "hipaa_optimised";
```

### Step 4 — rebuild and test

```bash
npm run build
```

Test with:

```bash
curl -s -X POST http://localhost:3100/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc":"2.0","id":"1","method":"tools/call",
    "params":{
      "name":"router_route_request",
      "arguments":{
        "prompt":"Extract diagnosis codes from this clinical note",
        "policy":{"strategy":"hipaa_optimised","requiredCompliance":["hipaa"]}
      }
    }
  }' | python3 -m json.tool
```

---

## Add a new task type

Task types drive tier selection. Adding one requires changes in three places.

### Step 1 — add to the TaskType union in `src/types.ts`

```typescript
export type TaskType =
  | "simple_qa"
  | "tool_selection"
  // ... existing types ...
  | "document_extraction"   // ← new
  | "unknown";
```

### Step 2 — add keyword signals in `classifyTask()` in `routingEngine.ts`

```typescript
const signals: Array<[RegExp, TaskType, number]> = [
  // ... existing signals ...
  [/\b(extract|parse|pull out|identify).{0,20}(from|in).{0,30}(document|pdf|invoice|receipt|statement)/i, "document_extraction", 0.88],
];
```

Confidence values (third element) should be between 0.7 and 0.95.
Higher = more certain this keyword pattern identifies the task.

### Step 3 — add tier preference in `preferredTierForTask()` in `routingEngine.ts`

```typescript
const map: Record<TaskType, Record<string, string[]>> = {
  // ... existing entries ...
  document_extraction: {
    low:    ["small", "nano"],
    medium: ["mid",   "small"],
    high:   ["mid",   "frontier"],
  },
};
```

### Step 4 — add output token estimate in `estimateOutputTokens()` in `routingEngine.ts`

```typescript
const map: Record<TaskType, number> = {
  // ... existing entries ...
  document_extraction: 400,
};
```

### Step 5 — rebuild and verify

```bash
npm run build
```

Test that the classifier picks up the new type:

```bash
curl -s -X POST http://localhost:3100/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc":"2.0","id":"1","method":"tools/call",
    "params":{
      "name":"router_route_request",
      "arguments":{"prompt":"Extract all line items from this invoice PDF"}
    }
  }' | python3 -m json.tool
```

Check `detected_task_type` in the response equals `"document_extraction"`.

---

## Add a new MCP tool

See the checklist in `SYSTEM.md` under "Adding a new tool". The implementation
pattern follows every existing tool in `src/tools/routingTools.ts`:

```typescript
server.registerTool(
  "router_your_tool_name",       // must be prefixed with "router_"
  {
    title: "Human readable title",
    description: `Detailed description agents use to decide when to call this tool.
Be specific about what it does, what arguments it needs, and what it returns.`,
    inputSchema: z.object({
      required_field: z.string().describe("What this field does"),
      optional_field: z.number().optional().default(10),
    }).strict(),
    annotations: {
      readOnlyHint: true,          // true if the tool doesn't mutate state
      destructiveHint: false,
      idempotentHint: true,        // true if calling twice has same effect
      openWorldHint: false,
    },
  },
  async (params) => {
    try {
      const result = yourLogicHere(params);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
    }
  }
);
```

After adding, update `SYSTEM.md` tool contracts table and add a test to `docs/testing.md`.
