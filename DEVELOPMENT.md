# DEVELOPMENT.md — LLM Router MCP Server

> For coding agents: environment variables are at the top. Build commands are
> in single copy-paste blocks. Read `SYSTEM.md` first for architecture context.

---

## Environment variables

Set these before running the server. All are optional — defaults work for local development.

| Variable | Default | Required | Description |
|---|---|---|---|
| `TRANSPORT` | `stdio` | No | `stdio` for Claude Desktop · `http` for remote/multi-agent |
| `PORT` | `3100` | No | HTTP port — only used when `TRANSPORT=http` |
| `LOG_LEVEL` | `info` | No | `debug` · `info` · `warn` · `error` |
| `MAX_DECISIONS_LOG` | `10000` | No | Ring buffer size for the in-memory decision log |
| `ROUTER_API_KEY` | unset | Production | Optional HTTP API key for `/mcp` and dashboard routes |
| `RATE_LIMIT_MAX` | `0` | No | Requests per IP per window; `0` disables rate limiting |
| `RATE_LIMIT_WINDOW_MS` | `60000` | No | Rate limit window in milliseconds |
| `ROUTER_PERSISTENCE` | `file` | No | `file` for durable local state · `memory` for ephemeral tests |
| `ROUTER_STATE_DIR` | `.docrouter/router-state` | No | Directory for the local JSON state snapshot |
| `V2_EVENT_DIR` | `.docrouter/v2-events` | No | Directory for V2 BYOK learning event JSONL logs |
| `V2_UPLOAD_DIR` | `.docrouter/v2-uploads` | No | Directory for uploaded PDF/image files during V2 extraction |
| `V2_CREDENTIAL_DIR` | `.docrouter/v2-credentials` | No | Directory for encrypted V2 provider credentials |
| `V2_PROFILE_DIR` | `.docrouter/v2-profiles` | No | Directory for local V2 onboarding profiles and model preferences |
| `V2_CREDENTIAL_ENCRYPTION_KEY` | local dev fallback | Production | Secret used to encrypt BYOK provider credentials at rest |
| `V2_MAX_UPLOAD_BYTES` | `26214400` | No | Max V2 upload size in bytes |
| `SUPABASE_URL` | unset | Later | Supabase project URL for hosted persistence |
| `SUPABASE_SECRET_KEY` | unset | Later | Server-side Supabase secret key; never expose to browsers |
| `SUPABASE_SERVICE_ROLE_KEY` | unset | Later | Legacy fallback if secret keys are unavailable |
| `SUPABASE_DB_URL` | unset | Production | Postgres connection string used by `npm run db:apply:all` and DB mirroring |
| `OPENAI_API_KEY` | unset | Live execution | OpenAI Responses API |
| `ANTHROPIC_API_KEY` | unset | Live execution | Anthropic Messages API |
| `GOOGLE_API_KEY` / `GEMINI_API_KEY` | unset | Live execution | Gemini generateContent API |
| `MISTRAL_API_KEY` | unset | Live execution | Mistral chat completions API |
| `OPENAI_COMPATIBLE_BASE_URL` | unset | Self-hosted | OpenAI-compatible endpoint such as vLLM |
| `OLLAMA_BASE_URL` / `VLLM_BASE_URL` | unset | Self-hosted | Local or private open-source model endpoint |

No API keys are needed for local routing. The router does not call any LLM. Supabase keys are only needed when hosted persistence is enabled.

Persistence defaults to a local JSON snapshot so dashboard stats and trajectory history survive process restarts. When `SUPABASE_URL` plus `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY` are present, the router also mirrors decisions and trajectories into Supabase using the tables in `../supabase/migrations/*_add_llm_router_persistence.sql`.

V2 BYOK learning events are written to `.docrouter/v2-events/events.jsonl` by default. User onboarding profiles and model preferences are written to `.docrouter/v2-profiles/profiles.json`. Provider credentials are encrypted into `.docrouter/v2-credentials/credentials.json`, and uploaded PDFs/images are stored under `.docrouter/v2-uploads`. When the V2 migrations are applied and Supabase server-side env vars are set, profiles, model preferences, encrypted credentials, events, and extraction runs are mirrored to Supabase.

Apply the router schema to Supabase:

```bash
SUPABASE_DB_URL="postgresql://..." npm run db:apply:router
```

Apply the full DocRouter schema, including V2 onboarding/user-profile tables:

```bash
SUPABASE_DB_URL="postgresql://..." npm run db:apply:all
```

Use the pooled or direct Postgres connection string from Supabase with `sslmode=require`.

---

## Build commands

### Full install and build (run once after cloning)

```bash
npm install && npm run build
```

### Rebuild after source changes

```bash
npm run build
```

### Verify the build compiled correctly

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node dist/index.js
```

Expected: JSON listing all router tools. If you see this, the build is good.

### Watch mode (auto-recompile on save)

```bash
npm run dev
```

---

## Run the server

### stdio mode — for Claude Desktop

```bash
node dist/index.js
```

No output is expected. The server waits for JSON-RPC on stdin. This is correct.

### HTTP mode — for agents calling over the network

```bash
TRANSPORT=http PORT=3100 node dist/index.js
```

Confirm it is alive:

```bash
curl http://localhost:3100/health
```

Expected: `{"status":"ok","server":"llm-router-mcp-server","version":"1.0.0"}`

HTTP v1 accepts raw JSON-RPC POST requests at `/mcp`, as shown in `docs/testing.md`. Stdio mode uses the official MCP SDK transport for Claude Desktop.

Local browser surfaces:

- `http://localhost:3100/dashboard.html` - V1 cost intelligence and router demo.
- `http://localhost:3100/v2.html` - V2 onboarding, user-owned model pool, server-side encrypted credentials, OCR, routing, provider execution/dry-run fallback, deterministic eval, feedback escalation, and learning event capture.

---

## Wire into Claude Desktop

### 1. Find the config file

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

### 2. Get your absolute path

```bash
cd llm-router-mcp && pwd
```

### 3. Add to config

```json
{
  "mcpServers": {
    "llm-router": {
      "command": "node",
      "args": ["/paste-your-absolute-path-here/llm-router-mcp/dist/index.js"]
    }
  }
}
```

Do not use `~` or relative paths. Use the full absolute path from `pwd`.

### 4. Add environment variables (optional)

```json
{
  "mcpServers": {
    "llm-router": {
      "command": "node",
      "args": ["/absolute/path/llm-router-mcp/dist/index.js"],
      "env": {
        "LOG_LEVEL": "debug",
        "MAX_DECISIONS_LOG": "5000"
      }
    }
  }
}
```

### 5. Restart Claude Desktop

Quit fully (Cmd+Q on Mac) and reopen. The tools appear in the tools panel.

---

## Wire into a Python agent

```bash
pip install httpx
```

```python
import httpx, json
from uuid import uuid4

ROUTER_URL = "http://localhost:3100/mcp"

def route_request(prompt, step_type=None, trajectory_id=None, policy=None):
    payload = {
        "jsonrpc": "2.0",
        "id": str(uuid4()),
        "method": "tools/call",
        "params": {
            "name": "router_route_request",
            "arguments": {
                "prompt": prompt,
                **({"step_type": step_type} if step_type else {}),
                **({"trajectory_id": trajectory_id} if trajectory_id else {}),
                **({"policy": policy} if policy else {}),
            }
        }
    }
    r = httpx.post(ROUTER_URL, json=payload, timeout=5.0)
    return json.loads(r.json()["result"]["content"][0]["text"])

# Usage
routing = route_request("Summarise this invoice", step_type="summarization")
print(routing["selected_model"]["id"])   # e.g. "claude-haiku-4-5"
print(routing["reasoning"])
```

---

## Wire into a TypeScript agent

```typescript
const ROUTER_URL = "http://localhost:3100/mcp";

async function routeRequest(prompt: string, options: {
  stepType?: string;
  trajectoryId?: string;
  policy?: Record<string, unknown>;
} = {}) {
  const res = await fetch(ROUTER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: {
        name: "router_route_request",
        arguments: { prompt, ...options },
      },
    }),
  });
  const data = await res.json();
  return JSON.parse(data.result.content[0].text);
}

// Usage
const routing = await routeRequest("Plan the extraction pipeline", {
  stepType: "planning",
  trajectoryId: "traj-001",
});
console.log(routing.selected_model.id);
```

---

## Multi-step agent with trajectory and budget

```python
trajectory_id = str(uuid4())

steps = [
    ("planning",       "Plan how to extract and reconcile this invoice batch"),
    ("extraction",     "Extract all line items from invoice_001.pdf"),
    ("tool_selection", "Which validation rule applies to this invoice total?"),
    ("synthesis",      "Write the reconciliation report for the finance team"),
]

for step_type, prompt in steps:
    routing = route_request(
        prompt=prompt,
        step_type=step_type,
        trajectory_id=trajectory_id,
        policy={
            "strategy": "balanced",
            "requiredCompliance": ["soc2"],
            "maxCostPer1kTokens": 0.01
        }
    )
    model = routing["selected_model"]
    print(f"{step_type}: {model['name']} (tier={model['tier']}, cost=${routing['estimated_cost_usd']:.5f})")
    # call your LLM with model["id"] here
```

---

## Compliance-constrained routing

```python
routing = route_request(
    prompt="Extract patient name, DOB, and diagnosis codes from this clinical note",
    step_type="extraction",
    policy={
        "requiredCompliance": ["hipaa"],
        "allowSelfHosted": True,
        "strategy": "cost",
        "maxLatencyMs": 3000
    }
)
# Only returns models with "hipaa" in complianceTags
```

---

## Further reading

| Topic | File |
|---|---|
| Architecture, types, tool contracts | `SYSTEM.md` |
| Manual curl tests for router tools | `docs/testing.md` |
| Adding a model or routing policy | `docs/extending.md` |
| Docker and docker-compose deployment | `docs/docker.md` |
| Common errors and fixes | `docs/troubleshooting.md` |
| What is not built yet | `docs/v2-roadmap.md` |
