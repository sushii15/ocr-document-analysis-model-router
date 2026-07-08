import fs from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { UploadedDocument } from "./ocrService.js";

export interface StoredDocumentRef {
  bucket?: string;
  path?: string;
  skippedReason?: string;
}

const bucket = process.env.V2_STORAGE_BUCKET || "docrouter-v2-documents";

export async function storeUploadedDocument(input: {
  userId?: string;
  sessionId: string;
  runId: string;
  file: UploadedDocument;
}): Promise<StoredDocumentRef> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { skippedReason: "missing_supabase_storage_credentials" };

  const owner = sanitizePathSegment(input.userId || `session-${input.sessionId}`);
  const fileName = sanitizeFileName(input.file.originalName);
  const storagePath = `${owner}/${input.runId}/${fileName}`;
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const bytes = await fs.readFile(input.file.path);
  const { error } = await supabase.storage.from(bucket).upload(storagePath, bytes, {
    contentType: input.file.mimeType || undefined,
    upsert: true,
  });
  if (error) throw error;
  return { bucket, path: storagePath };
}

function sanitizePathSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "unknown";
}

function sanitizeFileName(value: string) {
  const parsed = path.parse(value);
  const base = sanitizePathSegment(parsed.name || "document");
  const ext = parsed.ext.replace(/[^a-zA-Z0-9.]/g, "").slice(0, 12);
  return `${base}${ext}`;
}
