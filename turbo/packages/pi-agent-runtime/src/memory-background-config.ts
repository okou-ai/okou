import type { PiAgentThinkingLevel } from "./types";

/**
 * Background memory pipeline model and reasoning policy, defined once here and
 * imported by every consumer. It mirrors upstream Codex
 * (`DEFAULT_MEMORY_EXTRACTION_PREFERRED_MODEL` / `stage_one::REASONING_EFFORT`
 * and `DEFAULT_MEMORY_CONSOLIDATION_PREFERRED_MODEL` /
 * `stage_two::REASONING_EFFORT`). Phase 2 keeps its model where the API
 * dispatches the maintenance run (`PI_MEMORY_PHASE2_MODEL`).
 *
 * These values are deliberately independent from the foreground chat reasoning
 * defaults in `@okouai/api-contracts` (`model-reasoning-effort`): tuning the
 * foreground effort of a model must never change background extraction or
 * consolidation cost.
 */
export const PI_MEMORY_STAGE1_MODEL = "gpt-5.6-luna";
export const PI_MEMORY_STAGE1_REASONING = "low" satisfies PiAgentThinkingLevel;
export const PI_MEMORY_PHASE2_MAINTENANCE_REASONING =
  "medium" satisfies PiAgentThinkingLevel;
