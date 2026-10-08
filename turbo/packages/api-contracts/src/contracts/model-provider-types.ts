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

/** A member's own Claude Code or Codex subscription account. */
export type PersonalSubscriptionProviderType = Extract<
  ModelProviderType,
  "claude-code-oauth-token" | "codex-oauth-token"
>;

export function isPersonalSubscriptionProviderType(
  type: string | null | undefined,
): type is PersonalSubscriptionProviderType {
  return type === "claude-code-oauth-token" || type === "codex-oauth-token";
}

export type ModelProviderFramework = "claude-code" | "codex";
