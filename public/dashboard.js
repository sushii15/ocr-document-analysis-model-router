const els = {
  totalRequests: document.querySelector("#totalRequests"),
  totalCost: document.querySelector("#totalCost"),
  baselineCost: document.querySelector("#baselineCost"),
  savings: document.querySelector("#savings"),
  savingsPct: document.querySelector("#savingsPct"),
  totalOutcomes: document.querySelector("#totalOutcomes"),
  tierBars: document.querySelector("#tierBars"),
  taskBars: document.querySelector("#taskBars"),
  modelRows: document.querySelector("#modelRows"),
  learnedRows: document.querySelector("#learnedRows"),
  docFile: document.querySelector("#docFile"),
  fileMeta: document.querySelector("#fileMeta"),
  docType: document.querySelector("#docType"),
  pageCount: document.querySelector("#pageCount"),
  characterCount: document.querySelector("#characterCount"),
  sourceInstitution: document.querySelector("#sourceInstitution"),
  textLayer: document.querySelector("#textLayer"),
  imageQuality: document.querySelector("#imageQuality"),
  layoutComplexity: document.querySelector("#layoutComplexity"),
  tableDensity: document.querySelector("#tableDensity"),
  hasTables: document.querySelector("#hasTables"),
  hasHandwriting: document.querySelector("#hasHandwriting"),
  requiresRecon: document.querySelector("#requiresRecon"),
  priorFailed: document.querySelector("#priorFailed"),
  recommendBtn: document.querySelector("#recommendBtn"),
  recommendationOutput: document.querySelector("#recommendationOutput"),
  status: document.querySelector("#status"),
  seedBtn: document.querySelector("#seedBtn"),
  refreshBtn: document.querySelector("#refreshBtn"),
};

let selectedFileProfile = null;
let lastRecommendation = null;

const sampleRequests = [
  {
    prompt: "Run OCR on this scanned invoice PDF and extract vendor, invoice number, dates, totals, and line items.",
    stepType: "invoice_extraction",
    profile: { file_type: "pdf", page_count: 2, character_count: 4200, has_text_layer: true, text_layer_quality: "good", document_type: "invoice", image_quality: "high", layout_complexity: "simple", has_tables: true, table_count: 1, table_density: 0.18 },
  },
  {
    prompt: "Extract transaction rows, opening balance, closing balance, debits, credits, and account metadata from this Bank of America statement PDF.",
    stepType: "bank_statement_extraction",
    profile: { file_type: "pdf", page_count: 32, character_count: 85000, has_text_layer: false, text_layer_quality: "none", document_type: "bank_statement", source_institution: "Bank of America", known_layout_id: "bank-of-america.statement.v1", image_quality: "medium", layout_complexity: "table_heavy", has_tables: true, table_count: 12, table_density: 0.78, requires_reconciliation: true, contains_financial_data: true },
  },
  {
    prompt: "Extract all tables from this 40-page financial report and preserve row/column structure.",
    stepType: "table_extraction",
    profile: { file_type: "pdf", page_count: 40, character_count: 110000, has_text_layer: true, text_layer_quality: "partial", document_type: "financial_report", image_quality: "medium", layout_complexity: "dense", has_tables: true, table_count: 20, table_density: 0.65 },
  },
  {
    prompt: "Classify this uploaded PDF as invoice, bank statement, tax form, contract, or unknown before extraction.",
    stepType: "document_classification",
    profile: { file_type: "pdf", page_count: 1, character_count: 900, has_text_layer: true, text_layer_quality: "good", document_type: "unknown", image_quality: "high", layout_complexity: "simple", confidence: 0.8 },
  },
  {
    prompt: "Validate that invoice line-item totals, tax, subtotal, and amount due reconcile with the extracted fields.",
    stepType: "validation",
    profile: { file_type: "pdf", page_count: 3, character_count: 7200, has_text_layer: true, text_layer_quality: "good", document_type: "invoice", image_quality: "high", layout_complexity: "mixed", has_tables: true, table_count: 2, requires_reconciliation: true, prior_validation_failed: true },
  },
  {
    prompt: "Extract structured fields from a long multi-page loan agreement PDF with nested schedules and scanned pages.",
    stepType: "long_document_extraction",
    profile: { file_type: "pdf", page_count: 74, character_count: 180000, has_text_layer: true, text_layer_quality: "partial", document_type: "loan_document", image_quality: "medium", layout_complexity: "multi_column", has_tables: true, table_count: 9, table_density: 0.35 },
  },
];

async function rpc(method, params = {}) {
  const response = await fetch("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
  });
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message);
  return payload.result;
}

async function callTool(name, args = {}) {
  const result = await rpc("tools/call", { name, arguments: args });
  return JSON.parse(result.content[0].text);
}

async function refresh() {
  try {
    const stats = await callTool("router_get_stats", { limit: 1000 });
    render(stats);
    els.status.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    els.status.textContent = error.message;
  }
}

async function seedTraffic() {
  els.seedBtn.disabled = true;
  els.status.textContent = "Generating sample routing decisions...";
  try {
    const trajectoryId = crypto.randomUUID();
    for (const { prompt, stepType, profile } of sampleRequests) {
      const decision = await callTool("router_route_request", {
        prompt,
        step_type: stepType,
        document_profile: profile,
        trajectory_id: trajectoryId,
        policy: { strategy: ["bank_statement_extraction", "long_document_extraction"].includes(stepType) ? "quality" : "balanced" },
      });
      await callTool("router_record_outcome", {
        request_id: decision.request_id,
        success: stepType !== "long_document_extraction",
        validation_passed: stepType !== "long_document_extraction",
        needed_escalation: stepType === "long_document_extraction",
        quality_score: stepType === "long_document_extraction" ? 0.78 : 0.92,
        actual_cost_usd: decision.estimated_cost_usd,
        actual_latency_ms: decision.estimated_latency_ms,
        evaluator_type: "validator",
        notes: "Synthetic demo outcome generated from dashboard sample traffic.",
      });
    }
    await refresh();
  } catch (error) {
    els.status.textContent = error.message;
  } finally {
    els.seedBtn.disabled = false;
  }
}

async function profileSelectedFile(file) {
  if (!file) return;
  const lowerName = file.name.toLowerCase();
  const isPdf = lowerName.endsWith(".pdf");
  let pageCount = isPdf ? 1 : 1;
  let characterCount = Math.round(file.size / 2);
  let hasTextLayer = isPdf;
  let textLayerQuality = isPdf ? "partial" : "none";

  if (isPdf) {
    const bytes = await file.arrayBuffer();
    const text = new TextDecoder("latin1").decode(bytes.slice(0, Math.min(bytes.byteLength, 3_000_000)));
    pageCount = Math.max(1, (text.match(/\/Type\s*\/Page\b/g) || []).length);
    const textSignals = (text.match(/\b(?:BT|Tj|TJ|Font)\b/g) || []).length;
    hasTextLayer = textSignals > 10;
    textLayerQuality = textSignals > 200 ? "good" : textSignals > 10 ? "partial" : "none";
    characterCount = hasTextLayer ? Math.max(1000, Math.round(file.size / 3)) : pageCount * 1800;
  }

  const inferredType = inferDocumentType(lowerName);
  const inferredInstitution = inferInstitution(lowerName);
  const profile = {
    file_type: isPdf ? "pdf" : "image",
    page_count: pageCount,
    character_count: characterCount,
    has_text_layer: hasTextLayer,
    text_layer_quality: textLayerQuality,
    document_type: inferredType,
    source_institution: inferredInstitution,
    image_quality: isPdf && hasTextLayer ? "high" : "medium",
    layout_complexity: inferredType === "bank_statement" ? "table_heavy" : "mixed",
    has_tables: ["invoice", "bank_statement", "financial_report"].includes(inferredType),
    table_count: inferredType === "bank_statement" ? Math.max(1, Math.ceil(pageCount / 3)) : 1,
    table_density: inferredType === "bank_statement" ? 0.65 : 0.25,
    requires_reconciliation: ["invoice", "bank_statement"].includes(inferredType),
    contains_financial_data: ["invoice", "bank_statement", "receipt", "financial_report"].includes(inferredType),
    confidence: inferredType === "unknown" ? 0.45 : 0.75,
  };

  selectedFileProfile = profile;
  hydrateProfileForm(profile);
  els.fileMeta.textContent = `${file.name} · ${formatBytes(file.size)} · ${pageCount} page${pageCount === 1 ? "" : "s"}`;
}

async function recommendModel() {
  const profile = readProfileForm();
  const prompt = buildRecommendationPrompt(profile);
  els.recommendBtn.disabled = true;
  els.recommendationOutput.innerHTML = `<p>Scoring document profile...</p>`;
  try {
    const decision = await callTool("router_route_request", {
      prompt,
      step_type: taskForProfile(profile),
      document_profile: profile,
      policy: { strategy: profile.prior_validation_failed || profile.requires_reconciliation ? "quality" : "balanced" },
    });
    renderRecommendation(decision);
    await refresh();
  } catch (error) {
    els.recommendationOutput.innerHTML = `<p>${escapeHtml(error.message)}</p>`;
  } finally {
    els.recommendBtn.disabled = false;
  }
}

function render(stats) {
  els.totalRequests.textContent = stats.total_requests.toLocaleString();
  els.totalCost.textContent = money(stats.cost.total_cost_usd);
  els.baselineCost.textContent = money(stats.cost.all_frontier_baseline_usd);
  els.savings.textContent = money(stats.cost.estimated_savings_usd);
  els.savingsPct.textContent = `${stats.cost.savings_pct}%`;
  els.totalOutcomes.textContent = (stats.learning?.total_outcomes || 0).toLocaleString();
  renderBars(els.tierBars, stats.by_tier);
  renderBars(els.taskBars, stats.by_task_type);
  els.modelRows.innerHTML = (stats.by_model || [])
    .map((row) => `<tr><td>${escapeHtml(row.key)}</td><td>${row.count}</td></tr>`)
    .join("") || `<tr><td colspan="2">No routing decisions yet.</td></tr>`;
  els.learnedRows.innerHTML = (stats.learning?.top_scores || [])
    .map((row) => `
      <tr>
        <td>${escapeHtml(row.modelId)}</td>
        <td>${escapeHtml(row.taskType)}</td>
        <td>${row.sampleCount}</td>
        <td>${Math.round(row.successRate * 100)}%</td>
        <td>${row.learnedScore.toFixed(3)}</td>
      </tr>
    `)
    .join("") || `<tr><td colspan="5">No eval outcomes recorded yet.</td></tr>`;
}

function renderRecommendation(decision) {
  lastRecommendation = decision;
  const difficulty = decision.document_difficulty || {};
  const rows = (decision.recommended_models || [])
    .map((row, index) => `
      <tr data-rank="${index}">
        <td>${index + 1}</td>
        <td>${escapeHtml(row.name || row.model_id)}</td>
        <td>${escapeHtml(row.provider || "")}</td>
        <td>${escapeHtml(row.tier || "")}</td>
        <td>${money(row.estimated_cost_usd)}</td>
        <td>${Math.round((row.quality_score || 0) * 100)}%</td>
        <td>${Math.round((row.latency_score || 0) * 100)}%</td>
        <td>${Number(row.score || 0).toFixed(3)}</td>
        <td><button class="explain-btn ghost" type="button" data-rank="${index}">Explain</button></td>
      </tr>
      <tr class="explain-row" id="explain-${index}" hidden>
        <td colspan="9"><div class="explain-box"></div></td>
      </tr>
    `)
    .join("");
  els.recommendationOutput.innerHTML = `
    <div class="recommendation-main">
      <div>
        <span class="pill">${escapeHtml(decision.detected_task_type)}</span>
        <strong>${escapeHtml(decision.selected_model.name)}</strong>
        <p>${escapeHtml(decision.reasoning)}</p>
      </div>
      <span class="pill">Difficulty ${difficulty.score ?? 0}/100 · ${escapeHtml(difficulty.complexity || "unknown")}</span>
    </div>
    <div>
      <p>${escapeHtml((difficulty.reasons || []).join(" · ") || "No special difficulty signals.")}</p>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Rank</th>
            <th>Model</th>
            <th>Provider</th>
            <th>Tier</th>
            <th>Est. cost</th>
            <th>Quality</th>
            <th>Latency</th>
            <th>Score</th>
            <th>Explain</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
  els.recommendationOutput.querySelectorAll(".explain-btn").forEach((button) => {
    button.addEventListener("click", () => toggleExplanation(Number(button.dataset.rank)));
  });
}

function toggleExplanation(rank) {
  if (!lastRecommendation) return;
  const row = lastRecommendation.recommended_models?.[rank];
  const target = document.querySelector(`#explain-${rank}`);
  if (!row || !target) return;
  const box = target.querySelector(".explain-box");
  const willShow = target.hidden;
  document.querySelectorAll(".explain-row").forEach((node) => { node.hidden = true; });
  if (!willShow) return;
  box.innerHTML = renderExplanation(row, rank, lastRecommendation);
  target.hidden = false;
}

function renderExplanation(row, rank, decision) {
  const weights = weightsForStrategy(decision.policy_applied?.strategy || "balanced");
  const inputTokens = decision.estimated_input_tokens || 0;
  const outputTokens = decision.estimated_output_tokens || 0;
  const inputPrice = row.cost_per_1k_input_tokens || 0;
  const outputPrice = row.cost_per_1k_output_tokens || 0;
  const inputCost = (inputTokens / 1000) * inputPrice;
  const outputCost = (outputTokens / 1000) * outputPrice;
  const staticScore = (
    (row.cost_score || 0) * weights.cost +
    (row.quality_score || 0) * weights.quality +
    (row.latency_score || 0) * weights.latency +
    (row.tier_bonus || 0)
  );
  const learnedBlend = row.learned_blend || 0;
  const learnedScore = row.learned_score ?? staticScore;
  const finalScore = staticScore * (1 - learnedBlend) + learnedScore * learnedBlend;
  const difficulty = decision.document_difficulty || {};
  const reasons = (difficulty.reasons || []).map((reason) => `<li>${escapeHtml(reason)}</li>`).join("");

  return `
    <div class="explain-grid">
      <div>
        <h3>Rank ${rank + 1}: ${escapeHtml(row.name || row.model_id)}</h3>
        <p>This explanation is calculated from the router formula. No AI is used to produce it.</p>
      </div>
      <div class="formula-block">
        <strong>Estimated cost</strong>
        <code>(${inputTokens} / 1000 × ${inputPrice}) + (${outputTokens} / 1000 × ${outputPrice}) = ${money(inputCost + outputCost)}</code>
        <p>Input cost: ${money(inputCost)}. Output cost: ${money(outputCost)}.</p>
      </div>
      <div class="formula-block">
        <strong>Static score</strong>
        <code>${row.cost_score} × ${weights.cost} + ${row.quality_score} × ${weights.quality} + ${row.latency_score} × ${weights.latency} + ${row.tier_bonus || 0} = ${staticScore.toFixed(4)}</code>
        <p>Cost score rewards cheaper models, quality score is the catalog extraction quality, latency score rewards faster models, and tier bonus rewards the preferred tier for this document profile.</p>
      </div>
      <div class="formula-block">
        <strong>Final score</strong>
        <code>${staticScore.toFixed(4)} × ${(1 - learnedBlend).toFixed(2)} + ${Number(learnedScore).toFixed(4)} × ${learnedBlend.toFixed(2)} = ${finalScore.toFixed(4)}</code>
        <p>Learned blend is ${Math.round(learnedBlend * 100)}%. It increases only when recorded outcomes exist for this model/task pair.</p>
      </div>
      <div class="formula-block">
        <strong>Document difficulty</strong>
        <p>Difficulty ${difficulty.score ?? 0}/100 (${escapeHtml(difficulty.complexity || "unknown")}) changes the preferred model tier and output-token estimate.</p>
        <ul>${reasons || "<li>No extra difficulty reasons recorded.</li>"}</ul>
      </div>
    </div>
  `;
}

function weightsForStrategy(strategy) {
  return {
    cost: { cost: 0.7, quality: 0.2, latency: 0.1 },
    quality: { cost: 0.1, quality: 0.75, latency: 0.15 },
    latency: { cost: 0.15, quality: 0.2, latency: 0.65 },
    balanced: { cost: 0.35, quality: 0.45, latency: 0.2 },
  }[strategy] || { cost: 0.35, quality: 0.45, latency: 0.2 };
}

function hydrateProfileForm(profile) {
  els.docType.value = profile.document_type || "unknown";
  els.pageCount.value = profile.page_count || 1;
  els.characterCount.value = profile.character_count || 0;
  els.sourceInstitution.value = profile.source_institution || "";
  els.textLayer.value = profile.text_layer_quality || "unknown";
  els.imageQuality.value = profile.image_quality || "unknown";
  els.layoutComplexity.value = profile.layout_complexity || "unknown";
  els.tableDensity.value = profile.table_density ?? 0;
  els.hasTables.checked = Boolean(profile.has_tables);
  els.hasHandwriting.checked = Boolean(profile.has_handwriting);
  els.requiresRecon.checked = Boolean(profile.requires_reconciliation);
  els.priorFailed.checked = Boolean(profile.prior_validation_failed);
}

function readProfileForm() {
  const textLayerQuality = els.textLayer.value;
  return {
    ...(selectedFileProfile || {}),
    document_type: els.docType.value,
    page_count: Number(els.pageCount.value || 1),
    character_count: Number(els.characterCount.value || 0),
    has_text_layer: ["good", "partial", "poor"].includes(textLayerQuality),
    text_layer_quality: textLayerQuality,
    source_institution: els.sourceInstitution.value.trim() || undefined,
    image_quality: els.imageQuality.value,
    layout_complexity: els.layoutComplexity.value,
    has_tables: els.hasTables.checked,
    table_density: Number(els.tableDensity.value || 0),
    has_handwriting: els.hasHandwriting.checked,
    requires_reconciliation: els.requiresRecon.checked,
    prior_validation_failed: els.priorFailed.checked,
    contains_financial_data: ["invoice", "bank_statement", "receipt", "financial_report"].includes(els.docType.value),
  };
}

function buildRecommendationPrompt(profile) {
  return [
    `Recommend OCR/extraction model for ${profile.document_type || "unknown document"}.`,
    `Pages: ${profile.page_count}. Characters: ${profile.character_count}.`,
    `Text layer: ${profile.text_layer_quality}. Layout: ${profile.layout_complexity}.`,
    `Tables: ${profile.has_tables ? "yes" : "no"} density ${profile.table_density}.`,
    `Institution/source: ${profile.source_institution || "unknown"}.`,
    `Needs reconciliation: ${profile.requires_reconciliation ? "yes" : "no"}.`,
  ].join(" ");
}

function taskForProfile(profile) {
  if (profile.has_handwriting) return "handwriting_extraction";
  if (profile.document_type === "bank_statement") return "bank_statement_extraction";
  if (["invoice", "receipt"].includes(profile.document_type)) return "invoice_extraction";
  if (profile.has_tables) return "table_extraction";
  if (["contract", "loan_document", "financial_report"].includes(profile.document_type)) return "long_document_extraction";
  return "field_extraction";
}

function inferDocumentType(name) {
  if (/(bank|statement|chase|bofa|wells|amex|citi)/.test(name)) return "bank_statement";
  if (/(invoice|receipt|bill)/.test(name)) return "invoice";
  if (/(contract|agreement)/.test(name)) return "contract";
  if (/(loan|mortgage)/.test(name)) return "loan_document";
  if (/(report|financial|annual)/.test(name)) return "financial_report";
  if (/(tax|w2|1099)/.test(name)) return "tax_form";
  return "unknown";
}

function inferInstitution(name) {
  if (/bofa|bank.of.america|bank-of-america|bank of america/.test(name)) return "Bank of America";
  if (/chase|jpmorgan|jp.morgan/.test(name)) return "Chase";
  if (/wells/.test(name)) return "Wells Fargo";
  if (/amex|american.express|american express/.test(name)) return "American Express";
  if (/citi|citibank/.test(name)) return "Citi";
  return "";
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** power).toFixed(power ? 1 : 0)} ${units[power]}`;
}

function renderBars(container, rows) {
  const max = Math.max(...(rows || []).map((row) => row.count), 1);
  container.innerHTML = (rows || [])
    .map((row) => `
      <div class="bar-row">
        <span>${escapeHtml(row.key)}</span>
        <div class="track"><div class="fill" style="width:${(row.count / max) * 100}%"></div></div>
        <strong>${row.count}</strong>
      </div>
    `)
    .join("") || `<p>No data yet.</p>`;
}

function money(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 6,
  }).format(value || 0);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

els.seedBtn.addEventListener("click", seedTraffic);
els.refreshBtn.addEventListener("click", refresh);
els.docFile.addEventListener("change", (event) => profileSelectedFile(event.target.files[0]));
els.recommendBtn.addEventListener("click", recommendModel);
refresh();
