import fs from "node:fs/promises";
import syncFs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { DocumentProfile } from "../types.js";

const execFileAsync = promisify(execFile);

export interface UploadedDocument {
  path: string;
  originalName: string;
  mimeType: string;
  size: number;
}

export interface OcrResult {
  text: string;
  engine: "pdf_text_layer" | "tesseract" | "paddleocr" | "none";
  warnings: string[];
  profilePatch: Partial<DocumentProfile>;
  metadata?: Record<string, unknown>;
}

export async function runNonLlmOcr(file: UploadedDocument): Promise<OcrResult> {
  const lower = file.originalName.toLowerCase();
  if (file.mimeType === "application/pdf" || lower.endsWith(".pdf")) return extractPdfText(file);
  if (file.mimeType.startsWith("image/") || /\.(png|jpe?g|tiff?|bmp|webp)$/i.test(lower)) return extractImageText(file);
  return {
    text: "",
    engine: "none",
    warnings: [`Unsupported file type for OCR: ${file.mimeType || path.extname(file.originalName) || "unknown"}.`],
    profilePatch: { file_type: "unknown", has_text_layer: false, text_layer_quality: "unknown" },
  };
}

async function extractPdfText(file: UploadedDocument): Promise<OcrResult> {
  const buffer = await fs.readFile(file.path);
  try {
    const parsed = await pdfParse(buffer);
    const text = normalizeText(parsed.text || "");
    const pageCount = parsed.numpages || estimatePdfPages(file.size);
    const hasText = text.length > 80;
    const result: OcrResult = {
      text,
      engine: hasText ? "pdf_text_layer" : "none",
      warnings: hasText ? [] : ["PDF text layer is missing or too sparse; scanned PDF image OCR is not configured in this local build."],
      profilePatch: {
        file_type: "pdf",
        page_count: pageCount,
        character_count: text.length,
        has_text_layer: hasText,
        text_layer_quality: hasText ? (text.length / Math.max(1, pageCount || 1) > 500 ? "good" : "partial") : "none",
      },
    };
    if (hasText || !shouldRunPaddleOcr()) return result;
    return runPaddleOcr(file, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const fallback = recoverPdfTextFromContentStream(buffer);
    const pageCount = fallback.pageCount || estimatePdfPages(file.size);
    const hasText = fallback.text.length > 40;
    const fallbackResult: OcrResult = {
      text: fallback.text,
      engine: hasText ? "pdf_text_layer" : "none",
      warnings: [
        hasText
          ? `PDF text-layer parser could not read this file (${message}); recovered text from raw PDF content streams.`
          : `PDF text-layer parser could not read this file (${message}). The router will continue using file metadata and sparse-PDF signals.`,
      ],
      profilePatch: {
        file_type: "pdf",
        page_count: pageCount,
        character_count: fallback.text.length,
        has_text_layer: hasText,
        text_layer_quality: hasText ? (fallback.text.length / Math.max(1, pageCount) > 500 ? "good" : "partial") : "none",
        image_quality: hasText ? "medium" : "unknown",
      },
    };
    if (hasText || !shouldRunPaddleOcr()) return fallbackResult;
    return runPaddleOcr(file, fallbackResult);
  }
}

async function extractImageText(file: UploadedDocument): Promise<OcrResult> {
  try {
    const { stdout } = await execFileAsync(tesseractCommand(), [file.path, "stdout", "--psm", "6"], { timeout: 60000, maxBuffer: 10 * 1024 * 1024 });
    const text = normalizeText(stdout || "");
    return {
      text,
      engine: "tesseract",
      warnings: text.length ? [] : ["Tesseract ran but returned no text."],
      profilePatch: {
        file_type: "image",
        page_count: 1,
        character_count: text.length,
        has_text_layer: false,
        text_layer_quality: "none",
        image_quality: text.length > 80 ? "medium" : "low",
      },
    };
  } catch (error) {
    return {
      text: "",
      engine: "none",
      warnings: [`Image OCR requires the tesseract CLI. ${error instanceof Error ? error.message : String(error)}`],
      profilePatch: {
        file_type: "image",
        page_count: 1,
        character_count: 0,
        has_text_layer: false,
        text_layer_quality: "none",
        image_quality: "unknown",
      },
    };
  }
}

async function runPaddleOcr(file: UploadedDocument, fallback: OcrResult): Promise<OcrResult> {
  try {
    const scriptPath = path.join(process.cwd(), "scripts", "paddle_ocr_bridge.py");
    const python = process.env.PADDLE_OCR_PYTHON || "py";
    const args = python.toLowerCase().endsWith("py")
      ? ["-3.11", scriptPath, file.path, String(process.env.PADDLE_OCR_MAX_PAGES || 1)]
      : [scriptPath, file.path, String(process.env.PADDLE_OCR_MAX_PAGES || 1)];
    const { stdout } = await execFileAsync(python, args, {
      timeout: Number(process.env.PADDLE_OCR_TIMEOUT_MS || 150000),
      maxBuffer: 50 * 1024 * 1024,
      env: {
        ...process.env,
        PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: process.env.PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK || "True",
      },
    });
    const parsed = JSON.parse(stdout) as {
      text?: string;
      average_confidence?: number;
      pages?: Array<{ average_confidence?: number; line_count?: number; table_rows?: unknown[] }>;
      table_row_count?: number;
      line_count?: number;
    };
    const text = normalizeText(parsed.text || "");
    if (!text) return {
      ...fallback,
      warnings: [...fallback.warnings, "PaddleOCR ran but returned no text."],
      metadata: { ...(fallback.metadata || {}), paddleocr: parsed },
    };
    const pageCount = parsed.pages?.length || fallback.profilePatch.page_count || 1;
    return {
      text,
      engine: "paddleocr",
      warnings: [
        ...fallback.warnings.filter((warning) => !/text OCR is unavailable|scanned PDF image OCR is not configured/i.test(warning)),
        `PaddleOCR read ${text.length} characters across ${pageCount} page(s) with ${Math.round((parsed.average_confidence || 0) * 100)}% average confidence.`,
      ],
      profilePatch: {
        ...fallback.profilePatch,
        character_count: text.length,
        has_text_layer: false,
        text_layer_quality: "none",
        image_quality: "high",
        table_count: Math.max(Number(fallback.profilePatch.table_count || 0), Number(parsed.table_row_count || 0)),
        table_density: Math.max(Number(fallback.profilePatch.table_density || 0), Number(parsed.table_row_count || 0) > 0 ? 0.72 : 0),
        confidence: Math.max(Number(fallback.profilePatch.confidence || 0), Number(parsed.average_confidence || 0)),
      },
      metadata: {
        ...(fallback.metadata || {}),
        paddleocr: parsed,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...fallback,
      warnings: [...fallback.warnings, `PaddleOCR unavailable or failed: ${message}`],
    };
  }
}

function tesseractCommand() {
  if (process.env.TESSERACT_CMD) return process.env.TESSERACT_CMD;
  const windowsPath = "C:\\Program Files\\Tesseract-OCR\\tesseract.exe";
  return syncFs.existsSync(windowsPath) ? windowsPath : "tesseract";
}

function shouldRunPaddleOcr() {
  if (process.env.ENABLE_PADDLE_OCR === "false") return false;
  if (process.env.ENABLE_PADDLE_OCR === "true") return true;
  return process.platform === "win32";
}

function normalizeText(text: string) {
  return text.replace(/\r/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function estimatePdfPages(size: number) {
  if (size > 4_000_000) return 24;
  if (size > 1_500_000) return 12;
  if (size > 600_000) return 6;
  return 2;
}

function recoverPdfTextFromContentStream(buffer: Buffer) {
  const raw = buffer.toString("latin1");
  const pageCount = Number(raw.match(/\/Count\s+(\d+)/)?.[1] || 0) || undefined;
  const streamTexts: string[] = [];
  const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let streamMatch: RegExpExecArray | null;
  while ((streamMatch = streamRegex.exec(raw))) {
    streamTexts.push(...extractPdfTextOperators(streamMatch[1]));
  }
  if (!streamTexts.length) streamTexts.push(...extractPdfTextOperators(raw));
  return {
    text: normalizeText(streamTexts.join("\n")),
    pageCount,
  };
}

function extractPdfTextOperators(source: string) {
  const texts: string[] = [];
  const literalBeforeOperator = /\((?:\\.|[^\\)])*\)\s*(?:Tj|'|")/g;
  const arrayBeforeOperator = /\[((?:\s*\((?:\\.|[^\\)])*\)\s*-?\d*)+)\s*\]\s*TJ/g;
  let match: RegExpExecArray | null;
  while ((match = literalBeforeOperator.exec(source))) {
    const literal = match[0].match(/\((?:\\.|[^\\)])*\)/)?.[0];
    if (literal) texts.push(decodePdfLiteral(literal));
  }
  while ((match = arrayBeforeOperator.exec(source))) {
    const parts = match[1].match(/\((?:\\.|[^\\)])*\)/g) || [];
    const line = parts.map(decodePdfLiteral).join("");
    if (line.trim()) texts.push(line);
  }
  return texts;
}

function decodePdfLiteral(literal: string) {
  return literal
    .slice(1, -1)
    .replace(/\\([nrtbf()\\])/g, (_match, code: string) => {
      const map: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
      return map[code] || code;
    })
    .replace(/\\([0-7]{1,3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}
