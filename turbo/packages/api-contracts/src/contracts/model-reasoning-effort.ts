import { z } from "zod";

import { runModelIdSchema } from "./model-providers";

/** The effort vocabulary of the Codex and Claude Code harnesses. */
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

// Keys are catalog model IDs. Only the effort vocabulary is checked here; the
// server accepts an effort when the model's catalog route lists it.
export const modelSettingsSchema = z.record(
  runModelIdSchema,
  modelSettingSchema,
);

export type ModelSettings = z.infer<typeof modelSettingsSchema>;

export const modelSettingsPatchSchema = z
  .object({
    model: runModelIdSchema,
    effort: reasoningEffortSchema,
  })
  .strict();

export type ModelSettingsPatch = z.infer<typeof modelSettingsPatchSchema>;

/**
 * Protocol narrowing of a route's catalog efforts for one execution: Pi and
 * non-Pi runtimes and DeepSeek's concrete providers accept different subsets.
 */
export function narrowRouteReasoningEfforts(args: {
  readonly model: string | null | undefined;
  readonly efforts: readonly ReasoningEffort[];
  readonly piExecution: boolean;
  readonly runtimeProviderType: string | null | undefined;
}): readonly ReasoningEffort[] {
  const choices = args.efforts;
  if (args.model === "deepseek-v4-flash" || args.model === "deepseek-v4-pro") {
    if (!args.piExecution) return [];
    if (args.runtimeProviderType === "openrouter-codex") {
      return choices.filter((effort) => {
        return effort === "high" || effort === "xhigh";
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
  readonly efforts: readonly ReasoningEffort[];
  readonly defaultEffort: ReasoningEffort | undefined;
  readonly piExecution: boolean;
  readonly runtimeProviderType: string | null | undefined;
}): ReasoningEffort | undefined {
  if (args.effort === undefined) return undefined;
  const choices = narrowRouteReasoningEfforts(args);
  if (choices.includes(args.effort)) return args.effort;
  return args.defaultEffort && choices.includes(args.defaultEffort)
    ? args.defaultEffort
    : undefined;
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
