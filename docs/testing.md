# Testing — manual tool verification

Run these after every build to confirm all 5 tools work correctly.
The server must be running in HTTP mode first:

```bash
TRANSPORT=http PORT=3100 node dist/index.js
```

HTTP v1 uses raw JSON-RPC POST requests at `/mcp`.

---

## Smoke test (all tools discoverable)

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node dist/index.js
```

Expected: JSON listing `router_route_request`, `router_list_models`,
`router_get_trajectory`, `router_get_stats`, `router_estimate_cost`.

---

## 1. router_route_request

### Easy task — should route to nano tier

```bash
curl -s -X POST http://localhost:3100/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "t1a",
    "method": "tools/call",
    "params": {
      "name": "router_route_request",
      "arguments": {
        "prompt": "Summarise this 500-word article into 3 bullet points",
        "step_type": "summarization"
      }
    }
  }' | python3 -m json.tool
```

Expected: `selected_model.tier` = `"nano"`. Cost < $0.001.

### Hard task — should route to frontier or mid tier

```bash
curl -s -X POST http://localhost:3100/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "t1b",
    "method": "tools/call",
    "params": {
      "name": "router_route_request",
      "arguments": {
        "prompt": "Design a distributed architecture for a real-time fraud detection system handling 1M transactions per second",
        "step_type": "planning",
        "policy": { "strategy": "quality" }
      }
    }
  }' | python3 -m json.tool
```

Expected: `selected_model.tier` = `"frontier"` or `"mid"`.

### Compliance filter — HIPAA only

```bash
curl -s -X POST http://localhost:3100/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "t1c",
    "method": "tools/call",
    "params": {
      "name": "router_route_request",
      "arguments": {
        "prompt": "Extract patient name and diagnosis from this clinical note",
        "policy": {
          "requiredCompliance": ["hipaa"],
          "allowSelfHosted": true,
          "strategy": "cost"
        }
      }
    }
  }' | python3 -m json.tool
```

Expected: `selected_model.compliance_tags` contains `"hipaa"`.

### Trajectory tracking

```bash
# Step 1 — planning
curl -s -X POST http://localhost:3100/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "t1d-1",
    "method": "tools/call",
    "params": {
      "name": "router_route_request",
      "arguments": {
        "prompt": "Plan the extraction pipeline for this invoice batch",
        "step_type": "planning",
        "trajectory_id": "test-traj-001",
        "agent_id": "test-agent"
      }
    }
  }' | python3 -m json.tool

# Step 2 — tool selection
curl -s -X POST http://localhost:3100/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "t1d-2",
    "method": "tools/call",
    "params": {
      "name": "router_route_request",
      "arguments": {
        "prompt": "Which validation rule should I apply?",
        "step_type": "tool_selection",
        "trajectory_id": "test-traj-001"
      }
    }
  }' | python3 -m json.tool
```

Expected: step 1 routes to `"mid"` or `"frontier"` (planning).
Step 2 routes to `"nano"` or `"small"` (tool_selection is cheap). Both share `trajectory_id`.

### Overly restrictive policy — should return error

```bash
curl -s -X POST http://localhost:3100/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "t1e",
    "method": "tools/call",
    "params": {
      "name": "router_route_request",
      "arguments": {
        "prompt": "Anything",
        "policy": {
          "requiredCompliance": ["hipaa"],
          "allowedTiers": ["nano"],
          "allowSelfHosted": false
        }
      }
    }
  }' | python3 -m json.tool
```

Expected: `isError: true` with message explaining no eligible model found.
(No nano-tier cloud model has HIPAA certification.)

---

## 2. router_list_models

### All models

```bash
curl -s -X POST http://localhost:3100/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "t2a",
    "method": "tools/call",
    "params": {
      "name": "router_list_models",
      "arguments": {}
    }
  }' | python3 -m json.tool
```

Expected: 13 models. Check count in `structuredContent.count`.

### Filter: frontier tier only

```bash
curl -s -X POST http://localhost:3100/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "t2b",
    "method": "tools/call",
    "params": {
      "name": "router_list_models",
      "arguments": { "tier_filter": "frontier" }
    }
  }' | python3 -m json.tool
```

Expected: 4 models (Opus, GPT-5, Gemini 2.5 Pro, DeepSeek R1).

### Filter: open-weight + HIPAA compliant

```bash
curl -s -X POST http://localhost:3100/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "t2c",
    "method": "tools/call",
    "params": {
      "name": "router_list_models",
      "arguments": {
        "open_weight_only": true,
        "compliance_required": ["hipaa"]
      }
    }
  }' | python3 -m json.tool
```

Expected: 4 self-hosted models (Llama 3.3 70B, Llama 3.2 11B, Qwen 2.5 72B, DeepSeek R1).

---

## 3. router_estimate_cost

```bash
curl -s -X POST http://localhost:3100/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "t3a",
    "method": "tools/call",
    "params": {
      "name": "router_estimate_cost",
      "arguments": {
        "prompt": "Extract all line items, totals, and vendor details from this invoice. The document is a scanned PDF with 3 pages.",
        "estimated_output_tokens": 500
      }
    }
  }' | python3 -m json.tool
```

Expected: sorted list of all 13 models cheapest to most expensive.
`summary.savings_routing_vs_frontier_usd` should be a positive number.

---

## 4. router_get_trajectory

Requires a prior `router_route_request` call with a `trajectory_id`.
Run the trajectory tracking test from tool 1 first, then:

```bash
curl -s -X POST http://localhost:3100/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "t4a",
    "method": "tools/call",
    "params": {
      "name": "router_get_trajectory",
      "arguments": { "trajectory_id": "test-traj-001" }
    }
  }' | python3 -m json.tool
```

Expected: `stepCount` = 2, `stepHistory` has 2 entries, `totalCostUsd` > 0.

### Non-existent trajectory — should return error

```bash
curl -s -X POST http://localhost:3100/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "t4b",
    "method": "tools/call",
    "params": {
      "name": "router_get_trajectory",
      "arguments": { "trajectory_id": "does-not-exist" }
    }
  }' | python3 -m json.tool
```

Expected: `isError: true`.

---

## 5. router_get_stats

Run after at least a few routing calls so there is data to aggregate.

```bash
curl -s -X POST http://localhost:3100/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "t5a",
    "method": "tools/call",
    "params": {
      "name": "router_get_stats",
      "arguments": { "limit": 50 }
    }
  }' | python3 -m json.tool
```

Expected: `cost.total_cost_usd` > 0, `cost.savings_pct` > 0,
`by_model` sorted by count, `by_tier` shows distribution,
`active_trajectories` reflects open sessions.

### Time-windowed stats (last 10 minutes)

```bash
curl -s -X POST http://localhost:3100/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "t5b",
    "method": "tools/call",
    "params": {
      "name": "router_get_stats",
      "arguments": { "since_minutes": 10 }
    }
  }' | python3 -m json.tool
```

---

## What a passing test run looks like

| Test | Expected tier | Expected cost |
|---|---|---|
| Summarisation, no policy | nano | < $0.001 |
| Planning, quality strategy | frontier/mid | > $0.001 |
| HIPAA + cost strategy | mid/small (self-hosted) | < $0.001 |
| Tool selection step | nano/small | < $0.0005 |
| Restrictive policy | error | — |
| List all models | 13 results | — |
| List frontier only | 4 results | — |
| Estimate cost | 13 sorted rows | — |
| Get trajectory after 2 steps | stepCount=2 | — |
| Get stats after routing | savings_pct > 0 | — |
