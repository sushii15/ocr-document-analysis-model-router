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
  engine: "pdf_text_layer" | "tesseract" | "none";
  warnings: string[];
  profilePatch: Partial<DocumentProfile>;
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
    return {
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const pageCount = estimatePdfPages(file.size);
    return {
      text: "",
      engine: "none",
      warnings: [
        `PDF text-layer parser could not read this file (${message}). The router will continue using file metadata and sparse-PDF signals.`,
      ],
      profilePatch: {
        file_type: "pdf",
        page_count: pageCount,
        character_count: 0,
        has_text_layer: false,
        text_layer_quality: "none",
        image_quality: "unknown",
      },
    };
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

function tesseractCommand() {
  if (process.env.TESSERACT_CMD) return process.env.TESSERACT_CMD;
  const windowsPath = "C:\\Program Files\\Tesseract-OCR\\tesseract.exe";
  return syncFs.existsSync(windowsPath) ? windowsPath : "tesseract";
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
