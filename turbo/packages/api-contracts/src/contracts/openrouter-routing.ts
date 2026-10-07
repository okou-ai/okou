/** Product-approved model/API pairs, not the entire US catalog. */
const US_MODELS: Readonly<Record<OpenRouterApi, readonly string[]>> = {
  messages: [
    "anthropic/claude-opus-5.5",
    "anthropic/claude-opus-5",
    "anthropic/claude-sonnet-5",
  ],
  responses: [
    "openai/gpt-6-astra",
    "openai/gpt-5.6-sol",
    "openai/gpt-5.6-luna",
  ],
  // Remaining platform Chat Completions models lack verified US support.
  "chat/completions": [],
};

export type OpenRouterApi = "messages" | "responses" | "chat/completions";

/** Every OpenRouter credential is a platform-owned built-in key. */
export interface OpenRouterRoutingContext {
  readonly model: string;
}

const OPENROUTER_GLOBAL_ORIGIN = "https://openrouter.ai";
export const OPENROUTER_US_ORIGIN = "https://us.openrouter.ai";

/** Select once per captured route; retries retain the selected endpoint. */
export function getOpenRouterBaseUrl(
  api: OpenRouterApi,
  context: OpenRouterRoutingContext,
): string {
  const origin = US_MODELS[api].includes(context.model)
    ? OPENROUTER_US_ORIGIN
    : OPENROUTER_GLOBAL_ORIGIN;
  return `${origin}${api === "messages" ? "/api" : "/api/v1"}`;
}
