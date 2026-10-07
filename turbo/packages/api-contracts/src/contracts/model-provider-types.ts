export const MODEL_PROVIDER_TYPE_IDS = [
  "claude-code-oauth-token",
  "openrouter-codex",
  "codex-oauth-token",
  "built-in",
] as const;

export type ModelProviderType = (typeof MODEL_PROVIDER_TYPE_IDS)[number];
export type BuiltInModelProviderType = Extract<ModelProviderType, "built-in">;

export function isBuiltInModelProviderType(
  type: string | null | undefined,
): type is BuiltInModelProviderType {
  return type === "built-in";
}

export type ModelProviderFramework = "claude-code" | "codex";
