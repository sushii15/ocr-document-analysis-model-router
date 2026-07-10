import fs from "node:fs/promises";
import crypto from "node:crypto";
import { DocumentProfile, DocumentType } from "../types.js";
import { runNonLlmOcr, UploadedDocument } from "./ocrService.js";

export interface V4PreflightResult {
  profile: DocumentProfile;
  features: Record<string, unknown>;
  ocr: {
    engine: string;
    character_count: number;
    word_count: number;
    line_count: number;
    preview: string;
    warnings: string[];
  };
  signals: string[];
  file: {
    name: string;
    mime_type: string;
    size: number;
    sha256: string;
  };
}

export async function analyzeDocumentPreflightV4(file: UploadedDocument, hints: {
  documentType?: string;
  extractionPreset?: string;
} = {}): Promise<V4PreflightResult> {
  const [ocr, hash] = await Promise.all([runNonLlmOcr(file), hashFile(file.path)]);
  const text = ocr.text || "";
  const textFeatures = extractTextFeatures(text);
  const fileFeatures = await extractFileFeatures(file);
  const inferredDocumentType = normalizeDocumentType(hints.documentType) || inferDocumentType(file.originalName, text);
  const institution = inferInstitution(file.originalName, text);
  const pageCount = ocr.profilePatch.page_count || fileFeatures.pageCount || 1;
  const tableDensity = estimateTableDensity(textFeatures, inferredDocumentType);
  const layoutComplexity = inferLayoutComplexity(textFeatures, tableDensity, pageCount);
  const imageQuality = inferImageQuality(file, ocr.profilePatch.image_quality, textFeatures, pageCount);
  const hasTables = tableDensity >= 0.22 || ["bank_statement", "invoice", "financial_report"].includes(inferredDocumentType);
  const textLayerQuality = ocr.profilePatch.text_layer_quality || inferTextLayerQuality(text.length, pageCount, ocr.engine);
  const profile: DocumentProfile = {
    file_type: ocr.profilePatch.file_type || fileFeatures.fileType,
    page_count: pageCount,
    character_count: text.length || estimateCharacterCount(pageCount, layoutComplexity, textLayerQuality),
    has_text_layer: Boolean(ocr.profilePatch.has_text_layer),
    text_layer_quality: textLayerQuality,
    document_type: inferredDocumentType,
    source_institution: institution?.name,
    known_layout_id: institution?.layoutId,
    image_quality: imageQuality,
    layout_complexity: layoutComplexity,
    has_tables: hasTables,
    table_count: hasTables ? estimateTableCount(pageCount, tableDensity, textFeatures.tableLikeLineCount) : 0,
    table_density: tableDensity,
    has_handwriting: false,
    requires_reconciliation: inferredDocumentType === "bank_statement" || /\breconcile|running balance|opening balance|closing balance\b/i.test(text),
    contains_financial_data: containsFinancialData(inferredDocumentType, textFeatures),
    prior_validation_failed: false,
    confidence: confidenceFor(text, ocr.engine, hints.documentType),
  };

  const signals = buildSignals(profile, textFeatures, fileFeatures, ocr.warnings);
  return {
    profile,
    features: {
      ...textFeatures,
      ...fileFeatures,
      extractionPreset: hints.extractionPreset || null,
    },
    ocr: {
      engine: ocr.engine,
      character_count: text.length,
      word_count: textFeatures.wordCount,
      line_count: textFeatures.lineCount,
      preview: text.slice(0, 1200),
      warnings: ocr.warnings,
    },
    signals,
    file: {
      name: file.originalName,
      mime_type: file.mimeType,
      size: file.size,
      sha256: hash,
    },
  };
}

async function hashFile(filePath: string) {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function extractFileFeatures(file: UploadedDocument) {
  const lower = file.originalName.toLowerCase();
  const fileType = file.mimeType === "application/pdf" || lower.endsWith(".pdf")
    ? "pdf"
    : file.mimeType.startsWith("image/") || /\.(png|jpe?g|tiff?|bmp|webp)$/i.test(lower)
      ? "image"
      : "unknown";
  return {
    fileType: fileType as DocumentProfile["file_type"],
    fileSizeBucket: bucket(file.size, [150_000, 1_500_000, 8_000_000]),
    pageCount: fileType === "image" ? 1 : undefined,
  };
}

function extractTextFeatures(text: string) {
  const normalized = text || "";
  const lines = normalized.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const words = normalized.match(/\b[\w.-]+\b/g) || [];
  const digits = normalized.match(/\d/g) || [];
  const currency = normalized.match(/[$]|(?:usd|eur|gbp|inr)\b/gi) || [];
  const dates = normalized.match(/\b(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}[/-]\d{1,2}[/-]\d{1,2}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/gi) || [];
  const tableLikeLines = lines.filter((line) => {
    const separators = (line.match(/\s{2,}|\t|\|/g) || []).length;
    const numericCells = (line.match(/[-+]?\$?\d[\d,]*(?:\.\d+)?/g) || []).length;
    return separators >= 2 || numericCells >= 3;
  });
  const longLines = lines.filter((line) => line.length > 110);
  const digitRatio = normalized.length ? digits.length / normalized.length : 0;
  const tableSignal = lines.length ? tableLikeLines.length / lines.length : 0;
  return {
    lineCount: lines.length,
    wordCount: words.length,
    digitRatio: round4(digitRatio),
    currencyCount: currency.length,
    dateCount: dates.length,
    tableLikeLineCount: tableLikeLines.length,
    tableSignal: round4(tableSignal),
    longLineRatio: round4(lines.length ? longLines.length / lines.length : 0),
    hasDenseNumbers: digitRatio > 0.14,
    hasTableLikeText: tableSignal > 0.18,
  };
}

function inferDocumentType(fileName: string, text: string): DocumentType {
  const source = `${fileName}\n${text.slice(0, 4000)}`.toLowerCase();
  if (/\b(bank statement|statement period|opening balance|closing balance|account number|debit|credit|transaction)\b/.test(source)) return "bank_statement";
  if (/\b(invoice|invoice number|amount due|bill to|ship to|purchase order|subtotal)\b/.test(source)) return "invoice";
  if (/\b(receipt|merchant|tip|cashier|store)\b/.test(source)) return "receipt";
  if (/\b(w-?2|1099|tax return|taxpayer|ein|ssn)\b/.test(source)) return "tax_form";
  if (/\b(loan|mortgage|borrower|lender|interest rate|amortization)\b/.test(source)) return "loan_document";
  if (/\b(financial report|annual report|balance sheet|cash flow|income statement)\b/.test(source)) return "financial_report";
  return "unknown";
}

function normalizeDocumentType(value?: string): DocumentType | undefined {
  const allowed: DocumentType[] = ["invoice", "bank_statement", "receipt", "tax_form", "contract", "loan_document", "financial_report", "unknown"];
  return allowed.includes(value as DocumentType) && value !== "unknown" ? value as DocumentType : undefined;
}

function inferInstitution(fileName: string, text: string) {
  const source = `${fileName}\n${text.slice(0, 2500)}`;
  const layouts: Array<[RegExp, string, string]> = [
    [/\b(chase|jpmorgan)\b/i, "Chase", "chase.statement.v1"],
    [/\b(bank of america|bofa)\b/i, "Bank of America", "bank-of-america.statement.v1"],
    [/\bwells fargo\b/i, "Wells Fargo", "wells-fargo.statement.v1"],
    [/\b(american express|amex)\b/i, "American Express", "amex.statement.v1"],
    [/\b(citi|citibank)\b/i, "Citi", "citi.statement.v1"],
  ];
  const match = layouts.find(([regex]) => regex.test(source));
  return match ? { name: match[1], layoutId: match[2] } : undefined;
}

function estimateTableDensity(features: ReturnType<typeof extractTextFeatures>, documentType: DocumentType) {
  const base = Math.max(features.tableSignal, features.hasDenseNumbers ? 0.26 : 0.08);
  const financialBoost = ["bank_statement", "invoice", "financial_report"].includes(documentType) ? 0.14 : 0;
  const density = base + financialBoost + Math.min(0.18, features.tableLikeLineCount / 120);
  return round4(Math.min(0.88, Math.max(0.04, density)));
}

function inferLayoutComplexity(features: ReturnType<typeof extractTextFeatures>, tableDensity: number, pageCount: number): DocumentProfile["layout_complexity"] {
  if (tableDensity >= 0.6) return "table_heavy";
  if (features.longLineRatio > 0.25 || pageCount >= 20) return "dense";
  if (features.tableSignal >= 0.3) return "table_heavy";
  if (features.lineCount / Math.max(1, pageCount) > 75) return "dense";
  if (features.lineCount / Math.max(1, pageCount) < 18 && tableDensity < 0.15) return "simple";
  return "mixed";
}

function inferImageQuality(file: UploadedDocument, patchQuality: DocumentProfile["image_quality"], features: ReturnType<typeof extractTextFeatures>, pageCount: number): DocumentProfile["image_quality"] {
  if (patchQuality && patchQuality !== "unknown") return patchQuality;
  const charsPerPage = features.wordCount * 5 / Math.max(1, pageCount);
  if (file.mimeType.startsWith("image/") && charsPerPage < 120) return "low";
  if (charsPerPage > 900) return "high";
  return "medium";
}

function inferTextLayerQuality(length: number, pageCount: number, engine: string): DocumentProfile["text_layer_quality"] {
  if (engine !== "pdf_text_layer") return "none";
  const perPage = length / Math.max(1, pageCount);
  if (perPage > 900) return "good";
  if (perPage > 150) return "partial";
  return "poor";
}

function estimateTableCount(pageCount: number, density: number, observedTableLines: number) {
  const fromDensity = Math.round(pageCount * (density >= 0.6 ? 3 : density >= 0.3 ? 2 : 1));
  const fromLines = Math.round(observedTableLines / 18);
  return Math.max(1, Math.min(80, Math.max(fromDensity, fromLines)));
}

function estimateCharacterCount(pageCount: number, layout: DocumentProfile["layout_complexity"], textLayer: DocumentProfile["text_layer_quality"]) {
  const base = layout === "table_heavy" || layout === "dense" ? 2100 : layout === "simple" ? 850 : 1300;
  const multiplier = textLayer === "none" ? 0.55 : textLayer === "poor" ? 0.7 : 1;
  return Math.round(pageCount * base * multiplier);
}

function containsFinancialData(documentType: DocumentType, features: ReturnType<typeof extractTextFeatures>) {
  return ["invoice", "bank_statement", "receipt", "tax_form", "loan_document", "financial_report"].includes(documentType)
    || features.currencyCount > 0
    || features.digitRatio > 0.12;
}

function confidenceFor(text: string, engine: string, hintedType?: string) {
  let confidence = text.length > 500 ? 0.84 : text.length > 80 ? 0.72 : 0.52;
  if (engine === "pdf_text_layer") confidence += 0.08;
  if (hintedType && hintedType !== "unknown") confidence += 0.04;
  return round4(Math.min(0.95, confidence));
}

function buildSignals(profile: DocumentProfile, features: ReturnType<typeof extractTextFeatures>, fileFeatures: Awaited<ReturnType<typeof extractFileFeatures>>, warnings: string[]) {
  const signals = [
    `file type: ${profile.file_type}`,
    `${profile.page_count || 1} page(s)`,
    `text layer: ${profile.text_layer_quality}`,
    `layout: ${profile.layout_complexity}`,
    `table density: ${Math.round((profile.table_density || 0) * 100)}%`,
    `table-like lines: ${features.tableLikeLineCount}`,
    `digit ratio: ${Math.round(features.digitRatio * 100)}%`,
    `file size bucket: ${fileFeatures.fileSizeBucket}`,
  ];
  if (profile.known_layout_id) signals.push(`known layout: ${profile.known_layout_id}`);
  if (profile.requires_reconciliation) signals.push("requires reconciliation");
  warnings.forEach((warning) => signals.push(`warning: ${warning}`));
  return signals;
}

function bucket(value: number, cuts: number[]) {
  if (value <= cuts[0]) return "low";
  if (value <= cuts[1]) return "medium";
  if (value <= cuts[2]) return "high";
  return "very_high";
}

function round4(value: number) {
  return Math.round(value * 10000) / 10000;
}
