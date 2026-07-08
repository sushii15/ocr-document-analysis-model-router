const presets = {
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
    "Total amount due",
    "Payment terms",
    "Currency",
  ],
};

const state = {
  sessionId: localStorage.getItem("ocr_flow_session") || crypto.randomUUID(),
  userId: localStorage.getItem("ocr_flow_user") || `browser-${crypto.randomUUID().slice(0, 8)}`,
  models: [],
  selectedModelIds: new Set(JSON.parse(localStorage.getItem("ocr_flow_models") || "[]")),
  credentialSummaries: [],
  liveCredentials: {},
  docType: "bank_statement",
  decision: null,
  currentRankIndex: 0,
  currentRun: null,
  currentEvaluation: null,
};

localStorage.setItem("ocr_flow_session", state.sessionId);
localStorage.setItem("ocr_flow_user", state.userId);

const $ = (id) => document.getElementById(id);
const fmtUsd = (value) => `$${Number(value || 0).toFixed(value > 0.01 ? 4 : 6)}`;
const pct = (value) => {
  const number = Number(value || 0);
  return `${Math.round(number > 1 ? number : number * 100)}%`;
};

init().catch((error) => {
  console.error(error);
  setMessage("setupMessage", error.message);
});

async function init() {
  bindEvents();
  renderFields();
  $("instruction").value = "Return strict JSON. Include confidence values. Use null for missing fields.";
  await loadModels();
  await loadCredentialSummaries();
  applyDefaultModels();
  renderModels();
  renderKeyInputs();
  updateSummary();
}

function bindEvents() {
  $("resetBtn").addEventListener("click", () => {
    localStorage.removeItem("ocr_flow_session");
    localStorage.removeItem("ocr_flow_models");
    location.reload();
  });
  $("continueBtn").addEventListener("click", goToExtract);
  $("backBtn").addEventListener("click", goToSetup);
  $("docFile").addEventListener("change", updateFileMeta);
  $("runBtn").addEventListener("click", recommendAndExtract);
  $("happyBtn").addEventListener("click", () => recordFeedback(true));
  $("notHappyBtn").addEventListener("click", () => recordFeedback(false));
  $("nextModelBtn").addEventListener("click", runNextModel);
  document.querySelectorAll("[data-doc-type]").forEach((button) => {
    button.addEventListener("click", () => {
      state.docType = button.dataset.docType;
      document.querySelectorAll("[data-doc-type]").forEach((item) => item.classList.toggle("active", item === button));
      renderFields();
      updateSummary();
    });
  });
}

async function loadModels() {
  const result = await mcp("router_list_models");
  state.models = result.models || [];
}

function applyDefaultModels() {
  if (state.selectedModelIds.size) return;
  ["gpt-4o-mini", "gemini-2.0-flash", "mistral-small-3.1", "claude-haiku-4-5"].forEach((id) => state.selectedModelIds.add(id));
}

function renderModels() {
  $("modelCount").textContent = `${state.selectedModelIds.size} selected`;
  $("modelGrid").innerHTML = state.models.map((model) => `
    <label class="model-card">
      <input type="checkbox" data-model-id="${model.id}" ${state.selectedModelIds.has(model.id) ? "checked" : ""} />
      <span>
        <strong>${escapeHtml(model.name)}</strong>
        <small>${escapeHtml(model.provider)} | ${escapeHtml(model.tier)} | quality ${pct(model.quality_score)} | ${fmtUsd(model.cost_per_1k_input_tokens)}/${fmtUsd(model.cost_per_1k_output_tokens)} per 1k</small>
      </span>
    </label>
  `).join("");
  document.querySelectorAll("[data-model-id]").forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) state.selectedModelIds.add(input.dataset.modelId);
      else state.selectedModelIds.delete(input.dataset.modelId);
      localStorage.setItem("ocr_flow_models", JSON.stringify([...state.selectedModelIds]));
      $("modelCount").textContent = `${state.selectedModelIds.size} selected`;
      renderKeyInputs();
      updateSummary();
    });
  });
}

async function loadCredentialSummaries() {
  try {
    const result = await api(`/api/v2/provider-credentials?session_id=${encodeURIComponent(state.sessionId)}&user_id=${encodeURIComponent(state.userId)}`);
    state.credentialSummaries = result.credentials || [];
  } catch {
    state.credentialSummaries = [];
  }
}

function renderKeyInputs() {
  const requirements = credentialRequirements();
  if (!requirements.length) {
    $("keyGrid").innerHTML = `<div class="message">Choose at least one model to see the provider connection fields.</div>`;
    return;
  }
  $("keyGrid").innerHTML = requirements.map((requirement) => {
    const saved = credentialSummary(requirement.provider);
    const isSelfHosted = requirement.provider === "self_hosted";
    return `
      <section class="key-card ${saved ? "saved" : ""}">
        <div>
          <h3>${escapeHtml(requirement.label)}</h3>
          <small>${saved ? `Connected${saved.keyFingerprint ? ` | key ${saved.keyFingerprint}` : ""}${saved.hasBaseUrl ? " | endpoint saved" : ""}` : escapeHtml(requirement.help)}</small>
        </div>
        ${isSelfHosted ? `
          <label>
            Endpoint URL
            <input type="url" data-base-url="${requirement.provider}" placeholder="https://your-vllm-or-ollama-gateway.com" />
          </label>
        ` : ""}
        <label>
          API key${isSelfHosted ? " (optional if local endpoint does not require one)" : ""}
          <input type="password" autocomplete="off" data-api-key="${requirement.provider}" placeholder="${saved ? "Paste a new key to replace saved key" : "Paste API key"}" />
        </label>
        <button type="button" data-save-provider="${requirement.provider}">${saved ? "Update" : "Connect"}</button>
      </section>
    `;
  }).join("");
  document.querySelectorAll("[data-save-provider]").forEach((button) => {
    button.addEventListener("click", () => saveProviderKey(button.dataset.saveProvider));
  });
}

function credentialRequirements() {
  const providerMap = new Map();
  for (const model of selectedModels()) {
    const provider = model.hosting === "self-hosted" ? "self_hosted" : model.provider;
    providerMap.set(provider, providerRequirement(provider));
  }
  return [...providerMap.values()];
}

function providerRequirement(provider) {
  const labels = {
    openai: "OpenAI",
    anthropic: "Anthropic",
    google: "Google Gemini",
    mistral: "Mistral",
    deepseek: "DeepSeek",
    self_hosted: "Self-hosted / OpenAI-compatible",
  };
  const help = {
    openai: "Used for GPT models.",
    anthropic: "Used for Claude models.",
    google: "Used for Gemini models.",
    mistral: "Used for Mistral models.",
    deepseek: "Used for DeepSeek cloud models.",
    self_hosted: "Used for Llama, Qwen, or self-hosted DeepSeek through an OpenAI-compatible endpoint.",
  };
  return { provider, label: labels[provider] || provider, help: help[provider] || "Provider key required." };
}

function credentialProviderForModel(modelId) {
  const model = modelById(modelId);
  if (model?.hosting === "self-hosted") return "self_hosted";
  return model?.provider || "self_hosted";
}

function credentialSummary(provider) {
  return state.credentialSummaries.find((item) => item.provider === provider);
}

async function saveProviderKey(provider) {
  const keyInput = document.querySelector(`[data-api-key="${CSS.escape(provider)}"]`);
  const baseInput = document.querySelector(`[data-base-url="${CSS.escape(provider)}"]`);
  const apiKey = keyInput?.value.trim() || (provider === "self_hosted" ? "local" : "");
  const baseUrl = baseInput?.value.trim() || "";
  if (provider !== "self_hosted" && !apiKey) return setMessage("setupMessage", "Paste the provider API key first.");
  if (provider === "self_hosted" && !baseUrl) return setMessage("setupMessage", "Paste the self-hosted endpoint URL first.");
  await api("/api/v2/provider-credentials", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session_id: state.sessionId,
      user_id: state.userId,
      provider,
      api_key: apiKey,
      base_url: baseUrl || undefined,
    }),
  });
  if (keyInput) keyInput.value = "";
  if (baseInput) baseInput.value = "";
  state.liveCredentials[provider] = {
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
  };
  await loadCredentialSummaries();
  renderKeyInputs();
  setMessage("setupMessage", `${providerRequirement(provider).label} connected.`);
}

function renderFields() {
  const fields = presets[state.docType] || [];
  $("fieldGrid").innerHTML = fields.map((field, index) => `
    <label class="field-chip">
      <input type="checkbox" data-field="${field}" ${index < 10 ? "checked" : ""} />
      <span>${escapeHtml(field)}</span>
    </label>
  `).join("");
  document.querySelectorAll("[data-field]").forEach((input) => input.addEventListener("change", updateSummary));
}

function selectedFields() {
  return [...document.querySelectorAll("[data-field]:checked")].map((input) => input.dataset.field);
}

function selectedModels() {
  return [...state.selectedModelIds].map((id) => modelById(id)).filter(Boolean);
}

function buildInstruction() {
  const docLabel = state.docType === "bank_statement" ? "bank statement" : "invoice";
  const fieldLines = selectedFields().map((field) => `- ${field}`).join("\n");
  const extra = $("instruction").value.trim();
  return [
    `Extract these ${docLabel} fields from OCR text and the document image/profile:`,
    fieldLines,
    extra,
    state.docType === "bank_statement"
      ? "For transactions, return rows with date, description, amount, debit_credit, and running_balance when visible."
      : "For line items, return rows with description, quantity, unit_price, amount, and confidence when visible.",
  ].filter(Boolean).join("\n\n");
}

function goToExtract() {
  if (!state.selectedModelIds.size) return setMessage("setupMessage", "Choose at least one model.");
  if (!selectedFields().length) return setMessage("setupMessage", "Choose at least one extraction field.");
  const missing = missingCredentialRequirements();
  if (missing.length) return setMessage("setupMessage", `Connect ${missing.map((item) => item.label).join(", ")} before continuing.`);
  setMessage("setupMessage", "");
  updateSummary();
  $("setupView").classList.remove("active");
  $("extractView").classList.add("active");
  $("setupStep").classList.remove("active");
  $("extractStep").classList.add("active");
}

function missingCredentialRequirements() {
  return credentialRequirements().filter((requirement) => {
    const saved = credentialSummary(requirement.provider);
    if (!saved?.hasApiKey) return true;
    if (requirement.provider === "self_hosted" && !saved.hasBaseUrl) return true;
    return false;
  });
}

function goToSetup() {
  $("extractView").classList.remove("active");
  $("setupView").classList.add("active");
  $("extractStep").classList.remove("active");
  $("setupStep").classList.add("active");
}

function updateSummary() {
  const models = selectedModels().map((model) => model.name);
  const fields = selectedFields();
  $("chosenModels").textContent = models.length ? models.join(", ") : "None";
  $("chosenFields").textContent = fields.length ? fields.join(", ") : "None";
}

function updateFileMeta() {
  const file = $("docFile").files[0];
  if (!file) {
    $("fileMeta").textContent = "No document selected.";
    return;
  }
  $("fileMeta").textContent = `${file.name} | ${(file.size / 1024).toFixed(1)} KB | ${file.type || "unknown type"}`;
  if (file.type.startsWith("image/")) {
    $("pageCount").value = 1;
    $("textLayer").value = "none";
  }
}

async function recommendAndExtract() {
  const file = $("docFile").files[0];
  if (!file) return setMessage("runMessage", "Upload a PDF or image first.");
  setMessage("runMessage", "Choosing a model...");
  $("runBtn").disabled = true;
  $("happyBtn").disabled = true;
  $("notHappyBtn").disabled = true;
  $("nextModelBtn").hidden = true;
  try {
    const profile = buildDocumentProfile();
    const instruction = buildInstruction();
    state.decision = await mcp("router_route_request", {
      prompt: buildPrompt(instruction, profile),
      task_type: taskTypeFromProfile(profile),
      document_profile: profile,
      estimated_input_tokens: estimateInputTokens(profile, instruction),
      estimated_output_tokens: estimateOutputTokens(profile, instruction),
      policy: {
        strategy: "balanced",
        maxLatencyMs: 3500,
        minQualityScore: 0,
        allowedModels: [...state.selectedModelIds],
      },
    });
    state.currentRankIndex = 0;
    renderRanking();
    await extractWithCurrentModel();
  } catch (error) {
    setMessage("runMessage", error.message);
  } finally {
    $("runBtn").disabled = false;
  }
}

async function extractWithCurrentModel() {
  const row = currentRow();
  if (!row) return;
  const file = $("docFile").files[0];
  const profile = buildDocumentProfile();
  const form = new FormData();
  form.append("document", file);
  form.append("session_id", state.sessionId);
  form.append("user_id", state.userId);
  form.append("instruction", buildInstruction());
  form.append("document_profile", JSON.stringify(profile));
  form.append("allowed_models", JSON.stringify([row.model_id]));
  form.append("policy", JSON.stringify({ strategy: "balanced", maxLatencyMs: 3500, minQualityScore: 0 }));
  form.append("provider_credentials", JSON.stringify(state.liveCredentials));
  form.append("dry_run", "false");

  setMessage("runMessage", `Extracting with ${row.name}...`);
  renderSelectedModel();
  $("outputArea").innerHTML = `<div class="output-empty">Extracting with ${escapeHtml(row.name)}...</div>`;
  const result = await api("/api/v2/extract", { method: "POST", body: form });
  if (result.execution?.dryRun) {
    throw new Error(`${row.name} did not execute. Check the API key or endpoint for ${providerRequirement(credentialProviderForModel(row.model_id)).label}.`);
  }
  state.currentRun = result;
  state.currentEvaluation = result.evaluation;
  renderSelectedModel();
  renderRanking();
  renderOutput(result);
  setMessage("runMessage", "");
  $("happyBtn").disabled = false;
  $("notHappyBtn").disabled = false;
}

async function recordFeedback(isHappy) {
  const row = currentRow();
  if (!row || !state.decision) return;
  $("happyBtn").disabled = true;
  $("notHappyBtn").disabled = true;
  await api("/api/v2/feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session_id: state.sessionId,
      user_id: state.userId,
      request_id: state.decision.request_id,
      model_id: row.model_id,
      task_type: taskTypeFromProfile(buildDocumentProfile()),
      extraction_instruction: buildInstruction(),
      happy: isHappy,
      validation_passed: Boolean(state.currentEvaluation?.validationPassed),
      quality_score: state.currentEvaluation?.qualityScore,
      actual_cost_usd: row.estimated_cost_usd,
      actual_latency_ms: Math.round((1 - row.latency_score) * 4000),
      upload_id: state.currentRun?.upload_id,
      run_id: state.currentRun?.upload_id,
      payload: { rank: state.currentRankIndex + 1, user_happy: isHappy },
    }),
  });
  if (isHappy) {
    setMessage("runMessage", `Saved feedback for ${row.name}.`);
    $("nextModelBtn").hidden = true;
    return;
  }
  const next = nextRow();
  if (!next) {
    setMessage("runMessage", "No more selected models are available.");
    return;
  }
  $("nextModelBtn").textContent = `Send to ${next.name}`;
  $("nextModelBtn").hidden = false;
  setMessage("runMessage", `${row.name} marked not happy. Try the next option when ready.`);
}

async function runNextModel() {
  const next = nextRow();
  if (!next) return;
  state.currentRankIndex = indexOfModel(next.model_id);
  $("nextModelBtn").hidden = true;
  $("happyBtn").disabled = true;
  $("notHappyBtn").disabled = true;
  try {
    await extractWithCurrentModel();
  } catch (error) {
    setMessage("runMessage", error.message);
  }
}

function currentRow() {
  return (state.decision?.recommended_models || [])[state.currentRankIndex];
}

function nextRow() {
  const rows = state.decision?.recommended_models || [];
  return rows[state.currentRankIndex + 1] || null;
}

function indexOfModel(modelId) {
  const index = (state.decision?.recommended_models || []).findIndex((row) => row.model_id === modelId);
  return index === -1 ? state.currentRankIndex : index;
}

function renderSelectedModel() {
  const row = currentRow();
  if (!row) {
    $("selectedModel").className = "selected-empty";
    $("selectedModel").textContent = "No extraction yet.";
    return;
  }
  $("selectedModel").className = "selected-model";
  $("selectedModel").innerHTML = `
    <h3>${escapeHtml(row.name)}</h3>
    <small>Rank ${state.currentRankIndex + 1} | ${escapeHtml(row.provider)} | ${escapeHtml(row.tier)}</small>
    <div class="metric-line">
      <span>${fmtUsd(row.estimated_cost_usd)}</span>
      <span>quality ${pct(row.quality_score)}</span>
      <span>latency ${pct(row.latency_score)}</span>
    </div>
  `;
}

function renderRanking() {
  const rows = state.decision?.recommended_models || [];
  $("rankingList").innerHTML = rows.map((row, index) => `
    <article class="rank-row ${index === state.currentRankIndex ? "active" : ""}">
      <span class="rank-num">${index + 1}</span>
      <div>
        <strong>${escapeHtml(row.name)}</strong>
        <small>${escapeHtml(row.provider)} | ${fmtUsd(row.estimated_cost_usd)} | quality ${pct(row.quality_score)}</small>
      </div>
    </article>
  `).join("");
}

function renderOutput(result) {
  const extraction = result.extraction || {};
  const evaluation = result.evaluation || { qualityScore: 0, validationPassed: false, checks: [] };
  const view = renderExtractionView(extraction);
  $("outputArea").innerHTML = `
    <div class="output-card">
      <div class="run-status">
        <strong>Extraction complete</strong>
        <div>${escapeHtml(result.ocr?.engine || "OCR")} | ${pct(evaluation.qualityScore)} ${evaluation.validationPassed ? "passed" : "needs review"}</div>
      </div>
      ${view}
      <details class="raw-json">
        <summary>Raw JSON</summary>
        <pre>${escapeHtml(JSON.stringify(extraction, null, 2))}</pre>
      </details>
    </div>
  `;
}

function renderExtractionView(extraction) {
  if (!extraction || typeof extraction !== "object") return `<div class="output-empty">No structured output returned.</div>`;
  if (extraction.parse_error) {
    return `<div class="output-empty">The model did not return strict JSON.</div><details class="raw-json" open><summary>Raw preview</summary><pre>${escapeHtml(String(extraction.raw_output_preview || ""))}</pre></details>`;
  }
  const tableKeys = ["transactions", "line_items", "items", "tables"];
  const fields = Object.entries(extraction)
    .filter(([key, value]) => !tableKeys.includes(key) && isScalar(value))
    .slice(0, 16);
  const fieldHtml = fields.length
    ? `<div class="field-output">${fields.map(([key, value]) => `<div class="field-tile"><span>${escapeHtml(labelFor(key))}</span><strong>${formatValue(value)}</strong></div>`).join("")}</div>`
    : `<div class="output-empty">No top-level fields returned. Check raw JSON.</div>`;
  const tables = tableKeys
    .filter((key) => Array.isArray(extraction[key]) && extraction[key].length)
    .map((key) => renderTable(extraction[key]))
    .join("");
  return `${fieldHtml}${tables}`;
}

function renderTable(rows) {
  const normalized = rows.map((row) => row && typeof row === "object" && !Array.isArray(row) ? row : { value: row });
  const columns = [...new Set(normalized.flatMap((row) => Object.keys(row)))].slice(0, 8);
  return `
    <div class="table-wrap">
      <table>
        <thead><tr>${columns.map((column) => `<th>${escapeHtml(labelFor(column))}</th>`).join("")}</tr></thead>
        <tbody>
          ${normalized.map((row) => `<tr>${columns.map((column) => `<td>${formatValue(row[column])}</td>`).join("")}</tr>`).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function buildDocumentProfile() {
  const file = $("docFile").files[0];
  const fileName = file?.name?.toLowerCase() || "";
  const fileType = fileName.endsWith(".pdf") ? "pdf" : file ? "image" : "unknown";
  const pages = Number($("pageCount").value || 1);
  const textLayer = $("textLayer").value;
  const layout = $("layoutComplexity").value;
  const tableHeavy = layout === "table_heavy" || state.docType === "bank_statement";
  return {
    file_type: fileType,
    page_count: pages,
    character_count: Math.max(1800, pages * 1500),
    has_text_layer: textLayer === "good" || textLayer === "partial",
    text_layer_quality: textLayer,
    document_type: state.docType,
    image_quality: "medium",
    layout_complexity: layout,
    has_tables: tableHeavy,
    table_count: tableHeavy ? Math.max(1, pages * 2) : 0,
    table_density: tableHeavy ? 0.55 : 0.15,
    has_handwriting: false,
    requires_reconciliation: state.docType === "bank_statement",
    contains_financial_data: true,
    prior_validation_failed: false,
    confidence: file ? 0.78 : 0.62,
  };
}

function taskTypeFromProfile(profile) {
  if (profile.document_type === "invoice") return "invoice_extraction";
  if (profile.document_type === "bank_statement") return "bank_statement_extraction";
  if (profile.has_tables) return "table_extraction";
  return "field_extraction";
}

function buildPrompt(instruction, profile) {
  return [
    "Extract structured data from OCR text and document image/profile.",
    `Document profile: ${JSON.stringify(profile)}`,
    `Extraction instruction: ${instruction}`,
    "Return strict JSON only.",
  ].join("\n");
}

function estimateInputTokens(profile, instruction) {
  return Math.ceil(Math.max(profile.character_count || 0, 1200) / 4 + (profile.page_count || 1) * 220 + instruction.length / 4);
}

function estimateOutputTokens(profile, instruction) {
  return Math.ceil(700 + (profile.page_count || 1) * 85 + (profile.table_count || 0) * 60 + instruction.length / 10);
}

function normalizeDecision(decision) {
  const scores = (decision.modelScores || []).filter((score) => !score.filteredReason);
  const modelsById = Object.fromEntries(state.models.map((model) => [model.id, model]));
  return {
    request_id: decision.requestId,
    recommended_models: scores.slice(0, 8).map((score) => {
      const model = modelsById[score.modelId] || {};
      return {
        model_id: score.modelId,
        name: model.name || score.modelId,
        provider: model.provider || "unknown",
        tier: model.tier || "unknown",
        score: score.score,
        estimated_cost_usd: score.estimatedCostUsd,
        quality_score: score.qualityScore,
        latency_score: score.latencyScore,
      };
    }),
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
  if (options.body && !(options.body instanceof FormData) && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...options, headers });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || `Request failed: ${response.status}`);
  return json;
}

function modelById(id) {
  return state.models.find((model) => model.id === id);
}

function setMessage(id, text) {
  $(id).textContent = text || "";
}

function isScalar(value) {
  return value == null || ["string", "number", "boolean"].includes(typeof value);
}

function labelFor(key) {
  return String(key).replace(/_/g, " ").replace(/\s+/g, " ").trim().replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatValue(value) {
  if (value == null || value === "") return `<span class="missing">Missing</span>`;
  if (typeof value === "number") return escapeHtml(Number.isInteger(value) ? String(value) : value.toFixed(2));
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") return escapeHtml(JSON.stringify(value));
  return escapeHtml(String(value));
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
