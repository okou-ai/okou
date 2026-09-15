import { z } from "zod";

import {
  isSupportedRunModel,
  normalizeBuiltInModelId,
  supportedRunModelSchema,
} from "./model-providers";

const CODEX_REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;
const CLAUDE_CODE_EFFORTS = [
  "low",
  "medium",
  "high",
  "extra",
  "max",
  "ultracode",
] as const;

export const reasoningEffortSchema = z.union([
  z.enum(CODEX_REASONING_EFFORTS),
  z.enum(CLAUDE_CODE_EFFORTS),
]);

export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

const modelSettingSchema = z
  .object({
    effort: reasoningEffortSchema.optional(),
  })
  .strict();

export const modelSettingsSchema = z
  .partialRecord(supportedRunModelSchema, modelSettingSchema)
  .superRefine((settings, context) => {
    for (const model of supportedRunModelSchema.options) {
      const effort = settings[model]?.effort;
      if (effort && !isModelReasoningEffortSupported(model, effort)) {
        context.addIssue({
          code: "custom",
          path: [model, "effort"],
          message: "Reasoning effort is not supported by this model",
        });
      }
    }
  });

export type ModelSettings = z.infer<typeof modelSettingsSchema>;

export const modelSettingsPatchSchema = z
  .object({
    model: supportedRunModelSchema,
    effort: reasoningEffortSchema,
  })
  .strict();

export type ModelSettingsPatch = z.infer<typeof modelSettingsPatchSchema>;

/** Model preferences span runtimes; each execution route narrows these choices. */
export function getModelReasoningEfforts(
  model: string | null | undefined,
): readonly ReasoningEffort[] {
  const bareModel = model?.startsWith("openai/")
    ? model.slice("openai/".length)
    : model;
  switch (normalizeBuiltInModelId(bareModel ?? "")) {
    case "gpt-5.6-sol":
    case "gpt-5.6-terra":
    case "gpt-6-astra":
      return CODEX_REASONING_EFFORTS;
    case "gpt-5.6-luna":
      return ["low", "medium", "high", "xhigh", "max"];
    case "gpt-5.5":
      return ["low", "medium", "high", "xhigh"];
    case "claude-fable-5-1":
    case "claude-opus-5":
    case "claude-opus-4-8":
    case "claude-sonnet-5":
      // Ultracode is a Claude Code mode; preserve it for --effort instead of
      // translating it to an API reasoning level.
      return CLAUDE_CODE_EFFORTS;
    case "claude-sonnet-4-6":
      return ["low", "medium", "high", "max"];
    case "deepseek-v4-flash":
      return ["low", "high", "xhigh", "max"];
    case "deepseek-v4-pro":
      return ["high", "xhigh", "max"];
    default:
      return [];
  }
}

export function isModelReasoningEffortSupported(
  model: string | null | undefined,
  effort: ReasoningEffort,
): boolean {
  return getModelReasoningEfforts(model).includes(effort);
}

/** Match Okou's model launch defaults when a model has no saved override. */
export function defaultModelReasoningEffort(
  model: string | null | undefined,
): ReasoningEffort | undefined {
  const bareModel = model?.startsWith("openai/")
    ? model.slice("openai/".length)
    : model;
  switch (normalizeBuiltInModelId(bareModel ?? "")) {
    case "gpt-6-astra":
    case "gpt-5.6-sol":
    case "gpt-5.6-terra":
    case "gpt-5.6-luna":
    case "claude-fable-5-1":
      return "max";
    case "gpt-5.5":
      return "xhigh";
    case "claude-opus-5":
    case "claude-opus-4-8":
    case "claude-sonnet-5":
    case "claude-sonnet-4-6":
    case "deepseek-v4-flash":
    case "deepseek-v4-pro":
      return "high";
    default:
      return undefined;
  }
}

/** Product choices supported by the captured runtime and provider catalog. */
export function getRouteReasoningEfforts(args: {
  readonly model: string | null | undefined;
  readonly piExecution: boolean;
  readonly runtimeProviderType: string | null | undefined;
}): readonly ReasoningEffort[] {
  const choices = getModelReasoningEfforts(args.model);
  if (args.model === "deepseek-v4-flash" || args.model === "deepseek-v4-pro") {
    if (!args.piExecution) return [];
    if (args.runtimeProviderType === "openrouter-codex") {
      return ["high", "xhigh"];
    }
    if (
      args.runtimeProviderType === "deepseek" ||
      args.runtimeProviderType === "custom-openai-responses"
    ) {
      return choices.filter((effort) => {
        return effort !== "xhigh";
      });
    }
    return [];
  }
  return choices.filter((effort) => {
    return effort !== "ultracode" && (!args.piExecution || effort !== "ultra");
  });
}

/** An unavailable route choice falls back without changing the saved preference. */
export function resolveRouteReasoningEffort(args: {
  readonly model: string | null | undefined;
  readonly effort: ReasoningEffort | undefined;
  readonly piExecution: boolean;
  readonly runtimeProviderType: string | null | undefined;
}): ReasoningEffort | undefined {
  if (args.effort === undefined) return undefined;
  const choices = getRouteReasoningEfforts(args);
  if (choices.includes(args.effort)) return args.effort;
  const fallback = defaultModelReasoningEffort(args.model);
  return fallback && choices.includes(fallback) ? fallback : undefined;
}

/** Claude's product label differs from Pi's SDK vocabulary. */
export function piThinkingLevelForEffort(effort: ReasoningEffort) {
  switch (effort) {
    case "extra":
      return "xhigh";
    case "ultra":
    case "ultracode":
      throw new Error(`Reasoning effort ${effort} is not supported by Pi`);
    default:
      return effort;
  }
}

/** Resolve one model's preferred effort without borrowing another model's value. */
export function modelReasoningEffort(
  model: string | null | undefined,
  settings: ModelSettings | null | undefined,
): ReasoningEffort | undefined {
  if (!isSupportedRunModel(model)) {
    return undefined;
  }
  const saved = settings?.[model]?.effort;
  if (saved === undefined) {
    return defaultModelReasoningEffort(model);
  }
  if (!isModelReasoningEffortSupported(model, saved)) {
    throw new Error(`Reasoning effort ${saved} is not supported by ${model}`);
  }
  return saved;
}

/** Apply one concrete override. Deleting overrides is intentionally unsupported. */
export function withModelReasoningEffort(
  settings: ModelSettings | null | undefined,
  patch: ModelSettingsPatch,
): ModelSettings {
  return {
    ...settings,
    [patch.model]: {
      ...settings?.[patch.model],
      effort: patch.effort,
    },
  };
}
