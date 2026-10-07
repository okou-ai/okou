export const MODEL_PROVIDER_TYPE_IDS = [
  "claude-code-oauth-token",
  "anthropic-api-key",
  "openrouter-api-key",
  "deepseek",
  "openrouter-codex",
  "openai-api-key",
  "codex-oauth-token",
  "built-in",
] as const;

export type ModelProviderType = (typeof MODEL_PROVIDER_TYPE_IDS)[number];
export type ModelProviderWriteType = ModelProviderType;
export type BuiltInModelProviderType = Extract<ModelProviderType, "built-in">;

export function isBuiltInModelProviderType(
  type: string | null | undefined,
): type is BuiltInModelProviderType {
  return type === "built-in";
}

export type ModelProviderFramework = "claude-code" | "codex";
