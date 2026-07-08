import { createClient } from "@supabase/supabase-js";

export interface AuthenticatedUser {
  id: string;
  email?: string;
}

export async function authenticateRequest(req: { header(name: string): string | undefined }): Promise<AuthenticatedUser | undefined> {
  const bearer = req.header("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!bearer) return undefined;
  const url = process.env.SUPABASE_URL;
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !publishableKey) return undefined;
  const supabase = createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.auth.getUser(bearer);
  if (error || !data.user) return undefined;
  return { id: data.user.id, email: data.user.email || undefined };
}

export async function resolveUserId(req: { header(name: string): string | undefined }, fallback?: string) {
  const authUser = await authenticateRequest(req);
  if (authUser?.id) return authUser.id;
  if (process.env.AUTH_REQUIRED === "true") throw new Error("Authentication required");
  return fallback;
}
