import type { PiAgentThinkingLevel } from "./types";

/**
 * Background memory pipeline model and reasoning policy, defined once here and
 * imported by every consumer. It mirrors upstream Codex
 * (`DEFAULT_MEMORY_EXTRACTION_PREFERRED_MODEL` / `stage_one::REASONING_EFFORT`
 * and `DEFAULT_MEMORY_CONSOLIDATION_PREFERRED_MODEL` /
 * `stage_two::REASONING_EFFORT`). Phase 2 keeps its models where the API
 * dispatches the maintenance run (`PI_MEMORY_PHASE2_MODELS`).
 *
 * Both stages use GPT-6 Luna on the memory owner's current connected Codex
 * subscription, or on the fixed managed OpenRouter binding,
 * before execution; a selected attempt never falls back to another route.
 *
 * These values are deliberately independent from the foreground chat reasoning
 * defaults in `@okouai/api-contracts` (`model-reasoning-effort`): tuning the
 * foreground effort of a model must never change background extraction or
 * consolidation cost.
 *
 * The fixed OpenRouter maintenance binding is independent of foreground Auto.
 */
export const PI_MEMORY_STAGE1_BUILT_IN_MODEL = "gpt-6-luna";
export const PI_MEMORY_STAGE1_PERSONAL_MODEL = "gpt-6-luna";

export type PiMemoryStage1Model =
  | typeof PI_MEMORY_STAGE1_BUILT_IN_MODEL
  | typeof PI_MEMORY_STAGE1_PERSONAL_MODEL;

/**
 * Both Luna credential routes publish `low` for extraction.
 */
export const PI_MEMORY_STAGE1_REASONING = "low" satisfies PiAgentThinkingLevel;

/** Both Luna credential routes publish `medium` for consolidation. */
export const PI_MEMORY_PHASE2_MAINTENANCE_REASONING =
  "medium" satisfies PiAgentThinkingLevel;

/**
 * Consolidation effort for a maintenance model that does not publish `medium`.
 *
 * Captured historical built-in runs can still resolve DeepSeek V4.1 Flash. It
 * maps `medium` to nothing, so the request cannot carry that effort. `high` is that
 * model's documented default reasoning level, and Phase 2 owns durable memory
 * state, so it takes the stronger published neighbour rather than a weaker one.
 */
export const PI_MEMORY_PHASE2_BUILT_IN_MAINTENANCE_REASONING =
  "high" satisfies PiAgentThinkingLevel;
