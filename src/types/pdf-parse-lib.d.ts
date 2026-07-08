declare module "pdf-parse/lib/pdf-parse.js" {
  interface PdfParseResult {
    numpages?: number;
    text?: string;
    info?: Record<string, unknown>;
    metadata?: unknown;
    version?: string;
  }

  export default function pdfParse(buffer: Buffer): Promise<PdfParseResult>;
}
