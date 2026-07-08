import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-router-state-"));

async function startServer() {
  const child = spawn(process.execPath, ["dist/index.js"], {
    env: {
      ...process.env,
      TRANSPORT: "http",
      PORT: "3199",
      ROUTER_PERSISTENCE: "file",
      ROUTER_STATE_DIR: stateDir,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  await waitForHealth();
  return child;
}

async function waitForHealth() {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    try {
      const response = await fetch("http://127.0.0.1:3199/health");
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Timed out waiting for HTTP server");
}

async function post(body) {
  const response = await fetch("http://127.0.0.1:3199/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.json();
}

function stop(child) {
  return new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill();
    setTimeout(resolve, 1000);
  });
}

let child = await startServer();
const route = await post({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: {
    name: "router_route_request",
    arguments: {
      prompt: "Extract all invoice line items, vendor fields, tax, subtotal, and amount due from this scanned invoice PDF",
      step_type: "invoice_extraction",
      trajectory_id: "persist-traj",
    },
  },
});
const routePayload = JSON.parse(route.result.content[0].text);
await post({
  jsonrpc: "2.0",
  id: 4,
  method: "tools/call",
  params: {
    name: "router_record_outcome",
    arguments: {
      request_id: routePayload.request_id,
      success: true,
      validation_passed: true,
      quality_score: 0.92,
      evaluator_type: "test",
    },
  },
});
await stop(child);

child = await startServer();
const stats = await post({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: { name: "router_get_stats", arguments: { limit: 10 } },
});
const statsPayload = JSON.parse(stats.result.content[0].text);
assert.equal(statsPayload.total_requests, 1);

const trajectory = await post({
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: { name: "router_get_trajectory", arguments: { trajectory_id: "persist-traj" } },
});
const trajectoryPayload = JSON.parse(trajectory.result.content[0].text);
assert.equal(trajectoryPayload.stepCount, 1);

const learned = await post({
  jsonrpc: "2.0",
  id: 5,
  method: "tools/call",
  params: { name: "router_get_learned_scores", arguments: { task_type: "invoice_extraction" } },
});
const learnedPayload = JSON.parse(learned.result.content[0].text);
assert.equal(learnedPayload.scores.length, 1);
assert.equal(learnedPayload.scores[0].sampleCount, 1);

await stop(child);
fs.rmSync(stateDir, { recursive: true, force: true });
console.log("Persistence smoke test passed.");
