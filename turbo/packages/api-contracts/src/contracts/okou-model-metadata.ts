export const OKOU_RUN_MODELS = [
  "okou-1.0",
  "okou-1.0-pro",
  "okou-1.0-max",
] as const;

export type OkouRunModel = (typeof OKOU_RUN_MODELS)[number];

const OKOU_INPUT_MODALITIES = ["text", "image"] as const;

// These limits are consumed by different runtime schemas: Pi's Model fields
// and Codex's default/max context-window fields. Keep each runtime projection
// explicit rather than treating the fields as interchangeable.
const PI_RUNTIME_LIMITS = {
  contextWindow: 1_050_000,
  maxTokens: 128_000,
} as const;

const CODEX_RUNTIME_LIMITS = {
  contextWindow: 272_000,
  maxContextWindow: 872_000,
} as const;

type OkouModelMetadata = {
  readonly displayName: string;
  readonly backingModel: string;
  readonly presetModel: string;
  readonly reasoningEffort: "low" | "high" | "max";
  readonly inputModalities: typeof OKOU_INPUT_MODALITIES;
  readonly pi: typeof PI_RUNTIME_LIMITS;
  readonly codex: typeof CODEX_RUNTIME_LIMITS & { readonly priority: number };
};

/** Product-owned model facts shared by the Pi and Codex runtime projections. */
export const OKOU_MODEL_METADATA = {
  "okou-1.0": {
    displayName: "Okou 1.0",
    backingModel: "GPT-6 Luna",
    presetModel: "@preset/okou-1-0",
    reasoningEffort: "max",
    inputModalities: OKOU_INPUT_MODALITIES,
    pi: PI_RUNTIME_LIMITS,
    codex: {
      ...CODEX_RUNTIME_LIMITS,
      priority: 3,
    },
  },
  "okou-1.0-pro": {
    displayName: "Okou 1.0 Pro",
    backingModel: "GPT-6 Sol",
    presetModel: "@preset/okou-1-0-pro",
    reasoningEffort: "low",
    inputModalities: OKOU_INPUT_MODALITIES,
    pi: PI_RUNTIME_LIMITS,
    codex: {
      ...CODEX_RUNTIME_LIMITS,
      priority: 2,
    },
  },
  "okou-1.0-max": {
    displayName: "Okou 1.0 Max",
    backingModel: "GPT-6 Sol",
    presetModel: "@preset/okou-1-0-max",
    reasoningEffort: "high",
    inputModalities: OKOU_INPUT_MODALITIES,
    pi: PI_RUNTIME_LIMITS,
    codex: {
      ...CODEX_RUNTIME_LIMITS,
      priority: 2,
    },
  },
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
      description: `OpenRouter preset backed by ${metadata.backingModel}.`,
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
