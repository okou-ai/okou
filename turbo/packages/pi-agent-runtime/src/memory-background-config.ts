import type { PiAgentThinkingLevel } from "./types";

/** Private, platform-funded memory identity; never a foreground model choice. */
export const PI_MEMORY_STAGE1_BUILT_IN_MODEL = "okou-memory";
export const PI_MEMORY_PRESET = "@preset/memory";
export const PI_MEMORY_PRESET_REQUEST_FIELDS = [
  "model",
  "messages",
  "tools",
  "stream",
  "stream_options",
] as const;

/** Retained historical subscription identity, not a new credential candidate. */
export const PI_MEMORY_STAGE1_PERSONAL_MODEL = "gpt-6-luna";
export type PiMemoryStage1Model =
  | typeof PI_MEMORY_STAGE1_BUILT_IN_MODEL
  | typeof PI_MEMORY_STAGE1_PERSONAL_MODEL;

// Legacy extraction still recognizes its captured request policy. New preset
// requests omit reasoning and sampling parameters at the transport boundary.
export const PI_MEMORY_STAGE1_REASONING = "low" satisfies PiAgentThinkingLevel;
export const PI_MEMORY_PHASE2_MAINTENANCE_REASONING =
  "medium" satisfies PiAgentThinkingLevel;

/** Both stages and all attempts share one owner-scoped OpenRouter cache route. */
export function piMemorySessionAffinityKey(
  userId: string,
  orgId: string,
): string {
  return `MEMORY-${userId}-${orgId}`;
}
