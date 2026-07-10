import { DocumentDifficulty, DocumentProfile, ModelSpec, TaskType } from "../types.js";

export type BenchmarkSourceId = "mmr_bench" | "mmdocbench" | "cc_ocr_v2";

export interface BenchmarkSource {
  id: BenchmarkSourceId;
  name: string;
  url: string;
  role: string;
}

export interface BenchmarkPrior {
  score: number;
  confidence: number;
  reasons: string[];
  sources: BenchmarkSourceId[];
  categories: string[];
}

export const BENCHMARK_SOURCES_V4: BenchmarkSource[] = [
  {
    id: "mmr_bench",
    name: "MMR-Bench",
    url: "https://arxiv.org/abs/2601.17814",
    role: "Routing framework: route multimodal inputs under cost budgets instead of using one model for everything.",
  },
  {
    id: "mmdocbench",
    name: "MMDocBench",
    url: "https://arxiv.org/abs/2410.21311",
    role: "Document family/task prior: receipts, financial reports, tables, charts, infographics, and research papers behave differently.",
  },
  {
    id: "cc_ocr_v2",
    name: "CC-OCR V2",
    url: "https://arxiv.org/abs/2605.03903",
    role: "OCR task prior: text recognition, document parsing, grounding, key information extraction, and document QA are distinct difficulty tracks.",
  },
];

export function benchmarkPriorForModelV4(
  model: ModelSpec,
  taskType: TaskType,
  profile: DocumentProfile | undefined,
  difficulty: DocumentDifficulty | undefined,
): BenchmarkPrior {
  const categories = classifyBenchmarkCategories(taskType, profile, difficulty);
  const sources = new Set<BenchmarkSourceId>();
  const reasons: string[] = [];
  let score = 0;
  let evidence = 0;

  const scannedOrImage = hasAny(categories, ["scanned_pdf", "image_document", "photographed_document"]);
  const cleanText = categories.includes("text_pdf");
  const tableOrFinancial = hasAny(categories, ["table_doc", "financial_doc", "numeric_financial", "reconciliation"]);
  const hardOcr = hasAny(categories, ["text_recognition", "document_parsing", "key_information_extraction", "document_qa"]);
  const longOrDense = hasAny(categories, ["long_context", "dense_table", "multi_page"]);
  const chartLike = hasAny(categories, ["chart_infographic", "research_paper"]);

  addSource("mmr_bench");
  evidence += 1;

  if (scannedOrImage) {
    addSource("cc_ocr_v2");
    evidence += 2;
    if (model.supportsVision) add(0.09, "CC-OCR V2 prior: scanned/image documents need vision-capable OCR literacy.");
    else add(-0.24, "CC-OCR V2 prior: image-only inputs are high risk for non-vision models.");
  }

  if (cleanText) {
    addSource("mmr_bench");
    evidence += 1;
    if (["nano", "small"].includes(model.tier)) add(0.05, "MMR-Bench prior: clean text-layer PDFs can use cheaper sufficient models.");
    if (model.tier === "frontier") add(-0.04, "MMR-Bench prior: frontier models are often over-provisioned for clean text-layer routing.");
  }

  if (tableOrFinancial) {
    addSource("mmdocbench");
    addSource("cc_ocr_v2");
    evidence += 2;
    if (model.supportsStructuredOutput) add(0.05, "MMDocBench prior: visual documents with tables need structured extraction strength.");
    if (["mid", "frontier"].includes(model.tier)) add(0.04, "MMDocBench prior: financial/table documents reward stronger visual reasoning.");
    if (["nano", "small"].includes(model.tier) && difficulty?.complexity === "high") add(-0.07, "CC-OCR V2 prior: hard enterprise OCR cases penalize small models.");
  }

  if (hardOcr) {
    addSource("cc_ocr_v2");
    evidence += 2;
    if (["frontier", "mid"].includes(model.tier) && model.supportsVision) add(0.06, "CC-OCR V2 prior: OCR parsing/KIE tracks favor stronger multimodal models.");
    if (!model.supportsVision) add(-0.08, "CC-OCR V2 prior: OCR parsing/KIE is weaker without visual input support.");
  }

  if (longOrDense) {
    addSource("mmdocbench");
    evidence += 1;
    if (model.contextWindow >= 200000) add(0.05, "MMDocBench prior: multi-page and dense documents benefit from larger context windows.");
    if (model.contextWindow < 128000) add(-0.05, "MMDocBench prior: long/dense document context is tighter on this model.");
  }

  if (chartLike) {
    addSource("mmdocbench");
    evidence += 1;
    if (model.supportsVision && ["mid", "frontier"].includes(model.tier)) add(0.06, "MMDocBench prior: charts, infographics, and research layouts need stronger visual perception.");
    if (!model.supportsVision) add(-0.1, "MMDocBench prior: chart and infographic tasks require visual perception.");
  }

  if (profile?.has_handwriting) {
    addSource("cc_ocr_v2");
    evidence += 1;
    if (model.supportsVision && model.qualityScore >= 83) add(0.05, "CC-OCR V2 prior: noisy real-world text favors high-quality vision models.");
    else add(-0.06, "CC-OCR V2 prior: handwriting/noisy text increases OCR failure risk.");
  }

  const providerNudge = modelFamilyPrior(model, categories);
  if (providerNudge.score) {
    add(providerNudge.score, providerNudge.reason);
    providerNudge.sources.forEach(addSource);
    evidence += 1;
  }

  return {
    score: clamp(score, -0.28, 0.22),
    confidence: clamp(0.45 + Math.min(0.45, evidence * 0.055), 0.45, 0.9),
    reasons: reasons.slice(0, 5),
    sources: Array.from(sources),
    categories,
  };

  function add(delta: number, reason: string) {
    score += delta;
    if (!reasons.includes(reason)) reasons.push(reason);
  }

  function addSource(source: BenchmarkSourceId) {
    sources.add(source);
  }
}

export function classifyBenchmarkCategories(
  taskType: TaskType,
  profile: DocumentProfile | undefined,
  difficulty: DocumentDifficulty | undefined,
) {
  const categories = new Set<string>();
  const textQuality = profile?.text_layer_quality || "unknown";
  const docType = profile?.document_type || "unknown";
  const layout = profile?.layout_complexity || "unknown";
  const pages = profile?.page_count || 1;
  const tableDensity = profile?.table_density || 0;

  categories.add(profile?.file_type === "image" ? "image_document" : profile?.file_type === "pdf" ? "pdf_document" : "unknown_modality");
  if (profile?.file_type === "image") categories.add("photographed_document");
  if (profile?.file_type === "pdf" && ["good", "partial"].includes(textQuality)) categories.add("text_pdf");
  if (profile?.file_type === "pdf" && ["none", "poor"].includes(textQuality)) categories.add("scanned_pdf");
  if (["invoice", "receipt"].includes(docType)) categories.add(docType);
  if (["bank_statement", "financial_report", "tax_form", "loan_document"].includes(docType)) categories.add("financial_doc");
  if (docType === "financial_report") categories.add("financial_report");
  if (profile?.has_tables || tableDensity >= 0.25 || ["table_heavy", "dense", "multi_column"].includes(layout)) categories.add("table_doc");
  if (tableDensity >= 0.55 || ["table_heavy", "dense"].includes(layout)) categories.add("dense_table");
  if (profile?.requires_reconciliation || taskType === "reconciliation") categories.add("reconciliation");
  if (profile?.contains_financial_data) categories.add("numeric_financial");
  if (pages >= 8) categories.add("multi_page");
  if (pages >= 15 || taskType === "long_document_extraction") categories.add("long_context");
  if (taskType === "ocr" || ["none", "poor"].includes(textQuality)) categories.add("text_recognition");
  if (["table_extraction", "invoice_extraction", "bank_statement_extraction", "field_extraction"].includes(taskType)) categories.add("key_information_extraction");
  if (["table_extraction", "long_document_extraction"].includes(taskType) || categories.has("dense_table")) categories.add("document_parsing");
  if (taskType === "validation" || taskType === "reconciliation") categories.add("document_qa");
  if (difficulty?.complexity === "high") categories.add("high_difficulty");
  if (docType === "financial_report" && layout === "multi_column") categories.add("chart_infographic");
  if (docType === "unknown" && layout === "multi_column") categories.add("research_paper");

  return Array.from(categories);
}

function modelFamilyPrior(model: ModelSpec, categories: string[]) {
  const scannedOrHard = hasAny(categories, ["scanned_pdf", "image_document", "high_difficulty", "dense_table"]);
  const cleanText = categories.includes("text_pdf") && !categories.includes("dense_table");
  const financial = hasAny(categories, ["financial_doc", "numeric_financial", "reconciliation"]);
  const sources: BenchmarkSourceId[] = ["mmdocbench", "cc_ocr_v2"];

  if (["gemini-2.5-pro", "gpt-4o", "claude-sonnet-4-6", "claude-opus-4-6", "gpt-5"].includes(model.id) && scannedOrHard) {
    return { score: 0.05, reason: "Benchmark-informed family prior: frontier/mid vision models are safer on hard scanned document images.", sources };
  }
  if (["gemini-2.0-flash", "gpt-4o-mini", "mistral-small-3.1", "claude-haiku-4-5"].includes(model.id) && cleanText) {
    return { score: 0.04, reason: "Benchmark-informed family prior: fast small models are acceptable when the PDF already has readable text.", sources: ["mmr_bench" as BenchmarkSourceId] };
  }
  if (["llama-3.3-70b", "qwen-2.5-72b", "deepseek-v3", "deepseek-r1-671b"].includes(model.id) && scannedOrHard) {
    return { score: -0.1, reason: "Benchmark-informed family prior: non-vision text models should not lead image-only OCR routing.", sources };
  }
  if (model.id === "llama-3.2-11b-vision" && financial) {
    return { score: -0.03, reason: "Benchmark-informed family prior: open-weight vision is useful, but financial reconciliation needs stronger structured precision.", sources };
  }
  return { score: 0, reason: "", sources: [] as BenchmarkSourceId[] };
}

function hasAny(values: string[], candidates: string[]) {
  return candidates.some((candidate) => values.includes(candidate));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
