import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { DeterministicEvalResult, DocumentProfile, TaskType, V2LearningEvent } from "../types.js";
import { withSupabaseDb } from "./supabaseDb.js";

const eventDir = process.env.V2_EVENT_DIR || path.join(process.cwd(), ".docrouter", "v2-events");
const eventPath = path.join(eventDir, "events.jsonl");

export function logV2Event(event: Omit<V2LearningEvent, "id" | "timestamp">) {
  const fullEvent: V2LearningEvent = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    ...event,
  };
  fs.mkdirSync(eventDir, { recursive: true });
  fs.appendFileSync(eventPath, `${JSON.stringify(fullEvent)}\n`);
  void mirrorEvent(fullEvent).catch((error) => console.error("Failed to mirror V2 event:", error));
  return fullEvent;
}

export function evaluateExtraction({
  taskType,
  documentProfile,
  extraction,
}: {
  taskType: TaskType;
  documentProfile?: DocumentProfile;
  extraction: Record<string, unknown>;
}): DeterministicEvalResult {
  const checks: DeterministicEvalResult["checks"] = [];

  if (taskType === "invoice_extraction") {
    addCheck(checks, "vendor_present", Boolean(extraction.vendor), 0.12, "Vendor field must be present.");
    addCheck(checks, "invoice_number_present", Boolean(extraction.invoice_number), 0.12, "Invoice number must be present.");
    addCheck(checks, "total_present", isNumber(extraction.total), 0.18, "Total must be numeric.");
    const subtotal = Number(extraction.subtotal || 0);
    const tax = Number(extraction.tax || 0);
    const fees = Number(extraction.fees || 0);
    const discount = Number(extraction.discount || 0);
    const total = Number(extraction.total || 0);
    addCheck(checks, "invoice_total_math", isClose(subtotal + tax + fees - discount, total), 0.28, "subtotal + tax + fees - discount must equal total.");
    const lineItems = Array.isArray(extraction.line_items) ? extraction.line_items : [];
    const lineSum = lineItems.reduce((sum, item: any) => sum + Number(item.amount || 0), 0);
    addCheck(checks, "line_items_match_subtotal", !lineItems.length || isClose(lineSum, subtotal), 0.2, "sum(line_items.amount) should equal subtotal.");
    addCheck(checks, "date_present", Boolean(extraction.invoice_date || extraction.date), 0.1, "Invoice date should be present.");
  } else if (taskType === "bank_statement_extraction") {
    const opening = Number(extraction.opening_balance || 0);
    const closing = Number(extraction.closing_balance || 0);
    const transactions = Array.isArray(extraction.transactions) ? extraction.transactions : [];
    const credits = transactions.reduce((sum, tx: any) => sum + Math.max(0, Number(tx.amount || 0)), 0);
    const debits = transactions.reduce((sum, tx: any) => sum + Math.abs(Math.min(0, Number(tx.amount || 0))), 0);
    addCheck(checks, "opening_balance_present", isNumber(extraction.opening_balance), 0.12, "Opening balance must be numeric.");
    addCheck(checks, "closing_balance_present", isNumber(extraction.closing_balance), 0.12, "Closing balance must be numeric.");
    addCheck(checks, "transactions_present", transactions.length > 0, 0.18, "At least one transaction row must be extracted.");
    addCheck(checks, "transaction_rows_complete", transactions.every((tx: any) => tx.date && tx.description && isNumber(tx.amount)), 0.2, "Each transaction needs date, description, and numeric amount.");
    addCheck(checks, "balance_reconciles", !transactions.length || isClose(opening + credits - debits, closing), 0.28, "opening + credits - debits must equal closing.");
    addCheck(checks, "account_digits_present", Boolean(extraction.account_last4 || extraction.account_number), 0.1, "Account identifier should be present.");
  } else {
    addCheck(checks, "schema_not_empty", Object.keys(extraction).length > 0, 0.4, "Extraction JSON should not be empty.");
    addCheck(checks, "document_type_consistent", Boolean(documentProfile?.document_type), 0.2, "Document type should be known.");
    addCheck(checks, "has_required_payload", JSON.stringify(extraction).length > 40, 0.4, "Extraction should contain enough structured content.");
  }

  const totalWeight = checks.reduce((sum, check) => sum + check.weight, 0);
  const passedWeight = checks.filter((check) => check.passed).reduce((sum, check) => sum + check.weight, 0);
  const qualityScore = totalWeight ? Math.round((passedWeight / totalWeight) * 10000) / 10000 : 0;
  const errors = checks.filter((check) => !check.passed && check.weight >= 0.18).map((check) => check.detail);
  const warnings = checks.filter((check) => !check.passed && check.weight < 0.18).map((check) => check.detail);
  return {
    validationPassed: qualityScore >= 0.82 && errors.length === 0,
    qualityScore,
    errors,
    warnings,
    checks,
  };
}

export function getV2LearningSummary({ userId }: { userId?: string } = {}) {
  const events = readLocalEvents();
  return {
    global: summarizeFeedback(events),
    user: userId ? summarizeFeedback(events.filter((event) => event.userId === userId)) : [],
    recent_events: events.slice(-25).reverse().map((event) => ({
      id: event.id,
      timestamp: event.timestamp,
      eventType: event.eventType,
      userId: event.userId,
      modelId: event.modelId,
      taskType: event.taskType,
      requestId: event.requestId,
    })),
  };
}

function addCheck(checks: DeterministicEvalResult["checks"], name: string, passed: boolean, weight: number, detail: string) {
  checks.push({ name, passed, weight, detail });
}

function isNumber(value: unknown) {
  return value !== null && value !== undefined && Number.isFinite(Number(value));
}

function isClose(a: number, b: number) {
  return Math.abs(a - b) <= Math.max(0.02, Math.abs(b) * 0.005);
}

async function mirrorEvent(event: V2LearningEvent) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    await withSupabaseDb((client) => client.query(
      `insert into public.docrouter_v2_events
        (id, session_id, user_id, event_type, request_id, model_id, task_type, document_profile, extraction_instruction, payload, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       on conflict (id) do nothing`,
      [
        event.id,
        event.sessionId,
        event.userId || null,
        event.eventType,
        event.requestId || null,
        event.modelId || null,
        event.taskType || null,
        event.documentProfile || null,
        event.extractionInstruction || null,
        event.payload || {},
        event.timestamp,
      ],
    ));
    return;
  }
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await supabase.from("docrouter_v2_events").insert({
    id: event.id,
    session_id: event.sessionId,
    user_id: event.userId || null,
    event_type: event.eventType,
    request_id: event.requestId || null,
    model_id: event.modelId || null,
    task_type: event.taskType || null,
    document_profile: event.documentProfile || null,
    extraction_instruction: event.extractionInstruction || null,
    payload: event.payload || {},
    created_at: event.timestamp,
  });
  if (error) throw error;
}

function readLocalEvents(): V2LearningEvent[] {
  try {
    if (!fs.existsSync(eventPath)) return [];
    return fs.readFileSync(eventPath, "utf8")
      .split(/\n+/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as V2LearningEvent);
  } catch (error) {
    console.error("Failed to read V2 learning events:", error);
    return [];
  }
}

function summarizeFeedback(events: V2LearningEvent[]) {
  const rows = new Map<string, {
    modelId: string;
    taskType: string;
    feedbackCount: number;
    happyCount: number;
    notHappyCount: number;
    avgEvalQuality: number;
    evalSamples: number;
    lastSeenAt?: string;
  }>();

  for (const event of events) {
    if (!event.modelId) continue;
    const key = `${event.modelId}::${event.taskType || "unknown"}`;
    const row = rows.get(key) || {
      modelId: event.modelId,
      taskType: event.taskType || "unknown",
      feedbackCount: 0,
      happyCount: 0,
      notHappyCount: 0,
      avgEvalQuality: 0,
      evalSamples: 0,
    };
    if (event.eventType === "feedback_happy" || event.eventType === "feedback_not_happy") {
      row.feedbackCount += 1;
      if (event.eventType === "feedback_happy") row.happyCount += 1;
      else row.notHappyCount += 1;
    }
    const quality = Number((event.payload?.evaluation as any)?.qualityScore);
    if (Number.isFinite(quality)) {
      row.evalSamples += 1;
      row.avgEvalQuality = ((row.avgEvalQuality * (row.evalSamples - 1)) + quality) / row.evalSamples;
    }
    row.lastSeenAt = event.timestamp;
    rows.set(key, row);
  }

  return Array.from(rows.values())
    .map((row) => ({
      ...row,
      happyRate: row.feedbackCount ? Math.round((row.happyCount / row.feedbackCount) * 10000) / 10000 : null,
      avgEvalQuality: row.evalSamples ? Math.round(row.avgEvalQuality * 10000) / 10000 : null,
    }))
    .sort((a, b) => (b.feedbackCount - a.feedbackCount) || ((b.happyRate || 0) - (a.happyRate || 0)));
}
