import { ModelProvider, ModelSpec, ModelTier } from "../types.js";

export const MODEL_CATALOG: ModelSpec[] = [
  model("claude-haiku-4-5", "Claude Haiku 4.5", "anthropic", "nano", "cloud", 0.0008, 0.004, 200000, 300, true, true, true, 8192, 68, ["soc2"], false),
  model("gpt-4o-mini", "GPT-4o Mini", "openai", "nano", "cloud", 0.00015, 0.0006, 128000, 350, true, true, true, 16384, 65, ["soc2"], false),
  model("gemini-2.0-flash", "Gemini 2.0 Flash", "google", "nano", "cloud", 0.0001, 0.0004, 1000000, 250, true, true, true, 8192, 67, ["soc2"], false),
  model("mistral-small-3.1", "Mistral Small 3.1", "mistral", "small", "cloud", 0.0001, 0.0003, 128000, 400, true, true, true, 8192, 70, ["soc2", "gdpr"], false),
  model("llama-3.2-11b-vision", "Llama 3.2 11B Vision", "meta", "small", "self-hosted", 0.00015, 0.00025, 128000, 600, true, false, true, 4096, 62, ["hipaa", "gdpr"], true),
  model("claude-sonnet-4-6", "Claude Sonnet 4.6", "anthropic", "mid", "cloud", 0.003, 0.015, 200000, 800, true, true, true, 16384, 85, ["soc2", "gdpr", "hipaa"], false),
  model("gpt-4o", "GPT-4o", "openai", "mid", "cloud", 0.0025, 0.01, 128000, 900, true, true, true, 16384, 83, ["soc2", "gdpr", "hipaa"], false),
  model("llama-3.3-70b", "Llama 3.3 70B", "meta", "mid", "self-hosted", 0.0004, 0.0006, 128000, 1200, false, true, true, 8192, 79, ["hipaa", "gdpr"], true),
  model("qwen-2.5-72b", "Qwen 2.5 72B", "qwen", "mid", "self-hosted", 0.0004, 0.0006, 128000, 1100, false, true, true, 8192, 81, ["hipaa", "gdpr"], true),
  model("deepseek-v3", "DeepSeek V3", "deepseek", "mid", "cloud", 0.00027, 0.0011, 128000, 900, false, true, true, 8192, 82, ["soc2"], false),
  model("claude-opus-4-6", "Claude Opus 4.6", "anthropic", "frontier", "cloud", 0.015, 0.075, 200000, 2000, true, true, true, 32768, 97, ["soc2", "gdpr", "hipaa"], false),
  model("gpt-5", "GPT-5", "openai", "frontier", "cloud", 0.015, 0.06, 256000, 2500, true, true, true, 32768, 96, ["soc2", "gdpr", "hipaa"], false),
  model("gemini-2.5-pro", "Gemini 2.5 Pro", "google", "frontier", "cloud", 0.00125, 0.01, 1000000, 1800, true, true, true, 32768, 94, ["soc2", "gdpr", "hipaa"], false),
  model("deepseek-r1-671b", "DeepSeek R1 671B", "deepseek", "frontier", "self-hosted", 0.002, 0.003, 128000, 3000, false, true, true, 32768, 92, ["hipaa", "gdpr"], true),
];

export function listModels(filters: {
  tier_filter?: ModelTier;
  provider_filter?: ModelProvider;
  open_weight_only?: boolean;
  compliance_required?: string[];
} = {}) {
  return MODEL_CATALOG.filter((modelSpec) => {
    if (filters.tier_filter && modelSpec.tier !== filters.tier_filter) return false;
    if (filters.provider_filter && modelSpec.provider !== filters.provider_filter) return false;
    if (filters.open_weight_only && !modelSpec.isOpenWeight) return false;
    if (filters.compliance_required && !hasCompliance(modelSpec, filters.compliance_required)) return false;
    return true;
  });
}

export function hasCompliance(modelSpec: ModelSpec, required: string[] = []) {
  return required.every((tag) => modelSpec.complianceTags.includes(tag));
}

function model(
  id: string,
  name: string,
  provider: ModelProvider,
  tier: ModelTier,
  hosting: ModelSpec["hosting"],
  input: number,
  output: number,
  contextWindow: number,
  latency: number,
  vision: boolean,
  functions: boolean,
  structured: boolean,
  maxOutput: number,
  quality: number,
  compliance: string[],
  openWeight: boolean,
): ModelSpec {
  return {
    id,
    name,
    provider,
    tier,
    hosting,
    costPer1kInputTokens: input,
    costPer1kOutputTokens: output,
    contextWindow,
    avgLatencyMs: latency,
    supportsVision: vision,
    supportsFunctionCalling: functions,
    supportsStructuredOutput: structured,
    maxOutputTokens: maxOutput,
    qualityScore: quality,
    complianceTags: compliance,
    isOpenWeight: openWeight,
  };
}
