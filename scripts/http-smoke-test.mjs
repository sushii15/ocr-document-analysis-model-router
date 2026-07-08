import assert from "node:assert/strict";

async function post(body) {
  const response = await fetch("http://127.0.0.1:3100/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.json();
}

const init = await post({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "http-smoke-test", version: "1.0.0" },
  },
});
assert.equal(init.result.serverInfo.name, "llm-router-mcp-server");

const tools = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
assert.ok(tools.result.tools.some((tool) => tool.name === "router_route_request"));

const result = await post({
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: {
    name: "router_route_request",
    arguments: {
      prompt: "Extract all vendor fields, invoice number, line items, subtotal, tax, and amount due from this scanned invoice PDF",
      step_type: "invoice_extraction",
      document_profile: {
        file_type: "pdf",
        page_count: 2,
        character_count: 4200,
        has_text_layer: true,
        text_layer_quality: "good",
        document_type: "invoice",
        image_quality: "high",
        layout_complexity: "simple",
        has_tables: true,
        table_count: 1,
        table_density: 0.18,
      },
    },
  },
});
const payload = JSON.parse(result.result.content[0].text);
assert.equal(payload.detected_task_type, "invoice_extraction");
assert.ok(["small", "mid", "frontier"].includes(payload.selected_model.tier));
assert.equal(payload.document_difficulty.complexity, "low");

const outcome = await post({
  jsonrpc: "2.0",
  id: 4,
  method: "tools/call",
  params: {
    name: "router_record_outcome",
    arguments: {
      request_id: payload.request_id,
      success: true,
      quality_score: 0.9,
      evaluator_type: "test",
    },
  },
});
const outcomePayload = JSON.parse(outcome.result.content[0].text);
assert.equal(outcomePayload.outcome.success, true);

const execution = await post({
  jsonrpc: "2.0",
  id: 5,
  method: "tools/call",
  params: {
    name: "router_execute_request",
    arguments: {
      prompt: "Extract transaction rows, debits, credits, dates, descriptions, and balances from this bank statement PDF",
      step_type: "bank_statement_extraction",
      dry_run: true,
      record_outcome: true,
    },
  },
});
const executionPayload = JSON.parse(execution.result.content[0].text);
assert.equal(executionPayload.execution.dry_run, true);

console.log("HTTP MCP smoke test passed.");
