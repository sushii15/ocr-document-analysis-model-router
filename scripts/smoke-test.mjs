import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const child = spawn(process.execPath, ["dist/index.js"], {
  env: { ...process.env, ROUTER_PERSISTENCE: "memory" },
  stdio: ["pipe", "pipe", "pipe"],
});
let buffer = "";
const pending = new Map();

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    const resolver = pending.get(message.id);
    if (resolver) {
      pending.delete(message.id);
      resolver(message);
    }
  }
});

child.stderr.on("data", (chunk) => process.stderr.write(chunk));

function send(message) {
  return new Promise((resolve) => {
    pending.set(message.id, resolve);
    child.stdin.write(`${JSON.stringify(message)}\n`);
  });
}

const init = await send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "1.0.0" },
  },
});
assert.equal(init.result.serverInfo.name, "llm-router-mcp-server");

child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);

const tools = await send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
const names = tools.result.tools.map((tool) => tool.name);
for (const name of [
  "router_route_request",
  "router_execute_request",
  "router_list_models",
  "router_get_trajectory",
  "router_get_stats",
  "router_estimate_cost",
  "router_record_outcome",
  "router_get_learned_scores",
]) {
  assert.ok(names.includes(name), `missing tool ${name}`);
}

const route = await send({
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: {
    name: "router_route_request",
    arguments: {
      prompt: "Extract all vendor fields, invoice number, line items, subtotal, tax, and amount due from this scanned invoice PDF",
      step_type: "invoice_extraction",
      trajectory_id: "smoke-traj",
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
const routePayload = JSON.parse(route.result.content[0].text);
assert.equal(routePayload.detected_task_type, "invoice_extraction");
assert.ok(["small", "mid", "frontier"].includes(routePayload.selected_model.tier));
assert.equal(routePayload.document_difficulty.complexity, "low");

const trajectory = await send({
  jsonrpc: "2.0",
  id: 4,
  method: "tools/call",
  params: { name: "router_get_trajectory", arguments: { trajectory_id: "smoke-traj" } },
});
const trajectoryPayload = JSON.parse(trajectory.result.content[0].text);
assert.equal(trajectoryPayload.stepCount, 1);

const outcome = await send({
  jsonrpc: "2.0",
  id: 5,
  method: "tools/call",
  params: {
    name: "router_record_outcome",
    arguments: {
      request_id: routePayload.request_id,
      success: true,
      validation_passed: true,
      quality_score: 0.94,
      actual_latency_ms: 720,
      actual_cost_usd: routePayload.estimated_cost_usd,
      evaluator_type: "test",
    },
  },
});
const outcomePayload = JSON.parse(outcome.result.content[0].text);
assert.equal(outcomePayload.outcome.success, true);

const learned = await send({
  jsonrpc: "2.0",
  id: 6,
  method: "tools/call",
  params: { name: "router_get_learned_scores", arguments: { task_type: "invoice_extraction" } },
});
const learnedPayload = JSON.parse(learned.result.content[0].text);
assert.equal(learnedPayload.scores.length, 1);
assert.equal(learnedPayload.scores[0].sampleCount, 1);

const execution = await send({
  jsonrpc: "2.0",
  id: 7,
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
assert.ok(executionPayload.decision.request_id);

const hardStatement = await send({
  jsonrpc: "2.0",
  id: 8,
  method: "tools/call",
  params: {
    name: "router_route_request",
    arguments: {
      prompt: "Extract transaction history, running balances, debits, credits, descriptions, dates, and closing balance from this statement.",
      step_type: "bank_statement_extraction",
      document_profile: {
        file_type: "pdf",
        page_count: 32,
        character_count: 85000,
        has_text_layer: false,
        text_layer_quality: "none",
        document_type: "bank_statement",
        source_institution: "Bank of America",
        known_layout_id: "bank-of-america.statement.v1",
        image_quality: "medium",
        layout_complexity: "table_heavy",
        has_tables: true,
        table_count: 12,
        table_density: 0.78,
        requires_reconciliation: true,
        contains_financial_data: true,
      },
    },
  },
});
const hardStatementPayload = JSON.parse(hardStatement.result.content[0].text);
assert.equal(hardStatementPayload.detected_task_type, "bank_statement_extraction");
assert.equal(hardStatementPayload.document_difficulty.complexity, "high");
assert.ok(["frontier", "mid"].includes(hardStatementPayload.selected_model.tier));

child.stdin.end();
child.kill();
console.log("MCP smoke test passed.");
