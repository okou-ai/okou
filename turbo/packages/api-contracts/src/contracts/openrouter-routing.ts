/** Product-approved model/API pairs, not the entire US catalog. */
const US_MODELS: Readonly<Record<OpenRouterApi, readonly string[]>> = {
  responses: [
    "openai/gpt-6-astra",
    "openai/gpt-5.6-sol",
    "openai/gpt-5.6-luna",
  ],
  // Remaining platform Chat Completions models lack verified US support.
  "chat/completions": [],
};

export type OpenRouterApi = "responses" | "chat/completions";

export interface OpenRouterRoutingContext {
  readonly credentialOwner: "builtin" | "member";
  readonly model: string;
}

const OPENROUTER_GLOBAL_ORIGIN = "https://openrouter.ai";
export const OPENROUTER_US_ORIGIN = "https://us.openrouter.ai";

/** Select once at the credential owner; retries retain the selected endpoint. */
export function getOpenRouterBaseUrl(
  api: OpenRouterApi,
  context: OpenRouterRoutingContext,
): string {
  const origin =
    context.credentialOwner === "builtin" &&
    US_MODELS[api].includes(context.model)
      ? OPENROUTER_US_ORIGIN
      : OPENROUTER_GLOBAL_ORIGIN;
  return `${origin}/api/v1`;
}
