import express from "express";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerRoutingTools } from "./tools/routingTools.js";
import { handleJsonRpc } from "./httpRpc.js";
import { listProviderCredentials, saveProviderCredential } from "./services/credentialStore.js";
import { ensureUploadDir, runV2Extraction } from "./services/v2Pipeline.js";
import { getV2LearningSummary, logV2Event } from "./services/v2Learning.js";
import { recordOutcome } from "./services/routingEngine.js";
import { getUserOnboardingProfile, saveUserOnboardingProfile } from "./services/userProfileStore.js";
import { resolveUserId } from "./services/authService.js";
import { updateDocumentIntelligenceFeedback } from "./services/documentIntelligence.js";

const version = "1.0.0";

function createServer() {
  const server = new McpServer({
    name: "llm-router-mcp-server",
    version,
  });
  registerRoutingTools(server);
  return server;
}

async function main() {
  const transport = process.env.TRANSPORT || "stdio";
  if (transport === "http") {
    await startHttp();
    return;
  }

  const server = createServer();
  await server.connect(new StdioServerTransport());
}

async function startHttp() {
  const app = express();
  const port = Number(process.env.PORT || 3100);
  const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
  const upload = multer({
    dest: ensureUploadDir(),
    limits: { fileSize: Number(process.env.V2_MAX_UPLOAD_BYTES || 25 * 1024 * 1024) },
  });
  const rateLimitWindowMs = Number(process.env.RATE_LIMIT_WINDOW_MS || 60000);
  const rateLimitMax = Number(process.env.RATE_LIMIT_MAX || 0);
  const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();

  app.use(express.json({ limit: "2mb" }));
  app.use((req, res, next) => {
    if (!rateLimitMax || req.path === "/health") return next();
    const key = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const bucket = rateLimitBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      rateLimitBuckets.set(key, { count: 1, resetAt: now + rateLimitWindowMs });
      return next();
    }
    bucket.count += 1;
    if (bucket.count > rateLimitMax) return res.status(429).json({ error: "rate_limit_exceeded" });
    return next();
  });
  app.use((req, res, next) => {
    const expected = process.env.ROUTER_API_KEY;
    if (!expected || req.path === "/health" || req.path.startsWith("/api/v2/")) return next();
    const bearer = req.header("authorization")?.replace(/^Bearer\s+/i, "");
    const headerKey = req.header("x-router-api-key");
    if (bearer === expected || headerKey === expected) return next();
    return res.status(401).json({ error: "unauthorized" });
  });
  app.use(express.static(publicDir));

  app.get("/", (_req, res) => {
    res.redirect("/dashboard.html");
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", server: "llm-router-mcp-server", version });
  });

  app.get("/api/v2/config", (_req, res) => {
    res.json({
      supabaseUrl: process.env.SUPABASE_URL || null,
      supabasePublishableKey: process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || null,
      authRequired: process.env.AUTH_REQUIRED === "true",
    });
  });

  app.post("/mcp", async (req, res) => {
    const response = await handleJsonRpc(req.body);
    if (response === null) res.status(202).end();
    else res.json(response);
  });

  app.get("/api/v2/provider-credentials", async (req, res) => {
    const userId = await resolveUserId(req, optionalString(req.query.user_id));
    res.json({
      credentials: listProviderCredentials(String(req.query.session_id || ""), userId),
    });
  });

  app.get("/api/v2/onboarding", async (req, res) => {
    const userId = await resolveUserId(req, optionalString(req.query.user_id));
    if (!userId) return res.status(400).json({ error: "user_id is required" });
    return res.json({ profile: getUserOnboardingProfile(userId) || null });
  });

  app.post("/api/v2/onboarding", async (req, res) => {
    try {
      const body = req.body || {};
      const userId = await resolveUserId(req, optionalString(body.user_id));
      if (!userId) return res.status(400).json({ error: "user_id is required" });
      const profile = await saveUserOnboardingProfile({
        userId,
        displayName: optionalString(body.display_name),
        defaultStrategy: body.default_strategy || "balanced",
        modelPreferences: Array.isArray(body.model_preferences) ? body.model_preferences : [],
      });
      await logV2Event({
        sessionId: requiredString(body.session_id, "session_id"),
        userId,
        eventType: "model_pool_saved",
        payload: {
          default_strategy: profile.defaultStrategy,
          enabled_models: profile.modelPreferences.filter((pref) => pref.enabled).map((pref) => pref.modelId),
        },
      });
      return res.json({ profile });
    } catch (error) {
      return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/v2/provider-credentials", async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.session_id || !body.provider || !body.api_key) {
        return res.status(400).json({ error: "session_id, provider, and api_key are required" });
      }
      const userId = await resolveUserId(req, optionalString(body.user_id));
      const credential = await saveProviderCredential({
        sessionId: String(body.session_id),
        userId,
        provider: body.provider,
        apiKey: String(body.api_key),
        baseUrl: optionalString(body.base_url),
      });
      await logV2Event({
        sessionId: String(body.session_id),
        userId,
        eventType: "provider_configured",
        payload: {
          provider: credential.provider,
          has_api_key: credential.hasApiKey,
          has_base_url: credential.hasBaseUrl,
        },
      });
      return res.json({ credential });
    } catch (error) {
      return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/v2/extract", upload.single("document"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "document file is required" });
      const body = req.body || {};
      const userId = await resolveUserId(req, optionalString(body.user_id));
      const result = await runV2Extraction({
        sessionId: requiredString(body.session_id, "session_id"),
        userId,
        instruction: requiredString(body.instruction, "instruction"),
        documentProfile: parseJsonField(body.document_profile, {}),
        allowedModels: parseJsonField(body.allowed_models, []),
        policy: parseJsonField(body.policy, {}),
        dryRun: body.dry_run === "true" || body.dry_run === true,
        file: {
          path: req.file.path,
          originalName: req.file.originalname,
          mimeType: req.file.mimetype,
          size: req.file.size,
        },
      });
      return res.json(result);
    } catch (error) {
      return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/v2/feedback", async (req, res) => {
    try {
      const body = req.body || {};
      const happy = Boolean(body.happy);
      const sessionId = requiredString(body.session_id, "session_id");
      const userId = await resolveUserId(req, optionalString(body.user_id));
      await logV2Event({
        sessionId,
        userId,
        eventType: happy ? "feedback_happy" : "feedback_not_happy",
        requestId: requiredString(body.request_id, "request_id"),
        modelId: optionalString(body.model_id),
        taskType: optionalString(body.task_type) as any,
        extractionInstruction: optionalString(body.extraction_instruction),
        payload: body.payload || {},
      });
      await updateDocumentIntelligenceFeedback(
        optionalString(body.upload_id) || optionalString(body.run_id) || optionalString((body.payload || {}).upload_id),
        happy ? "happy" : "not_happy",
      );
      const outcome = recordOutcome({
        request_id: String(body.request_id),
        success: happy,
        validation_passed: body.validation_passed,
        needed_escalation: !happy,
        quality_score: body.quality_score,
        actual_cost_usd: body.actual_cost_usd,
        actual_latency_ms: body.actual_latency_ms,
        evaluator_type: "human",
        notes: happy ? "User accepted V2 extraction." : "User rejected V2 extraction.",
        metadata: body.payload || {},
      });
      return res.json({ outcome });
    } catch (error) {
      return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/v2/learning", async (req, res) => {
    const userId = await resolveUserId(req, optionalString(req.query.user_id));
    res.json(getV2LearningSummary({ userId }));
  });

  app.get("/mcp", async (req, res) => {
    res.status(405).send("This v1 HTTP transport uses JSON-RPC POST.");
  });

  app.delete("/mcp", (_req, res) => res.status(405).send("No stateful session to delete."));

  app.listen(port, () => {
    console.error(`LLM Router MCP server running on http://localhost:${port}/mcp`);
    console.error(`Cost dashboard: http://localhost:${port}/dashboard.html`);
    console.error(`Health check: http://localhost:${port}/health`);
  });
}

function optionalString(value: unknown) {
  const stringValue = typeof value === "string" ? value.trim() : "";
  return stringValue || undefined;
}

function requiredString(value: unknown, field: string) {
  const stringValue = optionalString(value);
  if (!stringValue) throw new Error(`${field} is required`);
  return stringValue;
}

function parseJsonField<T>(value: unknown, fallback: T): T {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error("Invalid JSON multipart field");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
