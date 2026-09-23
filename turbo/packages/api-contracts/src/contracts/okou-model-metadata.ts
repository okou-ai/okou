export const OKOU_RUN_MODELS = [
  "okou-1.0",
  "okou-1.0-pro",
  "okou-1.0-max",
] as const;

export type OkouRunModel = (typeof OKOU_RUN_MODELS)[number];

const OKOU_INPUT_MODALITIES = ["text", "image"] as const;

type PiRuntimeLimits = {
  readonly contextWindow: number;
  readonly maxTokens: number;
};

type CodexRuntimeLimits = {
  readonly contextWindow: number;
  readonly maxContextWindow: number;
};

// Pi reflects the OpenRouter model limits. Codex's context_window and
// max_context_window follow the GPT-6 entries in Codex's own model catalog;
// they are runtime-specific values, not contradictory limits on the model.
const GPT_6_PI_LIMITS = {
  contextWindow: 1_050_000,
  maxTokens: 128_000,
} as const satisfies PiRuntimeLimits;

const GPT_6_CODEX_LIMITS = {
  contextWindow: 272_000,
  maxContextWindow: 872_000,
} as const satisfies CodexRuntimeLimits;

const OKOU_BACKING_MODELS = {
  "gpt-6-luna": {
    displayName: "GPT-6 Luna",
    pi: GPT_6_PI_LIMITS,
    codex: GPT_6_CODEX_LIMITS,
  },
  "gpt-6-sol": {
    displayName: "GPT-6 Sol",
    pi: GPT_6_PI_LIMITS,
    codex: GPT_6_CODEX_LIMITS,
  },
} as const;

type OkouBackingModel = keyof typeof OKOU_BACKING_MODELS;

type OkouModelMetadata = {
  readonly displayName: string;
  readonly backingModel: OkouBackingModel;
  readonly presetModel: string;
  readonly reasoningEffort: "low" | "high" | "max";
  readonly inputModalities: typeof OKOU_INPUT_MODALITIES;
  readonly pi: PiRuntimeLimits;
  readonly codex: CodexRuntimeLimits & { readonly priority: number };
};

type OkouModelDefinition = {
  readonly displayName: string;
  readonly backingModel: OkouBackingModel;
  readonly presetModel: string;
  readonly reasoningEffort: "low" | "high" | "max";
  readonly codexPriority: number;
};

function defineOkouModel(definition: OkouModelDefinition): OkouModelMetadata {
  const backingModel = OKOU_BACKING_MODELS[definition.backingModel];
  return {
    displayName: definition.displayName,
    backingModel: definition.backingModel,
    presetModel: definition.presetModel,
    reasoningEffort: definition.reasoningEffort,
    inputModalities: OKOU_INPUT_MODALITIES,
    pi: backingModel.pi,
    codex: { ...backingModel.codex, priority: definition.codexPriority },
  };
}

/** Product-owned model facts shared by the Pi and Codex runtime projections. */
export const OKOU_MODEL_METADATA = {
  "okou-1.0": defineOkouModel({
    displayName: "Okou 1.0",
    backingModel: "gpt-6-luna",
    presetModel: "@preset/okou-1-0",
    reasoningEffort: "max",
    codexPriority: 3,
  }),
  "okou-1.0-pro": defineOkouModel({
    displayName: "Okou 1.0 Pro",
    backingModel: "gpt-6-sol",
    presetModel: "@preset/okou-1-0-pro",
    reasoningEffort: "low",
    codexPriority: 2,
  }),
  "okou-1.0-max": defineOkouModel({
    displayName: "Okou 1.0 Max",
    backingModel: "gpt-6-sol",
    presetModel: "@preset/okou-1-0-max",
    reasoningEffort: "high",
    codexPriority: 2,
  }),
} as const satisfies Record<OkouRunModel, OkouModelMetadata>;

const CODEX_REASONING_DESCRIPTIONS = {
  low: "Fast responses with lighter reasoning",
  high: "Greater reasoning depth for complex problems",
  max: "Maximum reasoning depth for the hardest problems",
} as const;

const CODEX_MODEL_DEFAULTS = {
  shell_type: "shell_command",
  visibility: "list",
  supported_in_api: true,
  include_skills_usage_instructions: false,
  include_plugin_usage_instructions: false,
  include_apps_usage_instructions: false,
  supports_reasoning_summary_parameter: true,
  default_reasoning_summary: "none",
  support_verbosity: true,
  default_verbosity: "low",
  apply_patch_tool_type: "freeform",
  web_search_tool_type: "text_and_image",
  truncation_policy: {
    mode: "tokens",
    limit: 10_000,
  },
  supports_image_detail_original: true,
  comp_hash: "3000",
  experimental_supported_tools: ["send_user_message_async", "clock"],
  supports_search_tool: true,
  supports_experimental_context: false,
  use_responses_lite: true,
  supports_reasoning_effort_updates: false,
  node_repl_auto_review_required: true,
  node_repl_disabled: false,
  tool_mode: "code_mode_only",
  multi_agent_version: "v2",
} as const;

/** Codex-only runtime catalog, projected from the shared Okou model facts. */
export const OKOU_MODEL_CODEX_CATALOG = {
  models: OKOU_RUN_MODELS.map((slug) => {
    const metadata = OKOU_MODEL_METADATA[slug];
    return {
      ...CODEX_MODEL_DEFAULTS,
      slug,
      display_name: metadata.displayName,
      description: `OpenRouter preset backed by ${
        OKOU_BACKING_MODELS[metadata.backingModel].displayName
      }.`,
      default_reasoning_level: metadata.reasoningEffort,
      supported_reasoning_levels: [
        {
          effort: metadata.reasoningEffort,
          description: CODEX_REASONING_DESCRIPTIONS[metadata.reasoningEffort],
        },
      ],
      priority: metadata.codex.priority,
      context_window: metadata.codex.contextWindow,
      max_context_window: metadata.codex.maxContextWindow,
      input_modalities: [...metadata.inputModalities],
    };
  }),
};
