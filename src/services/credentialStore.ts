import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { ModelProvider } from "../types.js";
import { withSupabaseDb } from "./supabaseDb.js";

export type CredentialProvider = ModelProvider | "self_hosted";

export interface ProviderCredentialInput {
  sessionId: string;
  userId?: string;
  provider: CredentialProvider;
  apiKey: string;
  baseUrl?: string;
}

export interface ProviderCredentialSummary {
  provider: CredentialProvider;
  hasApiKey: boolean;
  hasBaseUrl: boolean;
  keyFingerprint?: string;
  updatedAt: string;
}

interface StoredCredential {
  sessionId: string;
  userId?: string;
  provider: CredentialProvider;
  encryptedApiKey: string;
  keyFingerprint?: string;
  baseUrl?: string;
  updatedAt: string;
}

const credentialDir = process.env.V2_CREDENTIAL_DIR || path.join(process.cwd(), ".docrouter", "v2-credentials");
const credentialPath = path.join(credentialDir, "credentials.json");

export async function saveProviderCredential(input: ProviderCredentialInput): Promise<ProviderCredentialSummary> {
  const records = loadCredentialRecords();
  const updatedAt = new Date().toISOString();
  const next: StoredCredential = {
    sessionId: input.sessionId,
    userId: input.userId,
    provider: input.provider,
    encryptedApiKey: encryptSecret(input.apiKey),
    keyFingerprint: fingerprintSecret(input.apiKey),
    baseUrl: input.baseUrl,
    updatedAt,
  };
  const key = credentialKey(input.sessionId, input.userId, input.provider);
  records.set(key, next);
  saveCredentialRecords(records);
  await mirrorCredentialSummary(next);
  return toSummary(next);
}

export function listProviderCredentials(sessionId: string, userId?: string): ProviderCredentialSummary[] {
  return Array.from(loadCredentialRecords().values())
    .filter((record) => record.sessionId === sessionId || (userId && record.userId === userId))
    .map(toSummary)
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

export function getProviderCredential(sessionId: string, userId: string | undefined, provider: CredentialProvider) {
  const records = loadCredentialRecords();
  const exact = records.get(credentialKey(sessionId, userId, provider));
  const sessionOnly = records.get(credentialKey(sessionId, undefined, provider));
  const userRecord = userId
    ? Array.from(records.values()).find((record) => record.userId === userId && record.provider === provider)
    : undefined;
  const record = exact || userRecord || sessionOnly;
  if (!record) return undefined;
  return {
    apiKey: decryptSecret(record.encryptedApiKey),
    baseUrl: record.baseUrl,
  };
}

export function buildCredentialMap(sessionId: string, userId: string | undefined, providers: CredentialProvider[]) {
  return Object.fromEntries(
    providers
      .map((provider) => [provider, getProviderCredential(sessionId, userId, provider)] as const)
      .filter(([, credential]) => Boolean(credential)),
  );
}

function loadCredentialRecords() {
  const records = new Map<string, StoredCredential>();
  try {
    if (!fs.existsSync(credentialPath)) return records;
    const parsed = JSON.parse(fs.readFileSync(credentialPath, "utf8")) as StoredCredential[];
    for (const record of Array.isArray(parsed) ? parsed : []) {
      records.set(credentialKey(record.sessionId, record.userId, record.provider), record);
    }
  } catch (error) {
    console.error("Failed to load V2 credentials:", error);
  }
  return records;
}

function saveCredentialRecords(records: Map<string, StoredCredential>) {
  fs.mkdirSync(credentialDir, { recursive: true, mode: 0o700 });
  const tempPath = `${credentialPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(Array.from(records.values()), null, 2), { mode: 0o600 });
  fs.renameSync(tempPath, credentialPath);
}

function credentialKey(sessionId: string, userId: string | undefined, provider: CredentialProvider) {
  return userId ? `user::${userId}::${provider}` : `session::${sessionId}::${provider}`;
}

function toSummary(record: StoredCredential): ProviderCredentialSummary {
  return {
    provider: record.provider,
    hasApiKey: Boolean(record.encryptedApiKey),
    hasBaseUrl: Boolean(record.baseUrl),
    keyFingerprint: record.keyFingerprint,
    updatedAt: record.updatedAt,
  };
}

function encryptionKey() {
  const raw = process.env.V2_CREDENTIAL_ENCRYPTION_KEY || process.env.ROUTER_API_KEY || "docrouter-local-development-key";
  return crypto.createHash("sha256").update(raw).digest();
}

function encryptSecret(value: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function fingerprintSecret(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function decryptSecret(value: string) {
  const buffer = Buffer.from(value, "base64");
  const iv = buffer.subarray(0, 12);
  const tag = buffer.subarray(12, 28);
  const encrypted = buffer.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

async function mirrorCredentialSummary(record: StoredCredential) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const credentialId = record.userId ? `user::${record.userId}::${record.provider}` : `session::${record.sessionId}::${record.provider}`;
  const dbSessionId = record.userId ? `user::${record.userId}` : record.sessionId;
  if (!url || !key) {
    await withSupabaseDb((client) => client.query(
      `insert into public.docrouter_v2_provider_credentials
        (credential_id, session_id, user_id, provider, encrypted_api_key, key_fingerprint, base_url, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (credential_id)
       do update set user_id=excluded.user_id, encrypted_api_key=excluded.encrypted_api_key,
         key_fingerprint=excluded.key_fingerprint, base_url=excluded.base_url, updated_at=excluded.updated_at`,
      [
        credentialId,
        dbSessionId,
        record.userId || null,
        record.provider,
        record.encryptedApiKey,
        record.keyFingerprint || null,
        record.baseUrl || null,
        record.updatedAt,
      ],
    ));
    return;
  }
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await supabase.from("docrouter_v2_provider_credentials").upsert({
    credential_id: credentialId,
    session_id: dbSessionId,
    user_id: record.userId || null,
    provider: record.provider,
    encrypted_api_key: record.encryptedApiKey,
    key_fingerprint: record.keyFingerprint || null,
    base_url: record.baseUrl || null,
    updated_at: record.updatedAt,
  }, { onConflict: "credential_id" });
  if (error) throw error;
}
