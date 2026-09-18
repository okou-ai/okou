import {
  isActiveRunModel,
  isBuiltInModelProviderType,
  isModelSupportedByProvider,
  modelProviderTypeSchema,
} from "@okouai/api-contracts/contracts/model-providers";
import { piNativeCatalogModelSchema } from "@okouai/api-contracts/contracts/pi-native-models";

export type PiGptModel = "gpt-5.6-terra" | "gpt-5.6-sol" | "gpt-5.6-luna";

/** Admission and API-owned billing must expand together. */
export function isPiGptModel(
  model: string | null | undefined,
): model is PiGptModel {
  return (
    model === "gpt-5.6-terra" ||
    model === "gpt-5.6-sol" ||
    model === "gpt-5.6-luna"
  );
}

export type PiDeepSeekModel =
  | "deepseek-v4-flash"
  | "deepseek-v4-pro"
  | "deepseek-v4.1-flash";

/** Keep admission, credential capture and API-owned billing on the same set. */
export function isPiDeepSeekModel(
  model: string | null | undefined,
): model is PiDeepSeekModel {
  return (
    model === "deepseek-v4-flash" ||
    model === "deepseek-v4-pro" ||
    model === "deepseek-v4.1-flash"
  );
}

export function isPiNativeModel(model: string | null | undefined): boolean {
  return (
    typeof model === "string" &&
    isActiveRunModel(model) &&
    piNativeCatalogModelSchema.safeParse(model).success
  );
}

export function isPiNativeRoute(
  type: string | null | undefined,
  model: string | null | undefined,
): boolean {
  const provider = modelProviderTypeSchema.safeParse(type);
  return (
    isPiNativeModel(model) &&
    typeof model === "string" &&
    provider.success &&
    provider.data !== "claude-code-oauth-token" &&
    (provider.data === "custom-anthropic-messages" ||
      isModelSupportedByProvider(model, provider.data))
  );
}

function isGptApiKeyPiProviderType(value: string | null | undefined): boolean {
  return (
    value === "openai-api-key" ||
    value === "openrouter-codex" ||
    value === "vercel-ai-gateway-codex"
  );
}

function isDeepSeekPiProviderType(
  value: string | null | undefined,
): value is "deepseek" | "openrouter-codex" {
  return value === "deepseek" || value === "openrouter-codex";
}

/** Shared by Chat controls and server admission; trigger source does not select a runtime. */
export function isPiExecutionRoute(args: {
  readonly selectedModel: string | null | undefined;
  readonly modelProviderType: string | null | undefined;
  readonly runtimeProviderType: string | null | undefined;
  readonly codexServiceTier: "fast" | undefined;
  readonly piEnabled: boolean;
}): boolean {
  if (!args.piEnabled) return false;
  if (isPiNativeRoute(args.modelProviderType, args.selectedModel)) return true;
  const builtIn = isBuiltInModelProviderType(args.modelProviderType);
  const custom = args.modelProviderType === "custom-openai-responses";
  if (isPiDeepSeekModel(args.selectedModel)) {
    return (
      (builtIn && isDeepSeekPiProviderType(args.runtimeProviderType)) ||
      custom ||
      (isDeepSeekPiProviderType(args.modelProviderType) &&
        isModelSupportedByProvider(args.selectedModel, args.modelProviderType))
    );
  }
  if (!isPiGptModel(args.selectedModel)) return false;
  const direct =
    args.modelProviderType === "codex-oauth-token" ||
    isGptApiKeyPiProviderType(args.modelProviderType);
  if (!builtIn && !custom && !direct) return false;
  return (
    args.codexServiceTier === undefined ||
    custom ||
    direct ||
    (builtIn &&
      (args.runtimeProviderType === "openai-api-key" ||
        args.runtimeProviderType === "openrouter-codex"))
  );
}
