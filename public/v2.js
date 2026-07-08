const providers = [
  { id: "openai", name: "OpenAI" },
  { id: "anthropic", name: "Anthropic" },
  { id: "google", name: "Google Gemini" },
  { id: "mistral", name: "Mistral" },
  { id: "deepseek", name: "DeepSeek" },
  { id: "meta", name: "Self-hosted Meta" },
  { id: "qwen", name: "Self-hosted Qwen" },
];

const extractionPresets = {
  bank_statement: [
    "Account holder name",
    "Account number last four",
    "Bank name / source institution",
    "Statement period start and end",
    "Opening balance",
    "Closing balance",
    "All transaction rows",
    "Transaction dates",
    "Transaction descriptions",
    "Transaction amounts with debit/credit direction",
    "Deposits / credits total",
    "Withdrawals / debits total",
    "Fees and charges",
    "Balance reconciliation check",
    "Confidence score per field",
  ],
  invoice: [
    "Vendor name",
    "Vendor address",
    "Invoice number",
    "Invoice date",
    "Due date",
    "Customer / bill-to name",
    "Line items",
    "Subtotal",
    "Tax",
    "Discounts / fees",
    "Total amount due",
    "Payment terms",
    "Purchase order number",
    "Currency",
    "Confidence score per field",
  ],
};

const state = {
  sessionId: localStorage.getItem("docrouter_v2_session") || crypto.randomUUID(),
  supabase: null,
  accessToken: null,
  authRequired: false,
  models: [],
  enabledProviders: new Set(),
  selectedModelIds: new Set(),
  documentProfile: null,
  decision: null,
  currentRankIndex: 0,
  currentExtraction: null,
  currentEvaluation: null,
  currentRun: null,
  events: [],
  activePresetType: "bank_statement",
};

localStorage.setItem("docrouter_v2_session", state.sessionId);

const $ = (id) => document.getElementById(id);
const fmtUsd = (value) => `$${Number(value || 0).toFixed(value > 0.01 ? 4 : 6)}`;

init().catch((error) => {
  console.error(error);
  addEvent("ui_error", { message: error.message });
});

async function init() {
  $("sessionId").textContent = state.sessionId;
  $("userId").value = localStorage.getItem("docrouter_v2_user") || "";
  $("instruction").value = "Extract the key fields, tables, totals, dates, and confidence scores needed to review this document.";
  bindEvents();
  syncDocTypeWithPreset();
  await initAuth();
  renderProviders();
  renderPresetFields();
  await loadModels();
  await loadOnboardingProfile();
  applyDefaultModelPool();
  renderProviders();
  renderModelPool();
  if (new URLSearchParams(location.search).has("demo")) loadDemoScenario();
}

function bindEvents() {
  $("docFile").addEventListener("change", updateFileMeta);
  $("userId").addEventListener("input", () => localStorage.setItem("docrouter_v2_user", $("userId").value.trim()));
  $("userId").addEventListener("change", async () => {
    await loadOnboardingProfile();
    renderProviders();
    renderModelPool();
  });
  $("savePoolBtn").addEventListener("click", saveModelPool);
  $("preflightBtn").addEventListener("click", runPreflight);
  $("recommendBtn").addEventListener("click", recommendModel);
  $("simulateBtn").addEventListener("click", simulateExtraction);
  $("applyPresetsBtn").addEventListener("click", applyPresetInstruction);
  document.querySelectorAll("[data-preset-type]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activePresetType = button.dataset.presetType;
      document.querySelectorAll("[data-preset-type]").forEach((candidate) => candidate.classList.toggle("active", candidate === button));
      renderPresetFields();
      syncDocTypeWithPreset();
    });
  });
  $("happyBtn").addEventListener("click", () => recordFeedback(true));
  $("notHappyBtn").addEventListener("click", () => recordFeedback(false));
  $("signInBtn").addEventListener("click", signIn);
  $("signUpBtn").addEventListener("click", signUp);
  $("signOutBtn").addEventListener("click", signOut);
  $("resetSessionBtn").addEventListener("click", () => {
    localStorage.removeItem("docrouter_v2_session");
    location.reload();
  });
}

function renderPresetFields() {
  const fields = extractionPresets[state.activePresetType] || [];
  $("presetFields").innerHTML = fields.map((field, index) => `
    <label class="preset-chip">
      <input type="checkbox" data-preset-field="${field}" ${index < 10 ? "checked" : ""} />
      <span>${field}</span>
    </label>
  `).join("");
}

function selectedPresetFields() {
  return [...document.querySelectorAll("[data-preset-field]:checked")].map((input) => input.dataset.presetField);
}

function applyPresetInstruction() {
  const fields = selectedPresetFields();
  const docLabel = state.activePresetType === "bank_statement" ? "bank statement" : "invoice";
  const instruction = [
    `Extract the following ${docLabel} fields from the OCR text and document image/profile:`,
    ...fields.map((field) => `- ${field}`),
    "",
    "Return strict JSON only. Use null for missing fields. Include confidence values where possible.",
    state.activePresetType === "bank_statement"
      ? "For transactions, return an array with date, description, amount, debit_credit, and running_balance when visible. Also verify opening balance + credits - debits = closing balance."
      : "For line items, return an array with description, quantity, unit_price, amount, and confidence when visible. Also verify subtotal + tax + fees - discounts = total.",
  ].join("\n");
  $("instruction").value = instruction;
}

function applyDefaultModelPool() {
  if (state.enabledProviders.size || state.selectedModelIds.size) return;
  state.enabledProviders = new Set(["openai", "google", "mistral", "anthropic"]);
  state.selectedModelIds = new Set(["gpt-4o-mini", "gemini-2.0-flash", "mistral-small-3.1", "claude-haiku-4-5"]);
}

function syncDocTypeWithPreset() {
  if (state.activePresetType === "bank_statement") $("docType").value = "bank_statement";
  if (state.activePresetType === "invoice") $("docType").value = "invoice";
}

function loadDemoScenario() {
  $("userId").value = "github-demo";
  $("sourceInstitution").value = "Sample Bank";
  $("fileMeta").textContent = "sample-bank-statement-export.pdf | demo document";
  $("pageCount").value = 8;
  $("characterCount").value = 12000;
  $("layoutComplexity").value = "table_heavy";
  $("tableDensity").value = 0.55;
  $("hasTables").checked = true;
  $("requiresRecon").checked = true;
  applyPresetInstruction();
  state.enabledProviders = new Set(["openai", "anthropic", "google", "mistral"]);
  state.selectedModelIds = new Set(["gpt-4o-mini", "claude-haiku-4-5", "gemini-2.0-flash", "mistral-small-3.1"]);
  renderProviders();
  renderModelPool();
  state.documentProfile = buildDocumentProfile();
  state.decision = {
    request_id: "demo-request",
    selected_model: { id: "gpt-4o-mini", name: "GPT-4o Mini", provider: "openai", tier: "nano" },
    estimated_input_tokens: 5338,
    estimated_output_tokens: 1684,
    document_difficulty: { level: "medium", score: 0.54 },
    recommended_models: [
      demoModel("gpt-4o-mini", "GPT-4o Mini", "openai", "nano", 0.0018, 0.81, 0.91, 0.97, 0.84),
      demoModel("gemini-2.0-flash", "Gemini 2.0 Flash", "google", "nano", 0.0012, 0.79, 0.94, 0.98, 0.82),
      demoModel("claude-haiku-4-5", "Claude Haiku 4.5", "anthropic", "nano", 0.011, 0.83, 0.88, 0.78, 0.8),
      demoModel("mistral-small-3.1", "Mistral Small 3.1", "mistral", "small", 0.001, 0.76, 0.87, 0.99, 0.77),
    ],
  };
  state.currentRankIndex = 0;
  state.currentRun = {
    execution: { dryRun: true },
    ocr: { engine: "pdf-text-layer + tesseract fallback", warnings: ["Demo recording mode."] },
  };
  const extraction = {
    account_holder_name: "Sasha Sam",
    account_last4: "5657",
    bank_name: "Sample Bank",
    statement_period: "2026-06-01 to 2026-06-30",
    opening_balance: 1200,
    closing_balance: 1330,
    deposits_credits_total: 500,
    withdrawals_debits_total: 370,
    fees_and_charges: 0,
    reconciliation_status: "passed",
    confidence: 0.92,
    transactions: [
      { date: "2026-06-02", description: "ACH deposit", amount: 500, debit_credit: "credit", running_balance: 1700 },
      { date: "2026-06-04", description: "Card payment", amount: 210, debit_credit: "debit", running_balance: 1490 },
      { date: "2026-06-09", description: "Transfer", amount: 160, debit_credit: "debit", running_balance: 1330 },
    ],
  };
  const evaluation = {
    validationPassed: true,
    qualityScore: 0.92,
    checks: [
      { name: "Required fields", passed: true, weight: 0.3, detail: "Account, balance, period, and transaction fields are present." },
      { name: "Balance reconciliation", passed: true, weight: 0.4, detail: "Opening balance + credits - debits equals closing balance." },
      { name: "Transaction structure", passed: true, weight: 0.3, detail: "Rows include date, description, amount, direction, and running balance." },
    ],
  };
  renderRecommendations();
  renderSelectedModel();
  renderEval(extraction, evaluation, state.currentRun);
  addEvent("demo_loaded", { model_id: "gpt-4o-mini" });
}

function demoModel(model_id, name, provider, tier, estimated_cost_usd, quality_score, latency_score, cost_score, score) {
  return {
    model_id,
    name,
    provider,
    tier,
    estimated_cost_usd,
    quality_score,
    latency_score,
    cost_score,
    score,
    cost_per_1k_input_tokens: estimated_cost_usd / 7,
    cost_per_1k_output_tokens: estimated_cost_usd / 3,
  };
}

async function mcp(name, args = {}) {
  const response = await fetch("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call", params: { name, arguments: args } }),
  });
  const json = await response.json();
  if (json.error) throw new Error(json.error.message);
  if (json.result?.isError) throw new Error(json.result.content?.[0]?.text || "MCP call failed");
  return json.result.structuredContent;
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.accessToken) headers.set("authorization", `Bearer ${state.accessToken}`);
  if (options.body && !(options.body instanceof FormData) && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...options, headers });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || `Request failed: ${response.status}`);
  return json;
}

async function initAuth() {
  const configResponse = await fetch("/api/v2/config");
  const config = await configResponse.json();
  state.authRequired = Boolean(config.authRequired);
  if (!config.supabaseUrl || !config.supabasePublishableKey || !window.supabase) {
    $("authStatus").textContent = state.authRequired
      ? "Supabase Auth is required but not configured on this server."
      : "Account optional. Use settings only when saving provider keys.";
    return;
  }
  state.supabase = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey);
  const { data } = await state.supabase.auth.getSession();
  applySession(data.session);
  state.supabase.auth.onAuthStateChange((_event, session) => {
    applySession(session);
    loadOnboardingProfile().then(() => {
      renderProviders();
      renderModelPool();
    }).catch((error) => addEvent("profile_load_failed", { message: error.message }));
  });
}

function applySession(session) {
  state.accessToken = session?.access_token || null;
  const user = session?.user;
  if (user?.id) {
    $("userId").value = user.id;
    $("userId").readOnly = true;
    localStorage.setItem("docrouter_v2_user", user.id);
    $("authStatus").textContent = `Signed in${user.email ? ` as ${user.email}` : ""}.`;
  } else {
    $("userId").readOnly = false;
    $("authStatus").textContent = state.supabase ? "Not signed in. Sign in or use demo user id." : $("authStatus").textContent;
  }
}

async function signIn() {
  if (!state.supabase) return addEvent("auth_unavailable", { message: "Account sign-in is not configured." });
  const email = $("authEmail").value.trim();
  const password = $("authPassword").value;
  const { error } = await state.supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

async function signUp() {
  if (!state.supabase) return addEvent("auth_unavailable", { message: "Account sign-up is not configured." });
  const email = $("authEmail").value.trim();
  const password = $("authPassword").value;
  const { error } = await state.supabase.auth.signUp({ email, password });
  if (error) throw error;
  addEvent("signup_requested", { message: "Check email confirmation settings in Supabase." });
}

async function signOut() {
  if (!state.supabase) return;
  await state.supabase.auth.signOut();
}

async function loadModels() {
  const result = await mcp("router_list_models");
  state.models = result.models || [];
}

async function loadOnboardingProfile() {
  const userId = $("userId").value.trim();
  if (!userId) return;
  try {
    const result = await api(`/api/v2/onboarding?user_id=${encodeURIComponent(userId)}`);
    const profile = result.profile;
    if (!profile) return;
    state.selectedModelIds = new Set(profile.modelPreferences.filter((pref) => pref.enabled).map((pref) => pref.modelId));
    state.enabledProviders = new Set(profile.modelPreferences.filter((pref) => pref.enabled).map((pref) => pref.provider));
    $("strategy").value = profile.defaultStrategy || "balanced";
  } catch (error) {
    addEvent("profile_load_failed", { message: error.message });
  }
}

function renderProviders() {
  $("providerList").innerHTML = providers.map((provider) => `
    <div class="provider-row">
      <label>
        <input type="checkbox" data-provider="${provider.id}" ${state.enabledProviders.has(provider.id) ? "checked" : ""} />
        ${provider.name}
      </label>
      <input type="password" autocomplete="off" data-provider-key="${provider.id}" placeholder="Paste API key to encrypt and save" />
    </div>
  `).join("");

  document.querySelectorAll("[data-provider]").forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) state.enabledProviders.add(input.dataset.provider);
      else state.enabledProviders.delete(input.dataset.provider);
      renderModelPool();
    });
  });
}

function renderModelPool() {
  $("modelPool").innerHTML = state.models.map((model) => {
    const providerEnabled = state.enabledProviders.has(model.provider);
    const checked = providerEnabled && state.selectedModelIds.has(model.id);
    return `
      <div class="model-row ${providerEnabled ? "" : "disabled"}">
        <label>
          <input type="checkbox" data-model="${model.id}" ${checked ? "checked" : ""} ${providerEnabled ? "" : "disabled"} />
          ${model.name}
        </label>
        <small>${model.provider} | ${model.tier} | ${model.hosting} | quality ${model.quality_score} | ${fmtUsd(model.cost_per_1k_input_tokens)}/${fmtUsd(model.cost_per_1k_output_tokens)} per 1k</small>
      </div>
    `;
  }).join("");

  document.querySelectorAll("[data-model]").forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) state.selectedModelIds.add(input.dataset.model);
      else state.selectedModelIds.delete(input.dataset.model);
    });
  });
}

async function saveModelPool() {
  for (const input of document.querySelectorAll("[data-provider-key]")) {
    const apiKey = input.value.trim();
    if (!apiKey) continue;
    state.enabledProviders.add(input.dataset.providerKey);
    await api("/api/v2/provider-credentials", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: state.sessionId,
        user_id: $("userId").value.trim() || undefined,
        provider: providerForCredential(input.dataset.providerKey),
        api_key: apiKey,
      }),
    });
    input.value = "";
    input.placeholder = "Saved";
  }
  renderProviders();
  renderModelPool();
  const selectedModels = [...state.selectedModelIds].filter((id) => state.enabledProviders.has(modelById(id)?.provider));
  const modelPreferences = state.models.map((model, index) => ({
    modelId: model.id,
    provider: model.provider,
    enabled: selectedModels.includes(model.id),
    priority: selectedModels.includes(model.id) ? selectedModels.indexOf(model.id) + 1 : index + 100,
  }));
  if ($("userId").value.trim()) {
    await api("/api/v2/onboarding", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: state.sessionId,
        user_id: $("userId").value.trim(),
        display_name: $("userId").value.trim(),
        default_strategy: $("strategy").value,
        model_preferences: modelPreferences,
      }),
    });
  }
  await logEvent("model_pool_saved", {
    providers_enabled: [...state.enabledProviders],
    selected_models: selectedModels,
    provider_key_presence: providerKeyPresence(),
  });
}

function providerForCredential(provider) {
  if (provider === "meta" || provider === "qwen") return "self_hosted";
  return provider;
}

function providerKeyPresence() {
  return Object.fromEntries([...document.querySelectorAll("[data-provider-key]")].map((input) => [
    input.dataset.providerKey,
    Boolean(input.value.trim()) || state.enabledProviders.has(input.dataset.providerKey),
  ]));
}

function updateFileMeta() {
  const file = $("docFile").files[0];
  if (!file) {
    $("fileMeta").textContent = "No document selected.";
    return;
  }
  $("fileMeta").textContent = `${file.name} | ${(file.size / 1024).toFixed(1)} KB | ${file.type || "unknown type"}`;
  if (file.name.toLowerCase().endsWith(".pdf")) $("pageCount").value = Math.max(1, Number($("pageCount").value || 1));
  if (file.type.startsWith("image/")) {
    $("pageCount").value = 1;
    $("textLayer").value = "none";
  }
}

async function runPreflight() {
  state.documentProfile = buildDocumentProfile();
  $("preflightOutput").innerHTML = `
    <strong>Document profile</strong>
    <div class="metric-line">
      <span>${state.documentProfile.file_type}</span>
      <span>${state.documentProfile.page_count} pages</span>
      <span>${state.documentProfile.document_type}</span>
      <span>${state.documentProfile.layout_complexity}</span>
      <span>table density ${state.documentProfile.table_density}</span>
    </div>
  `;
  await logEvent("document_profiled", { document_profile: state.documentProfile });
}

async function recommendModel() {
  if (!state.documentProfile) await runPreflight();
  const allowedModels = [...state.selectedModelIds].filter((id) => state.enabledProviders.has(modelById(id)?.provider));
  if (!allowedModels.length) {
    $("recommendationOutput").innerHTML = `<div class="notice">Choose at least one model in settings.</div>`;
    return;
  }
  const instruction = $("instruction").value.trim() || "Extract structured fields from this document.";
  const taskType = taskTypeFromProfile(state.documentProfile);
  const prompt = buildPrompt(instruction, state.documentProfile);
  state.decision = await mcp("router_route_request", {
    prompt,
    task_type: taskType,
    document_profile: state.documentProfile,
    estimated_input_tokens: estimateInputTokens(state.documentProfile, instruction),
    estimated_output_tokens: estimateOutputTokens(state.documentProfile, instruction),
    policy: {
      strategy: $("strategy").value,
      maxLatencyMs: Number($("maxLatency").value || 3500),
      minQualityScore: Number($("minQuality").value || 0),
      allowedModels,
    },
  });
  state.currentRankIndex = 0;
  state.currentExtraction = null;
  state.currentEvaluation = null;
  renderRecommendations();
  renderSelectedModel();
  await logEvent("recommendation_created", {
    request_id: state.decision.request_id,
    model_id: state.decision.selected_model.id,
    task_type: taskType,
    document_profile: state.documentProfile,
    extraction_instruction: instruction,
    payload: {
      selected_model: state.decision.selected_model,
      recommended_models: state.decision.recommended_models,
      policy: state.decision.policy_applied,
    },
  });
}

function renderRecommendations() {
  const rows = state.decision.recommended_models || [];
  $("recommendationOutput").innerHTML = rows.map((row, index) => {
    const explanationId = `explain-${index}`;
    return `
      <article class="rank-row">
        <div class="rank">${index + 1}</div>
        <div>
          <h3>${row.name}</h3>
          <small>${row.provider} | ${row.tier} | final score ${row.score}</small>
          <div class="metric-line">
            <span>cost ${fmtUsd(row.estimated_cost_usd)}</span>
            <span>quality ${pct(row.quality_score)}</span>
            <span>latency ${pct(row.latency_score)}</span>
            <span>cost score ${pct(row.cost_score)}</span>
          </div>
        </div>
        <button type="button" data-explain="${index}">Explain</button>
        <div id="${explanationId}" class="explain" hidden>${buildExplanation(row)}</div>
      </article>
    `;
  }).join("");
  document.querySelectorAll("[data-explain]").forEach((button) => {
    button.addEventListener("click", () => {
      const target = $(`explain-${button.dataset.explain}`);
      target.hidden = !target.hidden;
    });
  });
}

function buildExplanation(row) {
  const doc = state.decision.document_difficulty || {};
  return `
    Cost = input_tokens/1000 * input_price + output_tokens/1000 * output_price.
    Here: ${state.decision.estimated_input_tokens}/1000 * ${row.cost_per_1k_input_tokens}
    + ${state.decision.estimated_output_tokens}/1000 * ${row.cost_per_1k_output_tokens}
    = ${fmtUsd(row.estimated_cost_usd)}.
    Quality score comes from OCR capability, document difficulty, and task fit.
    This document difficulty is ${doc.level || "unknown"} (${doc.score ?? "n/a"}) because of pages, text layer, layout, tables, handwriting, and reconciliation flags.
    Final score blends quality, cost, latency, tier bonus, and learned score using the selected strategy.
  `;
}

async function simulateExtraction() {
  const ranked = state.decision?.recommended_models || [];
  const row = ranked[state.currentRankIndex];
  if (!row) return;
  const file = $("docFile").files[0];
  if (!file) {
    $("evalOutput").innerHTML = `<div class="notice">Upload a PDF or image before running extraction.</div>`;
    return;
  }
  const form = new FormData();
  form.append("document", file);
  form.append("session_id", state.sessionId);
  form.append("user_id", $("userId").value.trim());
  form.append("instruction", $("instruction").value.trim());
  form.append("document_profile", JSON.stringify(state.documentProfile || buildDocumentProfile()));
  form.append("allowed_models", JSON.stringify([row.model_id]));
  form.append("policy", JSON.stringify({
    strategy: $("strategy").value,
    maxLatencyMs: Number($("maxLatency").value || 3500),
    minQualityScore: Number($("minQuality").value || 0),
  }));
  form.append("dry_run", "false");
  $("simulateBtn").disabled = true;
  $("evalOutput").innerHTML = `<div class="selected-model">Extracting document...</div>`;
  const result = await api("/api/v2/extract", { method: "POST", body: form });
  state.decision = normalizePipelineDecision(result.decision);
  state.currentRankIndex = 0;
  state.currentExtraction = result.extraction;
  state.currentEvaluation = result.evaluation;
  state.currentRun = result;
  renderSelectedModel();
  renderEval(result.extraction, result.evaluation, result);
}

function renderSelectedModel() {
  const ranked = state.decision?.recommended_models || [];
  const row = ranked[state.currentRankIndex];
  $("simulateBtn").disabled = !row;
  $("happyBtn").disabled = true;
  $("notHappyBtn").disabled = true;
  $("evalOutput").innerHTML = "";
  if (!row) {
    $("selectedModel").textContent = "No model selected.";
    return;
  }
  $("selectedModel").innerHTML = `
    <h3>${row.name}</h3>
    <small>Rank ${state.currentRankIndex + 1} | ${row.provider} | ${row.tier}</small>
    <div class="metric-line">
      <span>${fmtUsd(row.estimated_cost_usd)}</span>
      <span>quality ${pct(row.quality_score)}</span>
      <span>latency ${pct(row.latency_score)}</span>
    </div>
  `;
}

function renderEval(extraction, evaluation, runResult = null) {
  $("happyBtn").disabled = false;
  $("notHappyBtn").disabled = false;
  const extractedView = renderExtractionView(extraction);
  $("evalOutput").innerHTML = `
    ${runResult ? `
      <div class="run-status">
        <strong>${runResult.execution.dryRun ? "Demo extraction" : "Extraction complete"}</strong>
        <span>OCR: ${escapeHtml(runResult.ocr.engine)}${runResult.ocr.warnings.length ? ` | ${escapeHtml(runResult.ocr.warnings.join(" "))}` : ""}</span>
      </div>
    ` : ""}
    <section class="extraction-card">
      <div class="extraction-head">
        <div>
          <p class="panel-label">Extracted Output</p>
          <h3>${extractedView.title}</h3>
        </div>
        <span class="quality-pill">${pct(evaluation.qualityScore)} ${evaluation.validationPassed ? "passed" : "review"}</span>
      </div>
      ${extractedView.html}
    </section>
    <div class="score eval-score">
      <strong>Validation</strong>
      <span>${pct(evaluation.qualityScore)} ${evaluation.validationPassed ? "passed validation" : "needs review"}</span>
      <div class="bar"><span style="width:${Math.round(evaluation.qualityScore * 100)}%"></span></div>
    </div>
    <details class="raw-json">
      <summary>Raw extraction JSON</summary>
      <pre>${escapeHtml(JSON.stringify(extraction, null, 2))}</pre>
    </details>
    ${evaluation.checks.map((check) => `
      <div class="check-row">
        <span class="${check.passed ? "pass" : "fail"}">${check.passed ? "OK" : "NO"}</span>
        <div><strong>${check.name}</strong><br />Weight ${check.weight}. ${check.detail}</div>
      </div>
    `).join("")}
  `;
}

function renderExtractionView(extraction) {
  if (!extraction || typeof extraction !== "object") {
    return {
      title: "No structured output returned",
      html: `<div class="empty-result">The extraction response was empty or not structured.</div>`,
    };
  }

  if (extraction.parse_error) {
    return {
      title: "Could not parse model output",
      html: `
        <div class="empty-result">The selected model did not return strict JSON. The raw preview is below.</div>
        <pre class="raw-preview">${escapeHtml(String(extraction.raw_output_preview || ""))}</pre>
      `,
    };
  }

  const tableKeys = ["transactions", "line_items", "items", "tables"];
  const scalarEntries = Object.entries(extraction).filter(([key, value]) => !tableKeys.includes(key) && isDisplayScalar(value));
  const nestedEntries = Object.entries(extraction).filter(([key, value]) => !tableKeys.includes(key) && value && typeof value === "object" && !Array.isArray(value));
  const tableSections = tableKeys
    .filter((key) => Array.isArray(extraction[key]) && extraction[key].length)
    .map((key) => renderArrayTable(labelFor(key), extraction[key]))
    .join("");

  const fieldRows = [
    ...scalarEntries,
    ...nestedEntries.flatMap(([parent, value]) => Object.entries(value).filter(([, childValue]) => isDisplayScalar(childValue)).map(([key, childValue]) => [`${labelFor(parent)} - ${labelFor(key)}`, childValue])),
  ];

  const fieldsHtml = fieldRows.length
    ? `
      <div class="field-grid">
        ${fieldRows.map(([key, value]) => `
          <div class="field-tile">
            <span>${escapeHtml(labelFor(key))}</span>
            <strong>${formatValue(value)}</strong>
          </div>
        `).join("")}
      </div>
    `
    : `<div class="empty-result">No top-level fields were returned. Check raw JSON for nested output.</div>`;

  return {
    title: extractionTitle(),
    html: `${fieldsHtml}${tableSections}`,
  };
}

function renderArrayTable(title, rows) {
  const normalizedRows = rows.map((row) => row && typeof row === "object" && !Array.isArray(row) ? row : { value: row });
  const columns = [...new Set(normalizedRows.flatMap((row) => Object.keys(row)))].slice(0, 8);
  return `
    <div class="result-table-wrap">
      <div class="result-table-head">
        <h4>${escapeHtml(title)}</h4>
        <span>${rows.length} rows</span>
      </div>
      <div class="result-table-scroll">
        <table class="result-table">
          <thead>
            <tr>${columns.map((column) => `<th>${escapeHtml(labelFor(column))}</th>`).join("")}</tr>
          </thead>
          <tbody>
            ${normalizedRows.map((row) => `
              <tr>${columns.map((column) => `<td>${formatValue(row[column])}</td>`).join("")}</tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function extractionTitle() {
  const taskType = taskTypeFromProfile(state.documentProfile || buildDocumentProfile());
  if (taskType === "bank_statement_extraction") return "Bank statement fields";
  if (taskType === "invoice_extraction") return "Invoice fields";
  return "Structured document fields";
}

function isDisplayScalar(value) {
  return value == null || ["string", "number", "boolean"].includes(typeof value);
}

function labelFor(key) {
  return String(key)
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatValue(value) {
  if (value == null || value === "") return `<span class="missing-value">Missing</span>`;
  if (typeof value === "number") return escapeHtml(Number.isInteger(value) ? String(value) : value.toFixed(2));
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") return escapeHtml(JSON.stringify(value));
  return escapeHtml(String(value));
}

async function recordFeedback(isHappy) {
  const row = state.decision.recommended_models[state.currentRankIndex];
  await api("/api/v2/feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session_id: state.sessionId,
      user_id: $("userId").value.trim() || undefined,
      request_id: state.decision.request_id,
      model_id: row.model_id,
      task_type: taskTypeFromProfile(state.documentProfile),
      extraction_instruction: $("instruction").value.trim(),
      happy: isHappy,
      validation_passed: Boolean(state.currentEvaluation?.validationPassed),
      quality_score: state.currentEvaluation?.qualityScore,
      actual_cost_usd: row.estimated_cost_usd,
      actual_latency_ms: Math.round((1 - row.latency_score) * 4000),
      upload_id: state.currentRun?.upload_id,
      run_id: state.currentRun?.upload_id,
      payload: {
        upload_id: state.currentRun?.upload_id,
        rank: state.currentRankIndex + 1,
        evaluation: state.currentEvaluation,
        user_happy: isHappy,
      },
    }),
  });
  addEvent(isHappy ? "feedback_happy" : "feedback_not_happy", { model_id: row.model_id });
  if (!isHappy) {
    const nextIndex = nextCostlierIndex(state.currentRankIndex);
    if (nextIndex !== -1) {
      const next = state.decision.recommended_models[nextIndex];
      await logEvent("escalated_next_model", {
        request_id: state.decision.request_id,
        model_id: next.model_id,
        task_type: taskTypeFromProfile(state.documentProfile),
        payload: { from_rank: state.currentRankIndex + 1, to_rank: nextIndex + 1 },
      });
      state.currentRankIndex = nextIndex;
      state.currentExtraction = null;
      state.currentEvaluation = null;
      renderSelectedModel();
    } else {
      $("evalOutput").insertAdjacentHTML("afterbegin", `<div class="notice">No higher-cost ranked option is available in the selected model pool.</div>`);
    }
  }
}

function normalizePipelineDecision(decision) {
  const scores = (decision.modelScores || []).filter((score) => !score.filteredReason);
  const modelsById = Object.fromEntries(state.models.map((model) => [model.id, model]));
  return {
    request_id: decision.requestId,
    selected_model: formatModelShape(decision.selectedModel),
    detected_task_type: decision.detectedTaskType,
    estimated_input_tokens: decision.estimatedInputTokens,
    estimated_output_tokens: decision.estimatedOutputTokens,
    estimated_cost_usd: decision.estimatedCostUsd,
    estimated_latency_ms: decision.estimatedLatencyMs,
    reasoning: decision.reasoning,
    document_difficulty: decision.documentDifficulty,
    policy_applied: decision.policyApplied,
    recommended_models: scores.slice(0, 8).map((score) => {
      const model = modelsById[score.modelId] || {};
      return {
        model_id: score.modelId,
        name: model.name || score.modelId,
        provider: model.provider || decision.selectedModel.provider,
        tier: model.tier || decision.selectedModel.tier,
        score: score.score,
        estimated_cost_usd: score.estimatedCostUsd,
        cost_per_1k_input_tokens: model.cost_per_1k_input_tokens ?? decision.selectedModel.costPer1kInputTokens,
        cost_per_1k_output_tokens: model.cost_per_1k_output_tokens ?? decision.selectedModel.costPer1kOutputTokens,
        cost_score: score.costScore,
        quality_score: score.qualityScore,
        latency_score: score.latencyScore,
      };
    }),
  };
}

function formatModelShape(model) {
  return {
    id: model.id,
    name: model.name,
    provider: model.provider,
    tier: model.tier,
  };
}

function nextCostlierIndex(index) {
  const rows = state.decision.recommended_models || [];
  const currentCost = rows[index]?.estimated_cost_usd || 0;
  const candidates = rows
    .map((row, i) => ({ row, i }))
    .filter(({ row, i }) => i > index && row.estimated_cost_usd >= currentCost)
    .sort((a, b) => a.row.estimated_cost_usd - b.row.estimated_cost_usd);
  return candidates[0]?.i ?? (index + 1 < rows.length ? index + 1 : -1);
}

async function logEvent(eventType, overrides = {}) {
  const payload = overrides.payload || overrides;
  const event = await mcp("v2_log_event", {
    session_id: state.sessionId,
    user_id: $("userId").value.trim() || undefined,
    event_type: eventType,
    request_id: overrides.request_id,
    model_id: overrides.model_id,
    task_type: overrides.task_type,
    document_profile: overrides.document_profile,
    extraction_instruction: overrides.extraction_instruction,
    payload,
  });
  addEvent(eventType, event.event);
}

function addEvent(type, detail) {
  state.events.unshift({ type, detail, ts: new Date().toLocaleTimeString() });
  state.events = state.events.slice(0, 25);
  $("eventLog").innerHTML = state.events.map((event) => `
    <div class="event-row">
      <strong>${event.type}</strong>
      <span>${event.ts} | ${event.detail?.modelId || event.detail?.model_id || "no model"}</span>
    </div>
  `).join("");
}

function buildDocumentProfile() {
  const file = $("docFile").files[0];
  const fileName = file?.name?.toLowerCase() || "";
  const fileType = fileName.endsWith(".pdf") ? "pdf" : file ? "image" : "unknown";
  const docType = $("docType").value;
  return {
    file_type: fileType,
    page_count: Number($("pageCount").value || 1),
    character_count: Number($("characterCount").value || 0),
    has_text_layer: $("textLayer").value === "good" || $("textLayer").value === "partial",
    text_layer_quality: $("textLayer").value,
    document_type: docType,
    source_institution: $("sourceInstitution").value.trim() || undefined,
    image_quality: $("imageQuality").value,
    layout_complexity: $("layoutComplexity").value,
    has_tables: $("hasTables").checked,
    table_count: $("hasTables").checked ? Math.max(1, Math.round(Number($("tableDensity").value || 0) * Number($("pageCount").value || 1) * 4)) : 0,
    table_density: Number($("tableDensity").value || 0),
    has_handwriting: $("hasHandwriting").checked,
    requires_reconciliation: $("requiresRecon").checked,
    contains_financial_data: ["invoice", "bank_statement", "receipt", "tax_form", "loan_document", "financial_report"].includes(docType),
    prior_validation_failed: $("priorFailed").checked,
    confidence: file ? 0.78 : 0.62,
  };
}

function taskTypeFromProfile(profile) {
  if (profile.document_type === "invoice") return "invoice_extraction";
  if (profile.document_type === "bank_statement") return "bank_statement_extraction";
  if (profile.has_handwriting) return "handwriting_extraction";
  if (profile.has_tables || profile.table_density > 0.4) return "table_extraction";
  if (profile.page_count > 20) return "long_document_extraction";
  return "field_extraction";
}

function buildPrompt(instruction, profile) {
  return [
    "You are extracting structured data from a document after non-LLM OCR/preflight.",
    `Document profile: ${JSON.stringify(profile)}`,
    `User extraction instruction: ${instruction}`,
    "Return strict JSON with fields, tables, totals, validation metadata, and confidence values.",
  ].join("\n");
}

function estimateInputTokens(profile, instruction) {
  const chars = Math.max(profile.character_count || 0, 1200);
  const pageLoad = (profile.page_count || 1) * 220;
  return Math.ceil(chars / 4 + pageLoad + instruction.length / 4);
}

function estimateOutputTokens(profile, instruction) {
  return Math.ceil(700 + (profile.page_count || 1) * 85 + (profile.table_count || 0) * 60 + instruction.length / 10);
}

function mockExtraction(taskType, rankIndex) {
  const strong = rankIndex > 0;
  if (taskType === "bank_statement_extraction") {
    return {
      account_last4: "4821",
      opening_balance: 1200,
      closing_balance: strong ? 1330 : 1325,
      transactions: [
        { date: "2026-06-02", description: "ACH deposit", amount: 500 },
        { date: "2026-06-04", description: "Card payment", amount: -210 },
        { date: "2026-06-09", description: "Transfer", amount: -160 },
      ],
      confidence: strong ? 0.92 : 0.78,
    };
  }
  if (taskType === "invoice_extraction") {
    return {
      vendor: "Northline Supplies",
      invoice_number: "INV-2048",
      invoice_date: "2026-06-18",
      subtotal: 440,
      tax: 35.2,
      fees: 0,
      discount: 0,
      total: strong ? 475.2 : 470.2,
      line_items: [
        { description: "Document processing", amount: 260 },
        { description: "Storage review", amount: 180 },
      ],
      confidence: strong ? 0.94 : 0.8,
    };
  }
  return {
    fields: { document_title: "Sample document", date: "2026-06-18", total: 475.2 },
    tables: [{ rows: 3, columns: 5 }],
    confidence: strong ? 0.9 : 0.73,
  };
}

function modelById(id) {
  return state.models.find((model) => model.id === id);
}

function pct(value) {
  return `${Math.round(Number(value || 0) * 100)}%`;
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;" }[char]));
}
