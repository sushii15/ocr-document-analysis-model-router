import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { withSupabaseDb } from "./supabaseDb.js";
import { runtimeDataDir } from "./runtimePaths.js";

export interface UserModelPreference {
  modelId: string;
  provider: string;
  enabled: boolean;
  priority?: number;
}

export interface UserOnboardingProfile {
  userId: string;
  displayName?: string;
  onboardingCompleted: boolean;
  defaultStrategy: "cost" | "quality" | "latency" | "balanced";
  modelPreferences: UserModelPreference[];
  updatedAt: string;
}

const profileDir = process.env.V2_PROFILE_DIR || runtimeDataDir("v2-profiles");
const profilePath = path.join(profileDir, "profiles.json");

export async function saveUserOnboardingProfile(input: {
  userId: string;
  displayName?: string;
  defaultStrategy?: UserOnboardingProfile["defaultStrategy"];
  modelPreferences: UserModelPreference[];
}) {
  const profiles = loadProfiles();
  const updatedAt = new Date().toISOString();
  const profile: UserOnboardingProfile = {
    userId: input.userId,
    displayName: input.displayName,
    onboardingCompleted: true,
    defaultStrategy: input.defaultStrategy || "balanced",
    modelPreferences: input.modelPreferences,
    updatedAt,
  };
  profiles.set(input.userId, profile);
  saveProfiles(profiles);
  await mirrorProfile(profile);
  return profile;
}

export function getUserOnboardingProfile(userId: string): UserOnboardingProfile | undefined {
  return loadProfiles().get(userId);
}

export function getEnabledModelIdsForUser(userId?: string) {
  if (!userId) return undefined;
  const profile = getUserOnboardingProfile(userId);
  return profile?.modelPreferences.filter((pref) => pref.enabled).map((pref) => pref.modelId);
}

function loadProfiles() {
  const profiles = new Map<string, UserOnboardingProfile>();
  try {
    if (!fs.existsSync(profilePath)) return profiles;
    const parsed = JSON.parse(fs.readFileSync(profilePath, "utf8")) as UserOnboardingProfile[];
    for (const profile of Array.isArray(parsed) ? parsed : []) profiles.set(profile.userId, profile);
  } catch (error) {
    console.error("Failed to load V2 user profiles:", error);
  }
  return profiles;
}

function saveProfiles(profiles: Map<string, UserOnboardingProfile>) {
  fs.mkdirSync(profileDir, { recursive: true });
  const tempPath = `${profilePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(Array.from(profiles.values()), null, 2));
  fs.renameSync(tempPath, profilePath);
}

async function mirrorProfile(profile: UserOnboardingProfile) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    await withSupabaseDb(async (client) => {
      await client.query("begin");
      try {
        await client.query(
          `insert into public.docrouter_v2_user_profiles
            (user_id, display_name, onboarding_completed, default_strategy, updated_at)
           values ($1,$2,$3,$4,$5)
           on conflict (user_id)
           do update set display_name=excluded.display_name,
             onboarding_completed=excluded.onboarding_completed,
             default_strategy=excluded.default_strategy,
             updated_at=excluded.updated_at`,
          [profile.userId, profile.displayName || null, profile.onboardingCompleted, profile.defaultStrategy, profile.updatedAt],
        );
        await client.query("delete from public.docrouter_v2_user_model_preferences where user_id=$1", [profile.userId]);
        for (const pref of profile.modelPreferences) {
          await client.query(
            `insert into public.docrouter_v2_user_model_preferences
              (user_id, model_id, provider, enabled, priority, updated_at)
             values ($1,$2,$3,$4,$5,$6)
             on conflict (user_id, model_id)
             do update set provider=excluded.provider, enabled=excluded.enabled, priority=excluded.priority, updated_at=excluded.updated_at`,
            [profile.userId, pref.modelId, pref.provider, pref.enabled, pref.priority ?? null, profile.updatedAt],
          );
        }
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      }
    });
    return;
  }

  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: profileError } = await supabase.from("docrouter_v2_user_profiles").upsert({
    user_id: profile.userId,
    display_name: profile.displayName || null,
    onboarding_completed: profile.onboardingCompleted,
    default_strategy: profile.defaultStrategy,
    updated_at: profile.updatedAt,
  }, { onConflict: "user_id" });
  if (profileError) throw profileError;

  const { error: deleteError } = await supabase.from("docrouter_v2_user_model_preferences").delete().eq("user_id", profile.userId);
  if (deleteError) throw deleteError;

  if (profile.modelPreferences.length) {
    const { error: prefError } = await supabase.from("docrouter_v2_user_model_preferences").upsert(
      profile.modelPreferences.map((pref) => ({
        user_id: profile.userId,
        model_id: pref.modelId,
        provider: pref.provider,
        enabled: pref.enabled,
        priority: pref.priority ?? null,
        updated_at: profile.updatedAt,
      })),
      { onConflict: "user_id,model_id" },
    );
    if (prefError) throw prefError;
  }
}
