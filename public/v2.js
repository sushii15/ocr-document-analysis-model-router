const extractionOptions = {
  bank_statement: [
    {
      id: "bank_core",
      label: "Key fields and transaction table",
      fields: ["account holder", "account number", "bank name", "statement period", "opening balance", "closing balance", "transactions", "deposits", "withdrawals", "fees"],
    },
    {
      id: "bank_reconciliation",
      label: "Balances, transactions, and reconciliation",
      fields: ["opening balance", "closing balance", "credits", "debits", "fees", "transaction rows", "running balances", "reconciliation check"],
    },
    {
      id: "bank_identity",
      label: "Account identity and statement summary",
      fields: ["account holder", "account number", "bank name", "statement dates", "summary totals", "confidence per field"],
    },
  ],
  invoice: [
    {
      id: "invoice_core",
      label: "Invoice header, totals, and line items",
      fields: ["vendor", "invoice number", "invoice date", "due date", "line items", "subtotal", "tax", "total", "payment terms"],
    },
    {
      id: "invoice_payment",
      label: "Payment and reconciliation fields",
      fields: ["vendor", "customer", "purchase order", "subtotal", "tax", "discounts", "fees", "total", "currency"],
    },
  ],
  receipt: [
    {
      id: "receipt_core",
      label: "Merchant, date, items, and total",
      fields: ["merchant", "date", "items", "subtotal", "tax", "tip", "total", "payment method"],
    },
  ],
  tax_form: [
    {
      id: "tax_core",
      label: "Taxpayer, form fields, and totals",
      fields: ["taxpayer", "tax year", "form type", "income fields", "deductions", "tax totals", "confidence per field"],
    },
  ],
  loan_document: [
    {
      id: "loan_core",
      label: "Borrower, loan terms, and payment schedule",
      fields: ["borrower", "lender", "loan amount", "interest rate", "term", "payment schedule", "fees"],
    },
  ],
  financial_report: [
    {
      id: "report_core",
      label: "Tables, totals, and key financial metrics",
      fields: ["reporting period", "tables", "revenue", "expenses", "cash flow", "assets", "liabilities", "summary metrics"],
    },
  ],
  unknown: [
    {
      id: "unknown_core",
      label: "Structured fields and tables",
      fields: ["document title", "dates", "parties", "key fields", "tables", "totals", "confidence per field"],
    },
  ],
};

const defaultModelIds = [
  "gpt-4o-mini",
  "gemini-2.0-flash",
  "mistral-small-3.1",
  "claude-haiku-4-5",
  "gpt-4o",
  "claude-sonnet-4-6",
  "gemini-2.5-pro",
];

const state = {
  models: [],
  decision: null,
};

const $ = (id) => document.getElementById(id);
const money = (value) => `$${Number(value || 0).toFixed(value > 0.01 ? 4 : 6)}`;
const percent = (value) => `${Math.round(Number(value || 0) * 100)}%`;

init().catch((error) => {
  console.error(error);
  $("emptyState").textContent = error.message;
});

async function init() {
  bindEvents();
  updatePresetOptions();
  updateSummary();
  await loadModels();
  if (new URLSearchParams(location.search).has("demo")) {
    applyDemoProfile();
    await recommendModels();
  }
}

function bindEvents() {
  $("docFile").addEventListener("change", updateFileMeta);
  $("docType").addEventListener("change", () => {
    updatePresetOptions();
    applyDocumentDefaults();
    updateSummary();
  });
  $("extractionPreset").addEventListener("change", updateSummary);
  $("strategy").addEventListener("change", updateSummary);
  ["pageCount", "textLayer", "imageQuality", "layoutComplexity"].forEach((id) => {
    $(id).addEventListener("change", updateSummary);
  });
  $("recommendBtn").addEventListener("click", recommendModels);
  $("resetBtn").addEventListener("click", () => location.href = location.pathname);
}

async function loadModels() {
  const result = await mcp("router_list_models");
  state.models = result.models || [];
}

function updatePresetOptions() {
  const options = extractionOptions[$("docType").value] || extractionOptions.unknown;
  $("extractionPreset").innerHTML = options.map((option) => `<option value="${option.id}">${escapeHtml(option.label)}</option>`).join("");
}

function selectedPreset() {
  const options = extractionOptions[$("docType").value] || extractionOptions.unknown;
  return options.find((option) => option.id === $("extractionPreset").value) || options[0];
}

function updateSummary() {
  const docType = $("docType").selectedOptions[0]?.textContent || "Document";
  const preset = selectedPreset();
  $("summaryDoc").textContent = docType;
  $("summaryExtract").textContent = preset.label;
  $("summaryGoal").textContent = $("strategy").selectedOptions[0]?.textContent || "Balanced";
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
  updateSummary();
}

function applyDocumentDefaults() {
  const docType = $("docType").value;
  const tableHeavy = ["bank_statement", "invoice", "financial_report"].includes(docType);
  $("layoutComplexity").value = tableHeavy ? "table_heavy" : "mixed";
  $("pageCount").value = docType === "financial_report" ? 18 : docType === "receipt" ? 1 : 8;
  $("textLayer").value = docType === "receipt" ? "none" : "partial";
}

function applyDemoProfile() {
  $("docType").value = "bank_statement";
  updatePresetOptions();
  $("extractionPreset").value = "bank_reconciliation";
  $("pageCount").value = 8;
  $("textLayer").value = "partial";
  $("imageQuality").value = "medium";
  $("layoutComplexity").value = "table_heavy";
  $("fileMeta").textContent = "sample-bank-statement.pdf | demo document";
  updateSummary();
}

async function recommendModels() {
  $("recommendBtn").disabled = true;
  $("emptyState").textContent = "Scoring models...";
  $("recommendationOutput").innerHTML = "";
  try {
    const profile = buildDocumentProfile();
    const instruction = buildInstruction();
    const taskType = taskTypeFromProfile(profile);
    state.decision = await mcp("router_route_request", {
      prompt: buildPrompt(instruction, profile),
      task_type: taskType,
      document_profile: profile,
      estimated_input_tokens: estimateInputTokens(profile, instruction),
      estimated_output_tokens: estimateOutputTokens(profile, instruction),
      policy: {
        strategy: $("strategy").value,
        maxLatencyMs: 3500,
        minQualityScore: 0,
        allowedModels: defaultModelIds,
      },
    });
    renderRecommendations();
    $("emptyState").hidden = true;
  } catch (error) {
    $("emptyState").hidden = false;
    $("emptyState").textContent = error.message;
  } finally {
    $("recommendBtn").disabled = false;
  }
}

function renderRecommendations() {
  const rows = normalizeDecisionRows().slice(0, 5);
  $("recommendationOutput").innerHTML = rows.map((row, index) => `
    <article class="rank-card">
      <div class="rank-top">
        <span class="rank-number">${index + 1}</span>
        <div>
          <h3>${escapeHtml(row.name)}</h3>
          <p>${escapeHtml(recommendationSentence(row, index))}</p>
        </div>
        <button type="button" class="secondary" data-explain="${index}">Explain</button>
      </div>
      <div class="score-grid">
        <div><span>Estimated cost</span><strong>${money(row.estimated_cost_usd)}</strong></div>
        <div><span>Quality fit</span><strong>${percent(row.quality_score)}</strong></div>
        <div><span>Speed fit</span><strong>${percent(row.latency_score)}</strong></div>
      </div>
      <div id="explain-${index}" class="explain-card" hidden>
        ${buildExplanation(row)}
      </div>
    </article>
  `).join("");

  document.querySelectorAll("[data-explain]").forEach((button) => {
    button.addEventListener("click", () => {
      const target = $(`explain-${button.dataset.explain}`);
      target.hidden = !target.hidden;
      button.textContent = target.hidden ? "Explain" : "Hide";
    });
  });
}

function normalizeDecisionRows() {
  const modelsById = Object.fromEntries(state.models.map((model) => [model.id, model]));
  return (state.decision?.recommended_models || state.decision?.modelScores || []).map((row) => {
    if (row.model_id) return row;
    const model = modelsById[row.modelId] || {};
    return {
      model_id: row.modelId,
      name: model.name || row.modelId,
      provider: model.provider || "unknown",
      tier: model.tier || "unknown",
      score: row.score,
      estimated_cost_usd: row.estimatedCostUsd,
      quality_score: row.qualityScore,
      latency_score: row.latencyScore,
      cost_score: row.costScore,
      cost_per_1k_input_tokens: model.cost_per_1k_input_tokens,
      cost_per_1k_output_tokens: model.cost_per_1k_output_tokens,
    };
  }).filter((row) => !row.filteredReason);
}

function recommendationSentence(row, index) {
  const preset = selectedPreset();
  if (index === 0) return `Best match for ${preset.label.toLowerCase()} with the current ${$("strategy").value} goal.`;
  if (row.quality_score > 0.85) return "A stronger quality option if the document is harder than expected.";
  if (row.estimated_cost_usd < 0.002) return "A low-cost backup that should work for cleaner layouts.";
  return "A reasonable fallback if the top model is unavailable.";
}

function buildExplanation(row) {
  const profile = buildDocumentProfile();
  const preset = selectedPreset();
  const difficulty = state.decision?.document_difficulty || state.decision?.documentDifficulty || {};
  const inputTokens = state.decision?.estimated_input_tokens || state.decision?.estimatedInputTokens || estimateInputTokens(profile, buildInstruction());
  const outputTokens = state.decision?.estimated_output_tokens || state.decision?.estimatedOutputTokens || estimateOutputTokens(profile, buildInstruction());
  const inputPrice = row.cost_per_1k_input_tokens ?? 0;
  const outputPrice = row.cost_per_1k_output_tokens ?? 0;

  return `
    <div class="explain-section">
      <h4>Why this model</h4>
      <p>${escapeHtml(row.name)} is ranked here because it balances OCR quality, expected speed, and estimated cost for a ${labelForDocType(profile.document_type).toLowerCase()}.</p>
    </div>
    <div class="explain-section">
      <h4>Document signals used</h4>
      <ul>
        <li>${profile.page_count} page${profile.page_count === 1 ? "" : "s"} with ${profile.text_layer_quality} text layer.</li>
        <li>${labelForLayout(profile.layout_complexity)} layout and ${profile.has_tables ? "table-heavy extraction" : "field extraction"}.</li>
        <li>Requested output: ${escapeHtml(preset.label)}.</li>
      </ul>
    </div>
    <div class="explain-section">
      <h4>Cost estimate</h4>
      <p>Estimated cost is input tokens plus output tokens multiplied by the model prices.</p>
      <p class="formula">${inputTokens} / 1000 x ${money(inputPrice)} + ${outputTokens} / 1000 x ${money(outputPrice)} = ${money(row.estimated_cost_usd)}</p>
    </div>
    <div class="explain-section">
      <h4>Routing score</h4>
      <p>Quality fit ${percent(row.quality_score)}, speed fit ${percent(row.latency_score)}, cost fit ${percent(row.cost_score)}. Document difficulty: ${escapeHtml(difficulty.complexity || difficulty.level || "medium")}.</p>
    </div>
  `;
}

function buildDocumentProfile() {
  const file = $("docFile").files[0];
  const docType = $("docType").value;
  const pageCount = Number($("pageCount").value || 1);
  const layout = $("layoutComplexity").value;
  const hasTables = ["bank_statement", "invoice", "financial_report"].includes(docType) || layout === "table_heavy";
  return {
    file_type: file?.name?.toLowerCase().endsWith(".pdf") ? "pdf" : file ? "image" : "unknown",
    page_count: pageCount,
    character_count: Math.max(1200, pageCount * 1500),
    has_text_layer: ["good", "partial"].includes($("textLayer").value),
    text_layer_quality: $("textLayer").value,
    document_type: docType,
    image_quality: $("imageQuality").value,
    layout_complexity: layout,
    has_tables: hasTables,
    table_count: hasTables ? Math.max(1, Math.round(pageCount * 2.5)) : 0,
    table_density: hasTables ? 0.55 : 0.15,
    has_handwriting: false,
    requires_reconciliation: docType === "bank_statement",
    contains_financial_data: ["invoice", "bank_statement", "receipt", "tax_form", "loan_document", "financial_report"].includes(docType),
    prior_validation_failed: false,
    confidence: file ? 0.78 : 0.64,
  };
}

function buildInstruction() {
  const preset = selectedPreset();
  return [
    `Extract: ${preset.label}.`,
    `Fields: ${preset.fields.join(", ")}.`,
    "Return structured JSON with confidence values where possible.",
  ].join(" ");
}

function taskTypeFromProfile(profile) {
  if (profile.document_type === "invoice") return "invoice_extraction";
  if (profile.document_type === "bank_statement") return "bank_statement_extraction";
  if (profile.has_tables) return "table_extraction";
  if (profile.page_count > 20) return "long_document_extraction";
  return "field_extraction";
}

function buildPrompt(instruction, profile) {
  return [
    "Route this OCR/document extraction task to the best model.",
    `Document profile: ${JSON.stringify(profile)}`,
    `Extraction request: ${instruction}`,
  ].join("\n");
}

function estimateInputTokens(profile, instruction) {
  return Math.ceil(Math.max(profile.character_count || 0, 1200) / 4 + (profile.page_count || 1) * 220 + instruction.length / 4);
}

function estimateOutputTokens(profile, instruction) {
  return Math.ceil(700 + (profile.page_count || 1) * 85 + (profile.table_count || 0) * 60 + instruction.length / 10);
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

function labelForDocType(value) {
  return String(value || "document").replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function labelForLayout(value) {
  return String(value || "mixed").replace(/_/g, "-");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;" }[char]));
}
