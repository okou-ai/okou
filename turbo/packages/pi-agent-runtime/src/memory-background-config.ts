import type { PiAgentThinkingLevel } from "./types";

/** Private, platform-funded memory identity; never a foreground model choice. */
export const PI_MEMORY_STAGE1_BUILT_IN_MODEL = "okou-memory";
export const PI_MEMORY_PRESET = "@preset/memory";
const PI_MEMORY_PRESET_REQUEST_FIELDS = [
  "model",
  "messages",
  "tools",
  "stream",
  "stream_options",
] as const;

/** Preserve the private preset wire policy for accepted maintenance Runs. */
export function memoryPresetPayload(payload: unknown): unknown {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    throw new Error("Invalid memory Chat Completions payload");
  }
  const allowed: ReadonlySet<string> = new Set(PI_MEMORY_PRESET_REQUEST_FIELDS);
  return Object.fromEntries(
    Object.entries(payload).filter(([key]) => {
      return allowed.has(key);
    }),
  );
}
export const PI_MEMORY_PHASE2_MAINTENANCE_REASONING =
  "medium" satisfies PiAgentThinkingLevel;
