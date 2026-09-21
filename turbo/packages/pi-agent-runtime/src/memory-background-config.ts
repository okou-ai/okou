import type { PiAgentThinkingLevel } from "./types";

/**
 * Background memory pipeline model and reasoning policy, defined once here and
 * imported by every consumer. It mirrors upstream Codex
 * (`DEFAULT_MEMORY_EXTRACTION_PREFERRED_MODEL` / `stage_one::REASONING_EFFORT`
 * and `DEFAULT_MEMORY_CONSOLIDATION_PREFERRED_MODEL` /
 * `stage_two::REASONING_EFFORT`). Phase 2 keeps its models where the API
 * dispatches the maintenance run (`PI_MEMORY_PHASE2_MODELS`).
 *
 * Both stages pin to the source run's own provider binding and have no
 * fallback, so the model is chosen per binding. The built-in binding runs the
 * cheaper DeepSeek Flash pair; every BYOK binding keeps the GPT pair, because
 * no BYOK provider serves those DeepSeek models.
 *
 * These values are deliberately independent from the foreground chat reasoning
 * defaults in `@okouai/api-contracts` (`model-reasoning-effort`): tuning the
 * foreground effort of a model must never change background extraction or
 * consolidation cost.
 */
export const PI_MEMORY_STAGE1_BUILT_IN_MODEL = "deepseek-v4-flash";
export const PI_MEMORY_STAGE1_BYOK_MODEL = "gpt-5.6-luna";

export type PiMemoryStage1Model =
  | typeof PI_MEMORY_STAGE1_BUILT_IN_MODEL
  | typeof PI_MEMORY_STAGE1_BYOK_MODEL;

/** Both extraction models publish `low`, so one stateless request keeps it. */
export const PI_MEMORY_STAGE1_REASONING = "low" satisfies PiAgentThinkingLevel;

/** BYOK consolidation keeps `medium`, which its GPT model publishes. */
export const PI_MEMORY_PHASE2_MAINTENANCE_REASONING =
  "medium" satisfies PiAgentThinkingLevel;

/**
 * Consolidation effort for a maintenance model that does not publish `medium`.
 *
 * Only the built-in binding resolves such a model: DeepSeek V4.1 Flash maps
 * `medium` to nothing, so the request cannot carry that effort. `high` is that
 * model's documented default reasoning level, and Phase 2 owns durable memory
 * state, so it takes the stronger published neighbour rather than a weaker one.
 */
export const PI_MEMORY_PHASE2_BUILT_IN_MAINTENANCE_REASONING =
  "high" satisfies PiAgentThinkingLevel;
