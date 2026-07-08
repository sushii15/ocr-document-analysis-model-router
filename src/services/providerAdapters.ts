import { ExecuteRequest, ProviderExecutionResult, RoutingDecision } from "../types.js";

const providerKeys: Record<string, string | undefined> = {
  anthropic: process.env.ANTHROPIC_API_KEY,
  openai: process.env.OPENAI_API_KEY,
  google: process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY,
  mistral: process.env.MISTRAL_API_KEY,
};

export async function executeWithProvider(
  decision: RoutingDecision,
  request: ExecuteRequest,
): Promise<ProviderExecutionResult> {
  const model = decision.selectedModel;
  const startedAt = Date.now();
  if (request.dry_run !== false) return dryRun(decision, request, startedAt, "dry_run_enabled");

  try {
    if (model.provider === "openai") return await executeOpenAI(decision, request, startedAt);
    if (model.provider === "anthropic") return await executeAnthropic(decision, request, startedAt);
    if (model.provider === "google") return await executeGemini(decision, request, startedAt);
    if (model.provider === "mistral") return await executeMistral(decision, request, startedAt);
    if (model.hosting === "self-hosted") return await executeOpenAICompatible(decision, request, startedAt);
    return dryRun(decision, request, startedAt, "provider_not_configured");
  } catch (error) {
    if (decision.fallbackModel) {
      return {
        ...dryRun(decision, request, startedAt, `provider_error:${error instanceof Error ? error.message : String(error)}`),
        finishReason: "fallback_required",
      };
    }
    throw error;
  }
}

async function executeOpenAI(decision: RoutingDecision, request: ExecuteRequest, startedAt: number) {
  const apiKey = request.provider_credentials?.openai?.apiKey || providerKeys.openai;
  if (!apiKey) return dryRun(decision, request, startedAt, "missing_OPENAI_API_KEY");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: decision.selectedModel.id,
      instructions: request.system_prompt,
      input: request.prompt,
      temperature: request.temperature,
      max_output_tokens: request.max_output_tokens,
    }),
  });
  const body = await parseResponse(response);
  return result(decision, extractOpenAIText(body), Date.now() - startedAt, false, body, body.usage?.input_tokens, body.usage?.output_tokens);
}

async function executeAnthropic(decision: RoutingDecision, request: ExecuteRequest, startedAt: number) {
  const apiKey = request.provider_credentials?.anthropic?.apiKey || providerKeys.anthropic;
  if (!apiKey) return dryRun(decision, request, startedAt, "missing_ANTHROPIC_API_KEY");

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: decision.selectedModel.id,
      system: request.system_prompt,
      messages: [{ role: "user", content: request.prompt }],
      max_tokens: request.max_output_tokens || 1024,
      temperature: request.temperature,
    }),
  });
  const body = await parseResponse(response);
  return result(decision, extractAnthropicText(body), Date.now() - startedAt, false, body, body.usage?.input_tokens, body.usage?.output_tokens);
}

async function executeGemini(decision: RoutingDecision, request: ExecuteRequest, startedAt: number) {
  const apiKey = request.provider_credentials?.google?.apiKey || providerKeys.google;
  if (!apiKey) return dryRun(decision, request, startedAt, "missing_GOOGLE_API_KEY");

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${decision.selectedModel.id}:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: request.system_prompt ? { parts: [{ text: request.system_prompt }] } : undefined,
      contents: [{ role: "user", parts: [{ text: request.prompt }] }],
      generationConfig: {
        temperature: request.temperature,
        maxOutputTokens: request.max_output_tokens,
      },
    }),
  });
  const body = await parseResponse(response);
  return result(decision, extractGeminiText(body), Date.now() - startedAt, false, body, body.usageMetadata?.promptTokenCount, body.usageMetadata?.candidatesTokenCount);
}

async function executeMistral(decision: RoutingDecision, request: ExecuteRequest, startedAt: number) {
  const apiKey = request.provider_credentials?.mistral?.apiKey || providerKeys.mistral;
  if (!apiKey) return dryRun(decision, request, startedAt, "missing_MISTRAL_API_KEY");

  const messages = [
    ...(request.system_prompt ? [{ role: "system", content: request.system_prompt }] : []),
    { role: "user", content: request.prompt },
  ];
  const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: decision.selectedModel.id,
      messages,
      temperature: request.temperature,
      max_tokens: request.max_output_tokens,
    }),
  });
  const body = await parseResponse(response);
  return result(decision, body.choices?.[0]?.message?.content || "", Date.now() - startedAt, false, body, body.usage?.prompt_tokens, body.usage?.completion_tokens);
}

async function executeOpenAICompatible(decision: RoutingDecision, request: ExecuteRequest, startedAt: number) {
  const baseUrl = request.provider_credentials?.self_hosted?.baseUrl || process.env.OPENAI_COMPATIBLE_BASE_URL || process.env.OLLAMA_BASE_URL || process.env.VLLM_BASE_URL;
  const apiKey = request.provider_credentials?.self_hosted?.apiKey || process.env.OPENAI_COMPATIBLE_API_KEY || process.env.OLLAMA_API_KEY || "local";
  if (!baseUrl) return dryRun(decision, request, startedAt, "missing_self_hosted_endpoint");

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: decision.selectedModel.id,
      messages: [
        ...(request.system_prompt ? [{ role: "system", content: request.system_prompt }] : []),
        { role: "user", content: request.prompt },
      ],
      temperature: request.temperature,
      max_tokens: request.max_output_tokens,
    }),
  });
  const body = await parseResponse(response);
  return result(decision, body.choices?.[0]?.message?.content || "", Date.now() - startedAt, false, body, body.usage?.prompt_tokens, body.usage?.completion_tokens);
}

function dryRun(decision: RoutingDecision, request: ExecuteRequest, startedAt: number, reason: string): ProviderExecutionResult {
  const outputText = JSON.stringify(buildDryRunExtraction(decision, request, reason), null, 2);
  return result(decision, outputText, Date.now() - startedAt, true, { reason });
}

function buildDryRunExtraction(decision: RoutingDecision, request: ExecuteRequest, reason: string) {
  const base = {
    demo_mode: true,
    dry_run_reason: reason,
    selected_model: decision.selectedModel.id,
    confidence: 0.5,
    note: "Demo output generated because the selected provider is not connected yet.",
  };

  if (decision.detectedTaskType === "bank_statement_extraction") {
    return {
      ...base,
      account_holder_name: null,
      account_last4: null,
      bank_name: null,
      statement_period: null,
      opening_balance: null,
      closing_balance: null,
      deposits_credits_total: null,
      withdrawals_debits_total: null,
      fees_and_charges: null,
      reconciliation_status: "not_checked_in_demo_mode",
      transactions: [
        {
          date: null,
          description: "Provider API key required for real extraction",
          amount: null,
          debit_credit: null,
          running_balance: null,
        },
      ],
    };
  }

  if (decision.detectedTaskType === "invoice_extraction") {
    return {
      ...base,
      vendor_name: null,
      vendor_address: null,
      invoice_number: null,
      invoice_date: null,
      due_date: null,
      customer_name: null,
      subtotal: null,
      tax: null,
      discounts_fees: null,
      total_amount_due: null,
      payment_terms: null,
      purchase_order_number: null,
      currency: null,
      line_items: [
        {
          description: "Provider API key required for real extraction",
          quantity: null,
          unit_price: null,
          amount: null,
          confidence: 0.5,
        },
      ],
    };
  }

  return {
    ...base,
    fields: {
      requested_extraction: request.prompt.slice(0, 240),
      real_extraction_status: "waiting_for_provider_key",
    },
    tables: [],
  };
}

function result(
  decision: RoutingDecision,
  outputText: string,
  actualLatencyMs: number,
  dryRun: boolean,
  raw?: unknown,
  inputTokens?: number,
  outputTokens?: number,
): ProviderExecutionResult {
  const actualCostUsd = inputTokens !== undefined && outputTokens !== undefined
    ? roundMoney((inputTokens / 1000) * decision.selectedModel.costPer1kInputTokens + (outputTokens / 1000) * decision.selectedModel.costPer1kOutputTokens)
    : undefined;
  return {
    provider: decision.selectedModel.provider,
    modelId: decision.selectedModel.id,
    outputText,
    inputTokens,
    outputTokens,
    actualCostUsd,
    actualLatencyMs,
    dryRun,
    raw,
  };
}

async function parseResponse(response: Response): Promise<any> {
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = body.error?.message || body.message || response.statusText;
    throw new Error(`${response.status} ${message}`);
  }
  return body;
}

function extractOpenAIText(body: any) {
  if (typeof body.output_text === "string") return body.output_text;
  return (body.output || [])
    .flatMap((item: any) => item.content || [])
    .map((content: any) => content.text || "")
    .join("");
}

function extractAnthropicText(body: any) {
  return (body.content || [])
    .map((part: any) => part.text || "")
    .join("");
}

function extractGeminiText(body: any) {
  return (body.candidates?.[0]?.content?.parts || [])
    .map((part: any) => part.text || "")
    .join("");
}

function roundMoney(value: number) {
  return Math.round(value * 1000000) / 1000000;
}
