# Troubleshooting

---

## Build errors

### `Cannot find module '@modelcontextprotocol/sdk'`

The npm install did not complete or failed silently.

```bash
rm -rf node_modules package-lock.json
npm install
npm run build
```

### `dist/index.js not found` or `ERR_MODULE_NOT_FOUND`

TypeScript has not been compiled yet.

```bash
npm run build
ls dist/
# must contain: index.js  services/  tools/
```

If `npm run build` produces errors, read them carefully. The most common cause
is a type mismatch after manually editing `src/types.ts` — check that all
union types are in sync across `types.ts`, `routingEngine.ts`, and
`routingTools.ts`.

### `error TS2345: Argument of type X is not assignable`

You added a new value to a union type in one file but not the others.
For example, if you add `"cohere"` to `ModelProvider` in `types.ts`, you
must also add it to the `provider_filter` Zod enum in `routingTools.ts`.
See `docs/extending.md` for the full checklist.

---

## Server startup errors

### `EADDRINUSE: address already in use :::3100`

Port 3100 is taken by another process.

```bash
# Find what is using it
lsof -i :3100          # macOS / Linux
netstat -ano | findstr 3100   # Windows

# Kill it
kill -9 <PID>

# Or use a different port
PORT=3200 TRANSPORT=http node dist/index.js
```

### Server starts but no output in HTTP mode

This is correct. The server writes startup messages to stderr, not stdout.

```bash
TRANSPORT=http PORT=3100 node dist/index.js 2>&1 | head -5
# should print: "LLM Router MCP server running on http://localhost:3100/mcp"
```

### Server exits immediately in stdio mode

Also correct — if you run `node dist/index.js` directly in a terminal with
no stdin piped to it, some terminals close stdin immediately which causes the
server to exit. Test it properly:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node dist/index.js
```

---

## Routing errors

### `No eligible model found for this request`

Your policy is filtering out every model. Debug by calling `router_list_models`
with your intended filters first:

```bash
curl -s -X POST http://localhost:3100/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc":"2.0","id":"1","method":"tools/call",
    "params":{
      "name":"router_list_models",
      "arguments":{
        "compliance_required":["hipaa"],
        "tier_filter":"nano",
        "open_weight_only":false
      }
    }
  }' | python3 -m json.tool
```

If `count` is 0, that combination has no models. Common impossible combinations:

| Policy combination | Why it fails |
|---|---|
| `requiredCompliance:["hipaa"]` + `allowedTiers:["nano"]` + `allowSelfHosted:false` | No cloud nano model has HIPAA |
| `requiredCompliance:["hipaa"]` + `allowedProviders:["google"]` + `allowSelfHosted:false` | Gemini Flash (nano) doesn't have HIPAA |
| `maxCostPer1kTokens:0.00001` | Too low — excludes everything |
| `minQualityScore:99` | No model scores that high |

### Router always returns the same model

The task classifier is defaulting to `"unknown"` because no keyword signals
matched. Either:

1. Pass `task_type` explicitly to skip classification:
   ```json
   { "prompt": "...", "task_type": "extraction" }
   ```

2. Pass `step_type` which also feeds the classifier:
   ```json
   { "prompt": "...", "step_type": "planning" }
   ```

3. Check `detected_task_type` and `classification_confidence` in the response
   to understand what the classifier saw.

### Cost in response is `0` or unexpectedly low

The token estimates defaulted. Pass explicit token counts:

```json
{
  "prompt": "...",
  "estimated_input_tokens": 1500,
  "estimated_output_tokens": 400
}
```

### `reasoning` field says "force_tier"

A `forceTier` policy override is active, either from your policy or because
the trajectory budget was exhausted. Check `policyApplied.forceTier` in the
response to confirm.

---

## Claude Desktop integration

### Tools don't appear in Claude Desktop after setup

1. Confirm the path is absolute — open terminal and run:
   ```bash
   node /the/exact/path/you/put/in/the/config/dist/index.js
   ```
   If the server hangs with no output, the path is correct. If you get
   `Error: Cannot find module`, the path is wrong.

2. Quit Claude Desktop fully — on Mac this means Cmd+Q, not just closing
   the window. Then reopen.

3. Check Claude Desktop logs:
   - macOS: `~/Library/Logs/Claude/`
   - Windows: `%APPDATA%\Claude\logs\`

4. Validate your JSON config syntax — a trailing comma or missing quote
   breaks the entire config silently:
   ```bash
   cat "~/Library/Application Support/Claude/claude_desktop_config.json" | python3 -m json.tool
   ```

### `server disconnected` error in Claude Desktop

The server process crashed. Run it manually to see the error:

```bash
node /the/exact/path/dist/index.js
# pipe something to stdin to trigger it
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node /the/exact/path/dist/index.js
```

### Config file doesn't exist yet

Create it:

```bash
# macOS
mkdir -p ~/Library/Application\ Support/Claude
echo '{"mcpServers":{"llm-router":{"command":"node","args":["/absolute/path/llm-router-mcp/dist/index.js"]}}}' \
  > ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

---

## HTTP transport errors

### `fetch failed` or `ECONNREFUSED` from agent code

The server is not running or is on a different port. Verify:

```bash
curl http://localhost:3100/health
```

If you get `Connection refused`, start the server:

```bash
TRANSPORT=http PORT=3100 node dist/index.js
```

### `400 Bad Request` from the `/mcp` endpoint

Your JSON-RPC payload is malformed. Required fields:

```json
{
  "jsonrpc": "2.0",
  "id": "any-string-or-number",
  "method": "tools/call",
  "params": {
    "name": "router_route_request",
    "arguments": { ... }
  }
}
```

Common mistakes: missing `"jsonrpc"` field, `method` spelled wrong, `params`
instead of `arguments` inside params.

### `500 Internal Server Error` from the `/mcp` endpoint

An unhandled exception in a tool handler. Run with `LOG_LEVEL=debug` to see
the full stack trace:

```bash
LOG_LEVEL=debug TRANSPORT=http PORT=3100 node dist/index.js
```

---

## Decision log and trajectory issues

### Trajectory not found after server restart

The trajectory store is in-memory. It resets every time the server restarts.
If you need persistence across restarts, this is a v2 feature — see
`docs/v2-roadmap.md`.

### `router_get_stats` returns 0 total_requests

Stats are aggregated from the in-memory decision log, which also resets on
restart. Make some routing calls first, then check stats.

### Decision log stops recording after many calls

The ring buffer max is 10,000 decisions (configurable via `MAX_DECISIONS_LOG`).
Once full, oldest entries are dropped as new ones arrive. This is intentional
for v1. For production, increase the limit or implement persistence:

```bash
MAX_DECISIONS_LOG=100000 TRANSPORT=http PORT=3100 node dist/index.js
```
