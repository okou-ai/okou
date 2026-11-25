import { enum as zEnum } from "zod";

export const MODEL_PROVIDER_TYPE_IDS = [
  "claude-code-oauth-token",
  "openrouter-codex",
  "codex-oauth-token",
  "antigravity",
  "built-in",
] as const;

export type ModelProviderType = (typeof MODEL_PROVIDER_TYPE_IDS)[number];

export const modelProviderTypeSchema = zEnum(MODEL_PROVIDER_TYPE_IDS);
export type BuiltInModelProviderType = Extract<ModelProviderType, "built-in">;

export function isBuiltInModelProviderType(
  type: string | null | undefined,
): type is BuiltInModelProviderType {
  return type === "built-in";
}

/** A member's own Claude Code, Codex or Google AI (Antigravity) account. */
export type PersonalSubscriptionProviderType = Extract<
  ModelProviderType,
  "claude-code-oauth-token" | "codex-oauth-token" | "antigravity"
>;

export function isPersonalSubscriptionProviderType(
  type: string | null | undefined,
): type is PersonalSubscriptionProviderType {
  return (
    type === "claude-code-oauth-token" ||
    type === "codex-oauth-token" ||
    type === "antigravity"
  );
}

export type ModelProviderFramework = "claude-code" | "codex";
