/** Verified model/API pairs from #33565 (2026-09-13), not the entire US catalog. */
const US_MODELS: Readonly<Record<OpenRouterApi, readonly string[]>> = {
  messages: [
    "anthropic/claude-opus-5",
    "anthropic/claude-opus-4.8",
    "anthropic/claude-sonnet-5",
    "anthropic/claude-sonnet-4.6",
  ],
  responses: [
    "deepseek/deepseek-v4-flash",
    "deepseek/deepseek-v4-pro",
    "openai/gpt-6-astra",
    "openai/gpt-5.6-sol",
    "openai/gpt-5.6-terra",
    "openai/gpt-5.6-luna",
    "openai/gpt-5.5",
  ],
  // Gemini voice uses Google Cloud; remaining platform Chat models lack US support.
  "chat/completions": [],
  "audio/transcriptions": [],
};

export type OpenRouterApi =
  | "messages"
  | "responses"
  | "chat/completions"
  | "audio/transcriptions";

export interface OpenRouterRoutingContext {
  readonly credentialOwner: "builtin" | "organization" | "member";
  readonly model: string;
  readonly usRoutingEnabled: boolean;
}

const OPENROUTER_GLOBAL_ORIGIN = "https://openrouter.ai";
export const OPENROUTER_US_ORIGIN = "https://us.openrouter.ai";

/** Select once at the credential owner; retries retain the selected endpoint. */
export function getOpenRouterBaseUrl(
  api: OpenRouterApi,
  context: OpenRouterRoutingContext,
): string {
  const origin =
    context.usRoutingEnabled &&
    context.credentialOwner === "builtin" &&
    US_MODELS[api].includes(context.model)
      ? OPENROUTER_US_ORIGIN
      : OPENROUTER_GLOBAL_ORIGIN;
  return `${origin}${api === "messages" ? "/api" : "/api/v1"}`;
}
