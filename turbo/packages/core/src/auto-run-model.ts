/** The platform-owned chat route. Personal subscriptions are separate sources. */
export const AUTO_RUN_MODEL = "okou-1.0";
export const AUTO_RUN_PROVIDER = "openrouter-codex";
export const AUTO_RUN_UPSTREAM_MODEL = "@preset/okou-1-0";
export const AUTO_RUN_PRICING_PROVIDER = "okou-1.0";
/** Operator presets stay on the same managed Auto vendor and capability class. */
export function isAutoRunPreset(
  value: string | null | undefined,
): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("@preset/") &&
    value.length > "@preset/".length
  );
}
/** Preserve Auto's existing long-context classification without a catalog lookup. */
export const AUTO_RUN_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS = 272001;
