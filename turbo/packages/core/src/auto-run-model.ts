/** Canonical Auto identity for new selections and captured decisions. */
export const AUTO_SELECTED_MODEL = "auto";

/** Selected Auto aliases only; absence and runtime presets are not selections. */
export function isAutoSelectedModel(model: string | null | undefined): boolean {
  return model === AUTO_SELECTED_MODEL || model === AUTO_RUN_MODEL;
}

/** New preference copies keep explicit-model overrides, never Auto/preset effort.
 * Existing saved objects remain readable; #38114 owns historical conversion.
 */
export function explicitModelSettings<T>(
  settings: Readonly<Record<string, T>>,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(settings).filter(([model]) => {
      return !isAutoSelectedModel(model) && !model.startsWith("@preset/");
    }),
  );
}

/** Compare selectable choices across the nullable and explicit Auto protocols. */
export function sameSelectedModel(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  return (
    left === right ||
    ((left === null || isAutoSelectedModel(left)) &&
      (right === null || isAutoSelectedModel(right)))
  );
}

/** Legacy captured Auto ID/catalog metadata. Retire only under #38114's gates. */
export const AUTO_RUN_MODEL = "okou-1.0";
export const AUTO_RUN_PROVIDER = "openrouter-codex";
/** The `built_in_model_keys.vendor` of the managed OpenRouter key Auto runs on. */
export const AUTO_RUN_KEY_VENDOR = "openrouter";
export const AUTO_RUN_UPSTREAM_MODEL = "@preset/okou-1-0";
export const AUTO_RUN_PRICING_PROVIDER = "okou-1.0";

/** Canonical captured Auto bills its runtime; old captures keep their original key. */
export function autoRunBillingProvider(
  selectedModel: string,
  runtimeModel: string,
): string {
  return selectedModel === AUTO_SELECTED_MODEL
    ? runtimeModel
    : AUTO_RUN_PRICING_PROVIDER;
}
/** Operator presets stay on the same managed Auto vendor and capability class. */
export function isAutoRunPreset(
  value: string | null | undefined,
): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("@preset/") &&
    value.length > "@preset/".length &&
    // agent_runs.model_runtime_model must retain the complete immutable identity.
    value.length <= 255
  );
}
/** Preserve Auto's existing long-context classification without a catalog lookup. */
export const AUTO_RUN_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS = 272001;
