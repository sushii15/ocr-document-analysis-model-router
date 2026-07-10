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

const state = {
  models: [],
  decision: null,
};

const $ = (id) => document.getElementById(id);
const money = (value) => `$${Number(value || 0).toFixed(value > 0.01 ? 4 : 6)}`;
const percent = (value) => `${Math.min(99, Math.max(1, Math.round(Number(value || 0) * 100)))}%`;

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
  ["pageCount", "textLayer", "imageQuality", "layoutComplexity", "institutionProfile", "tableDensity"].forEach((id) => {
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
  applyFileNameHints(file);
  if (file.type.startsWith("image/")) {
    $("pageCount").value = 1;
    $("textLayer").value = "none";
  }
  if (file.name.toLowerCase().endsWith(".pdf") && Number($("pageCount").value || 0) <= 1) {
    $("pageCount").value = estimatePdfPagesFromSize(file.size);
  }
  updateSummary();
}

function applyFileNameHints(file) {
  const name = file.name.toLowerCase();
  const docTypeHint = [
    [/bank|statement|transaction|checking|savings|chase|bofa|bank.of.america|wells|amex|citi/, "bank_statement"],
    [/invoice|bill|po-|purchase.order/, "invoice"],
    [/receipt|expense/, "receipt"],
    [/tax|w-?2|1099|return/, "tax_form"],
    [/loan|mortgage|credit.agreement/, "loan_document"],
    [/report|financial|annual|quarterly|statement.of.cash|balance.sheet/, "financial_report"],
  ].find(([regex]) => regex.test(name));
  if (docTypeHint && $("docType").value !== docTypeHint[1]) {
    $("docType").value = docTypeHint[1];
    updatePresetOptions();
    applyDocumentDefaults();
  }

  const institutionHint = [
    [/chase|jpmorgan/, "chase.statement.v1"],
    [/bofa|bank.of.america|bank-of-america/, "bank-of-america.statement.v1"],
    [/wells|wells.fargo|wells-fargo/, "wells-fargo.statement.v1"],
    [/amex|american.express/, "amex.statement.v1"],
    [/citi|citibank/, "citi.statement.v1"],
  ].find(([regex]) => regex.test(name));
  if (institutionHint) $("institutionProfile").value = institutionHint[1];

  if (/transaction|statement|report|ledger|table|line.item/.test(name)) $("tableDensity").value = "high";
  if (/simple|clean|single.page|receipt/.test(name)) {
    $("layoutComplexity").value = "simple";
    $("tableDensity").value = "low";
  }
  if (/scan|scanned|image|photo|jpg|png|low.quality|blur/.test(name)) {
    $("textLayer").value = "none";
    $("imageQuality").value = /low.quality|blur/.test(name) ? "low" : "medium";
  }
}

function estimatePdfPagesFromSize(size) {
  if (size > 4_000_000) return 24;
  if (size > 1_500_000) return 12;
  if (size > 600_000) return 6;
  return 2;
}

function applyDocumentDefaults() {
  const docType = $("docType").value;
  const tableHeavy = ["bank_statement", "invoice", "financial_report"].includes(docType);
  $("layoutComplexity").value = tableHeavy ? "table_heavy" : "mixed";
  $("pageCount").value = docType === "financial_report" ? 18 : docType === "receipt" ? 1 : 8;
  $("textLayer").value = docType === "receipt" ? "none" : "partial";
  $("tableDensity").value = "auto";
}

function applyDemoProfile() {
  $("docType").value = "bank_statement";
  updatePresetOptions();
  $("extractionPreset").value = "bank_reconciliation";
  $("pageCount").value = 8;
  $("textLayer").value = "partial";
  $("imageQuality").value = "medium";
  $("layoutComplexity").value = "table_heavy";
  $("institutionProfile").value = "chase.statement.v1";
  $("tableDensity").value = "high";
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
        allowedModels: state.models.map((model) => model.id),
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
  const rows = normalizeDecisionRows().slice(0, 20);
  $("recommendationOutput").innerHTML = `
    ${renderTradeoffChart(rows)}
    ${rows.map((row, index) => `
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
        ${metricTile("Estimated cost", money(row.estimated_cost_usd), null)}
        ${metricTile("Quality fit", percent(row.quality_score), row.quality_score)}
        ${metricTile("Speed fit", percent(row.latency_score), row.latency_score)}
        ${metricTile("Cost fit", percent(row.cost_score), row.cost_score)}
      </div>
      ${riskNote(row)}
      <div id="explain-${index}" class="explain-card" hidden>
        ${buildExplanation(row, index, rows)}
      </div>
    </article>
  `).join("")}
  `;

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
      document_fit_score: row.documentFitScore,
      raw_document_fit_score: row.rawDocumentFitScore,
      document_fit_reasons: row.documentFitReasons,
      cost_score: row.costScore,
      cost_per_1k_input_tokens: model.cost_per_1k_input_tokens,
      cost_per_1k_output_tokens: model.cost_per_1k_output_tokens,
    };
  }).filter((row) => !row.filteredReason);
}

function recommendationSentence(row, index) {
  const profile = buildDocumentProfile();
  const strongest = strongestMetric(row);
  const strategy = $("strategy").value;
  if (index === 0) {
    if (profile.has_tables && row.quality_score >= 0.85) return "Ranked first because its quality score is strong enough for table-heavy OCR without moving to a much costlier option.";
    if (strategy === "cost") return "Ranked first because it keeps cost low while staying above the quality needed for this document profile.";
    if (strategy === "latency") return "Ranked first because it is the fastest strong-enough option for the selected extraction.";
    return "Ranked first because it has the best weighted score across quality, speed, cost, and document difficulty.";
  }
  if (strongest.key === "quality" && Number(row.quality_score || 0) < 0.995) return "Higher-accuracy fallback for messy scans, dense tables, or cases where precision matters more than cost.";
  if (Number(row.quality_score || 0) >= 0.995) return "Strong fallback with high quality, but lower total score after speed, cost, and capped document fit are included.";
  if (strongest.key === "cost") return "Lower-cost alternative for clean documents where the text layer and layout are unlikely to cause extraction errors.";
  if (strongest.key === "latency") return "Faster fallback when turnaround time matters and the document is not unusually complex.";
  return "Backup option with a reasonable overall score if the models above are unavailable.";
}

function buildExplanation(row, index, rows) {
  const profile = buildDocumentProfile();
  const preset = selectedPreset();
  const difficulty = state.decision?.document_difficulty || state.decision?.documentDifficulty || {};
  const inputTokens = state.decision?.estimated_input_tokens || state.decision?.estimatedInputTokens || estimateInputTokens(profile, buildInstruction());
  const outputTokens = state.decision?.estimated_output_tokens || state.decision?.estimatedOutputTokens || estimateOutputTokens(profile, buildInstruction());
  const inputPrice = row.cost_per_1k_input_tokens ?? 0;
  const outputPrice = row.cost_per_1k_output_tokens ?? 0;
  const weights = strategyWeightsClient($("strategy").value, profile, difficulty);
  const weightedQuality = row.quality_score * weights.quality;
  const weightedCost = row.cost_score * weights.cost;
  const weightedLatency = row.latency_score * weights.latency;
  const documentFitScore = row.document_fit_score || row.documentFitScore || 0;
  const rawDocumentFitScore = row.raw_document_fit_score || row.rawDocumentFitScore || documentFitScore;
  const isCostGoal = $("strategy").value === "cost";
  const safetyAdjustment = documentFitScore;
  const baseScore = isCostGoal
    ? row.cost_score * 0.82 + row.quality_score * 0.12 + row.latency_score * 0.06 + safetyAdjustment
    : weightedQuality + weightedCost + weightedLatency + (row.tierBonus || row.tier_bonus || 0) + documentFitScore;
  const leader = rows[0];
  const tieWinner = rows.some((candidate) => candidate !== row && Number(candidate.score || 0) > Number(row.score || 0) && Number(candidate.score || 0) - Number(row.score || 0) <= 0.01 && Number(row.estimated_cost_usd || Infinity) < Number(candidate.estimated_cost_usd || Infinity));
  const costDelta = leader && leader !== row ? row.estimated_cost_usd - leader.estimated_cost_usd : 0;
  const qualityDelta = leader && leader !== row ? row.quality_score - leader.quality_score : 0;

  return `
    <div class="explain-section">
      <h4>Why this model</h4>
      <p>${escapeHtml(contextAwareWhy(row, index, leader, profile, preset, rows))}</p>
      <ul class="reason-list">
        ${reasonBullets(row, index, profile).map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}
      </ul>
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
      <p>Estimated cost is calculated from token volume and the model's listed input/output prices. No AI is used for this explanation.</p>
      <p class="formula">${inputTokens} / 1000 x ${money(inputPrice)} + ${outputTokens} / 1000 x ${money(outputPrice)} = ${money(row.estimated_cost_usd)}</p>
      ${costDelta > 0 ? `<p>${escapeHtml(row.name)} is ${money(costDelta)} more expensive than the current top recommendation for this request.</p>` : ""}
    </div>
    <div class="explain-section">
      <h4>Routing score</h4>
      <p>${escapeHtml(scoreIntroText(isCostGoal, weights))}</p>
      <div class="score-breakdown">
        ${isCostGoal ? scoreRow("Cost", row.cost_score, 0.82, row.cost_score * 0.82) : scoreRow("Quality", row.quality_score, weights.quality, weightedQuality)}
        ${isCostGoal ? scoreRow("Quality safety", row.quality_score, 0.12, row.quality_score * 0.12) : scoreRow("Cost", row.cost_score, weights.cost, weightedCost)}
        ${isCostGoal ? scoreRow("Speed", row.latency_score, 0.06, row.latency_score * 0.06) : scoreRow("Speed", row.latency_score, weights.latency, weightedLatency)}
      </div>
      <p class="formula">${scoreFormulaText(isCostGoal, row, weightedQuality, weightedCost, weightedLatency, documentFitScore, rawDocumentFitScore, safetyAdjustment, baseScore)}</p>
      <p>Final router score: ${Number(row.score || 0).toFixed(3)}. Document difficulty: ${escapeHtml(difficulty.complexity || difficulty.level || "medium")}.${tieWinner ? " Scores within 0.01 are treated as a tie; the cheaper model wins the tie-break." : ""}${qualityDelta > 0 ? ` This model has ${percent(Math.abs(qualityDelta))} higher quality fit than the top pick, but the weighted score is lower after cost and speed are included.` : ""}</p>
    </div>
  `;
}

function scoreIntroText(isCostGoal, weights) {
  if (isCostGoal) return "Lowest cost uses a cost-first formula: log-scaled cost 82%, quality safety 12%, speed 6%. Document fit is tightly capped so it cannot overpower price.";
  return `The ${$("strategy").selectedOptions[0]?.textContent || "Balanced"} goal weights quality ${percent(weights.quality)}, cost ${percent(weights.cost)}, and speed ${percent(weights.latency)}.`;
}

function scoreFormulaText(isCostGoal, row, weightedQuality, weightedCost, weightedLatency, documentFitScore, rawDocumentFitScore, safetyAdjustment, baseScore) {
  const cappedText = Math.abs(rawDocumentFitScore - documentFitScore) > 0.0001 ? ` (raw ${rawDocumentFitScore.toFixed(3)} capped)` : "";
  if (isCostGoal) {
    return `Cost-first score = ${(row.cost_score * 0.82).toFixed(3)} + ${(row.quality_score * 0.12).toFixed(3)} + ${(row.latency_score * 0.06).toFixed(3)}${safetyAdjustment ? ` + ${safetyAdjustment.toFixed(3)} document safety${cappedText}` : ""} = ${baseScore.toFixed(3)}`;
  }
  return `Base score = ${weightedQuality.toFixed(3)} + ${weightedCost.toFixed(3)} + ${weightedLatency.toFixed(3)}${(row.tierBonus || row.tier_bonus) ? ` + ${(row.tierBonus || row.tier_bonus).toFixed(3)} tier bonus` : ""}${documentFitScore ? ` + ${documentFitScore.toFixed(3)} document fit${cappedText}` : ""} = ${baseScore.toFixed(3)}`;
}

function renderTradeoffChart(rows) {
  if (!rows.length) return "";
  const maxCost = Math.max(...rows.map((row) => Number(row.estimated_cost_usd || 0)), 0.000001);
  const minQuality = Math.min(...rows.map((row) => Number(row.quality_score || 0)), 0.55);
  const qualityRange = Math.max(0.01, 1 - minQuality);
  const dots = rows.map((row, index) => {
    const x = 8 + (Number(row.estimated_cost_usd || 0) / maxCost) * 84;
    const y = 10 + ((Number(row.quality_score || 0) - minQuality) / qualityRange) * 80;
    return `
      <button type="button" class="chart-dot ${index === 0 ? "selected" : ""}" style="left:${x}%; bottom:${y}%;" aria-label="${escapeHtml(row.name)} cost ${money(row.estimated_cost_usd)}, quality ${percent(row.quality_score)}">
        <span>${index + 1}</span>
      </button>
    `;
  }).join("");

  return `
    <section class="tradeoff-panel" aria-label="Cost and accuracy trade-off chart">
      <div class="tradeoff-copy">
        <h3>Cost vs accuracy trade-off</h3>
        <p>The highlighted dot is the current top recommendation. Moving right means higher estimated cost; moving up means higher OCR quality fit.</p>
      </div>
      <div class="tradeoff-chart">
        <span class="axis-label y">Accuracy</span>
        <span class="axis-label x">Cost</span>
        ${dots}
      </div>
      <div class="chart-legend">
        ${rows.map((row, index) => `<span><i>${index + 1}</i>${escapeHtml(row.name)}</span>`).join("")}
      </div>
    </section>
  `;
}

function metricTile(label, value, score) {
  return `
    <div class="metric-tile">
      <span>${label}</span>
      <strong>${value}</strong>
      ${score === null ? "" : `<div class="metric-bar" aria-hidden="true"><i style="width:${Math.max(3, Math.round(score * 100))}%"></i></div>`}
    </div>
  `;
}

function riskNote(row) {
  const profile = buildDocumentProfile();
  const risks = riskReasons(row, profile);
  if (!risks.length) return "";
  return `<div class="risk-note"><strong>Risk</strong><span>${escapeHtml(risks[0])}</span></div>`;
}

function riskReasons(row, profile) {
  const risks = [];
  const difficultTables = profile.has_tables && ["table_heavy", "dense", "multi_column"].includes(profile.layout_complexity);
  if (difficultTables && row.quality_score < 0.82) risks.push("May struggle with dense tables or row-level reconciliation.");
  if (profile.text_layer_quality === "none" && row.quality_score < 0.86) risks.push("No text layer means the model must rely on vision OCR; accuracy risk is higher.");
  if (profile.page_count > 12 && row.latency_score < 0.45) risks.push("Longer documents may be slower on this model.");
  if (profile.image_quality === "low" && row.quality_score < 0.88) risks.push("Low image quality raises the chance of missed fields or wrong totals.");
  return risks;
}

function contextAwareWhy(row, index, leader, profile, preset, rows = []) {
  const strongest = strongestMetric(row);
  const rankText = index === 0 ? "It is ranked first" : `It is ranked #${index + 1}`;
  const documentNeed = profile.has_tables
    ? `${labelForDocType(profile.document_type).toLowerCase()} with table extraction`
    : `${labelForDocType(profile.document_type).toLowerCase()} field extraction`;
  const nearTieHigherScore = rows.find((candidate) => candidate !== row && Number(candidate.score || 0) > Number(row.score || 0) && Number(candidate.score || 0) - Number(row.score || 0) <= 0.01);

  if (index === 0) {
    if (nearTieHigherScore && Number(row.estimated_cost_usd || Infinity) < Number(nearTieHigherScore.estimated_cost_usd || Infinity)) {
      return `${rankText} because it is within the 0.01 near-tie band of ${nearTieHigherScore.name || "the next model"} and has the lower estimated cost for ${documentNeed}.`;
    }
    return `${rankText} because its weighted score is the strongest fit for ${documentNeed}: ${percent(row.quality_score)} quality, ${percent(row.latency_score)} speed, and ${percent(row.cost_score)} cost fit for "${preset.label}".`;
  }
  if (strongest.key === "quality" && Number(row.quality_score || 0) < 0.995) {
    return `${rankText} because it improves accuracy headroom for harder OCR, but its total score falls behind ${leader?.name || "the top model"} after cost and speed are weighted.`;
  }
  if (Number(row.quality_score || 0) >= 0.995 && Number(leader?.quality_score || 0) >= 0.995) {
    return `${rankText} because quality is tied with ${leader?.name || "the top model"}, but its total score is lower after speed, cost, tier bonus, and capped document fit are included.`;
  }
  if (strongest.key === "cost") {
    return `${rankText} because it is economically efficient, but it is safer for clean layouts than for complex financial tables.`;
  }
  if (strongest.key === "latency") {
    return `${rankText} because it is strong on response time, but it is not the best overall fit once document complexity and extraction quality are included.`;
  }
  return `${rankText} because it remains a viable fallback, but another model has a stronger weighted combination for this document.`;
}

function reasonBullets(row, index, profile) {
  const bullets = [];
  const strongest = strongestMetric(row);
  const fitReasons = row.document_fit_reasons || row.documentFitReasons || [];
  bullets.push(`Strongest dimension: ${strongest.label} at ${percent(strongest.value)}.`);
  fitReasons.slice(0, 2).forEach((reason) => bullets.push(`Rule match: ${reason}.`));
  if (profile.has_tables) bullets.push(`Table signal is active, so quality is weighted heavily for row and total accuracy.`);
  if (profile.requires_reconciliation) bullets.push("Reconciliation is required, so models with stronger reasoning/structure handling move up.");
  if (profile.text_layer_quality === "good") bullets.push("Good text layer reduces OCR risk, so cheaper models can remain competitive.");
  if (profile.text_layer_quality === "none") bullets.push("No text layer increases reliance on vision OCR, pushing quality-oriented models higher.");
  if (index > 0) bullets.push("It stays below the top option because the combined weighted score is lower.");
  return bullets.slice(0, 4);
}

function strongestMetric(row) {
  const metrics = [
    { key: "quality", label: "Quality fit", value: Number(row.quality_score || 0) },
    { key: "cost", label: "Cost fit", value: Number(row.cost_score || 0) },
    { key: "latency", label: "Speed fit", value: Number(row.latency_score || 0) },
  ];
  return metrics.sort((a, b) => b.value - a.value)[0];
}

function scoreRow(label, score, weight, contribution) {
  return `
    <div>
      <span>${label}</span>
      <strong>${percent(score)} x ${percent(weight)} = ${contribution.toFixed(3)}</strong>
      <div class="metric-bar" aria-hidden="true"><i style="width:${Math.max(3, Math.round(score * 100))}%"></i></div>
    </div>
  `;
}

function strategyWeightsClient(strategy, profile = buildDocumentProfile(), difficulty = {}) {
  const base = {
    cost: { cost: 0.7, quality: 0.2, latency: 0.1 },
    quality: { cost: 0.1, quality: 0.75, latency: 0.15 },
    latency: { cost: 0.15, quality: 0.2, latency: 0.65 },
    balanced: { cost: 0.35, quality: 0.45, latency: 0.2 },
  }[strategy] || { cost: 0.35, quality: 0.45, latency: 0.2 };
  const taskType = taskTypeFromProfile(profile);
  const isSimple = (difficulty.complexity || difficulty.level) === "low" && profile.text_layer_quality === "good" && profile.layout_complexity === "simple";
  const isHardFinancial = ["bank_statement_extraction", "reconciliation", "long_document_extraction"].includes(taskType)
    || (difficulty.complexity || difficulty.level) === "high"
    || profile.requires_reconciliation;
  if (strategy === "balanced" && isHardFinancial) return normalizeClientWeights({ quality: base.quality + 0.18, cost: base.cost - 0.12, latency: base.latency - 0.06 });
  if (strategy === "balanced" && ["invoice_extraction", "field_extraction"].includes(taskType) && isSimple) return normalizeClientWeights({ quality: base.quality - 0.12, cost: base.cost + 0.08, latency: base.latency + 0.04 });
  return base;
}

function normalizeClientWeights(weights) {
  const cost = Math.max(0.05, weights.cost);
  const quality = Math.max(0.05, weights.quality);
  const latency = Math.max(0.05, weights.latency);
  const total = cost + quality + latency;
  return { cost: cost / total, quality: quality / total, latency: latency / total };
}

function buildDocumentProfile() {
  const file = $("docFile").files[0];
  const docType = $("docType").value;
  const pageCount = Number($("pageCount").value || 1);
  const layout = $("layoutComplexity").value;
  const hasTables = ["bank_statement", "invoice", "financial_report"].includes(docType) || layout === "table_heavy";
  const institutionProfile = $("institutionProfile").value;
  const density = tableDensityValue(hasTables, pageCount);
  return {
    file_type: file?.name?.toLowerCase().endsWith(".pdf") ? "pdf" : file ? "image" : "unknown",
    page_count: pageCount,
    character_count: Math.max(1200, pageCount * characterDensityFor(layout, $("textLayer").value)),
    has_text_layer: ["good", "partial"].includes($("textLayer").value),
    text_layer_quality: $("textLayer").value,
    document_type: docType,
    source_institution: institutionProfile ? institutionProfile.split(".")[0].replace(/-/g, " ") : undefined,
    known_layout_id: institutionProfile || undefined,
    image_quality: $("imageQuality").value,
    layout_complexity: layout,
    has_tables: hasTables,
    table_count: hasTables ? Math.max(1, Math.round(pageCount * (density >= 0.6 ? 3.2 : density >= 0.3 ? 2.2 : 1.2))) : 0,
    table_density: density,
    has_handwriting: false,
    requires_reconciliation: docType === "bank_statement",
    contains_financial_data: ["invoice", "bank_statement", "receipt", "tax_form", "loan_document", "financial_report"].includes(docType),
    prior_validation_failed: false,
    confidence: file ? 0.78 : 0.64,
  };
}

function tableDensityValue(hasTables, pageCount) {
  const selected = $("tableDensity").value;
  if (selected === "low") return 0.18;
  if (selected === "medium") return 0.42;
  if (selected === "high") return 0.72;
  if (!hasTables) return 0.08;
  if ($("layoutComplexity").value === "dense") return 0.68;
  if ($("layoutComplexity").value === "table_heavy") return pageCount > 8 ? 0.65 : 0.55;
  return 0.28;
}

function characterDensityFor(layout, textLayer) {
  const base = {
    simple: 950,
    mixed: 1400,
    table_heavy: 1850,
    dense: 2400,
    multi_column: 2100,
    unknown: 1500,
  }[layout] || 1500;
  if (textLayer === "none") return Math.round(base * 0.75);
  if (textLayer === "good") return Math.round(base * 1.15);
  return base;
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
