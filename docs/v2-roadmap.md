# v2 roadmap — what is not built yet

This file documents features that are intentionally deferred from v1.
Do not build these until the v1 design partner data tells you which ones matter.

---

## Persistent decision log

**Current state:** in-memory ring buffer, max 10,000 entries, resets on server restart.

**v2:** write every `RoutingDecision` to Postgres (structured queries) and
ClickHouse (time-series analytics). The ring buffer becomes a write-through
cache — decisions are written to the buffer and the DB in the same call.

**Why deferred:** adds operational complexity (DB connection, migrations,
backfill) before you know what queries matter. Get real traffic first.

**When to add:** once you have design partner deployments and need routing
history to survive restarts, or once the dashboard needs real historical data.

**Implementation hint:** add a `DecisionStore` interface with `write(decision)`
and `query(filters)` methods. The in-memory store implements it now. Swap to
Postgres/ClickHouse by implementing the same interface and injecting it.

---

## Persistent trajectory store

**Current state:** `trajectoryStore` is a `Map<string, TrajectoryState>` in
`routingEngine.ts`. Resets on server restart.

**v2:** move to Redis with a TTL (e.g. 24 hours). Trajectories survive restarts
and are accessible across multiple router instances for horizontal scaling.

**Why deferred:** single-instance is fine for v1. Redis adds an infra dependency.

**When to add:** when you need to scale to multiple router instances, or when
agents run sessions that span longer than a server uptime window.

---

## Learned task classifier

**Current state:** keyword heuristic classifier in `classifyTask()` in
`routingEngine.ts`. 14 regex patterns, fast, no model inference needed.

**v2:** replace with a fine-tuned ModernBERT or DistilBERT classifier trained
on your design partners' real traffic. Serves in ~5–10ms. Handles negation,
context, and multi-intent queries the keyword approach misses.

**Why deferred:** you need labelled training data (prompt → task type pairs)
from real usage before training is worthwhile. The keyword classifier is good
enough for v1 and generates the labelled data automatically.

**When to add:** once you have 50k+ routing decisions logged and can sample
a labelled training set. RouteLLM's training pipeline is a good starting point.

---

## RLAIF routing table updates

**Current state:** routing weights (tier preferences, quality scores) are static
constants in the model catalog.

**v2:** the Eval Agent's CORRECT/RETRY/INCORRECT verdicts feed back into a
per-customer routing table. If Eval Agent consistently rejects a model for a
given document class, the router down-weights that model for that class in
future calls.

**Why deferred:** requires the Eval Agent to be built first (separate component),
and requires enough verdict volume to make the signal reliable.

**When to add:** after the Eval Agent ships and you have >1k verdicts per
customer per model/doc-class combination.

---

## Near-duplicate semantic cache (Layer 2)

**Current state:** no caching layer. The router makes a routing decision;
the agent calls the model; no extraction results are stored.

**v2 Layer 1:** Redis exact-match cache keyed on `SHA256(image_dHash + query_intent_hash)`.
Write on CORRECT verdict only. Sub-millisecond lookup.

**v2 Layer 2:** CLIP or similar visual embedding model for near-duplicate
matching. The same invoice arriving as a re-scan or JPEG re-export hits the
near-duplicate cache rather than triggering a new extraction.

**Why deferred:** the cache belongs with the Eval Agent (it writes on CORRECT
verdict). Build the Eval Agent first, then bolt on the cache.

**When to add:** after the Eval Agent ships, start with Layer 1 only. Add
Layer 2 once Layer 1 hit rate data from design partners tells you how much
near-duplicate traffic exists.

---

## Streaming routing decision

**Current state:** routing is synchronous. The agent waits for the routing
decision, then starts the LLM call.

**v2:** the router streams the routing decision ahead of the streamed LLM
response. The agent can start rendering before the full model output arrives.

**Why deferred:** adds significant complexity to the transport layer. Not
needed until latency becomes a competitive issue.

---

## Per-tenant policy management UI

**Current state:** policies are set per-request in JSON. No persistent policy
store. No UI.

**v2:** a policy store (Postgres) with a management API and a lightweight UI.
Tenants define default policies (strategy, compliance requirements, cost
ceilings, budget per trajectory) that apply to all their agents without
passing policy on every request.

**Why deferred:** JSON policies per-request are fine for design partners.
The UI becomes necessary once you have >5 paying tenants.

---

## Multi-instance horizontal scaling

**Current state:** single-instance only. Trajectory state is local to one
process.

**v2:** move trajectory state to Redis (see above). Add a load balancer in
front of N router instances. Each instance reads/writes the shared Redis store.

**Why deferred:** single-instance handles thousands of requests per second.
You will not need horizontal scaling until you have meaningful production traffic.

---

## Webhook / event streaming for routing decisions

**Current state:** decisions are only accessible via `router_get_stats` polling.

**v2:** emit routing decisions to a webhook URL or event stream (Server-Sent
Events). Enables the dashboard to update in real time without polling, and
allows downstream systems (alerting, billing) to react to routing events.

**Why deferred:** polling is fine for v1. Real-time streaming is a nice-to-have
until customers ask for it.

---

## Evaluation harness

**Current state:** no systematic way to test routing quality across a benchmark
dataset.

**v2:** a CLI tool that takes a JSONL file of `{ prompt, expected_task_type,
expected_tier }` rows and scores the router's decisions against ground truth.
Plugs into CI/CD to catch regressions when the classifier or scoring logic changes.

**Why deferred:** you do not have a labelled benchmark dataset yet. Build it
from real traffic first.
