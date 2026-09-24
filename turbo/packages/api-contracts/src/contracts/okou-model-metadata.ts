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
  readonly effectiveContextWindowPercent: number;
};

type OpenRouterModelLimits = {
  readonly contextLength: number;
  readonly maxCompletionTokens: number;
};

/** Snapshot of OpenRouter /api/v1/models for each exact backing-model ID. */
const OKOU_BACKING_MODELS = {
  "gpt-6-luna": {
    displayName: "GPT-6 Luna",
    openRouterModelId: "openai/gpt-6-luna",
    contextLength: 1_050_000,
    maxCompletionTokens: 128_000,
  },
  "gpt-6-sol": {
    displayName: "GPT-6 Sol",
    openRouterModelId: "openai/gpt-6-sol",
    contextLength: 1_050_000,
    maxCompletionTokens: 128_000,
  },
} as const satisfies Record<
  string,
  OpenRouterModelLimits & {
    readonly displayName: string;
    readonly openRouterModelId: string;
  }
>;

type OkouBackingModel = keyof typeof OKOU_BACKING_MODELS;

type OkouModelMetadata = {
  readonly displayName: string;
  readonly backingModel: OkouBackingModel;
  readonly presetModel: string;
  readonly reasoningEffort: "low" | "high" | "xhigh";
  readonly inputModalities: typeof OKOU_INPUT_MODALITIES;
  readonly pi: PiRuntimeLimits;
  readonly codex: CodexRuntimeLimits & { readonly priority: number };
  readonly openRouterModelId: string;
};

type OkouModelDefinition = {
  readonly displayName: string;
  readonly backingModel: OkouBackingModel;
  readonly presetModel: string;
  readonly reasoningEffort: "low" | "high" | "xhigh";
  readonly codexPriority: number;
};

function defineOkouModel(definition: OkouModelDefinition): OkouModelMetadata {
  const backingModel = OKOU_BACKING_MODELS[definition.backingModel];
  // Codex has no catalog field for max_completion_tokens. Its effective input
  // window therefore reserves the OpenRouter output ceiling from the total
  // context window, rounding down to avoid exceeding the provider's limit.
  const effectiveContextWindowPercent = Math.floor(
    ((backingModel.contextLength - backingModel.maxCompletionTokens) * 100) /
      backingModel.contextLength,
  );
  return {
    displayName: definition.displayName,
    backingModel: definition.backingModel,
    presetModel: definition.presetModel,
    reasoningEffort: definition.reasoningEffort,
    inputModalities: OKOU_INPUT_MODALITIES,
    openRouterModelId: backingModel.openRouterModelId,
    pi: {
      contextWindow: backingModel.contextLength,
      maxTokens: backingModel.maxCompletionTokens,
    },
    codex: {
      contextWindow: backingModel.contextLength,
      maxContextWindow: backingModel.contextLength,
      effectiveContextWindowPercent,
      priority: definition.codexPriority,
    },
  };
}

/** Okou aliases and OpenRouter model facts shared by both runtime projections. */
export const OKOU_MODEL_METADATA = {
  "okou-1.0": defineOkouModel({
    displayName: "Okou 1.0",
    backingModel: "gpt-6-luna",
    presetModel: "@preset/okou-1-0",
    reasoningEffort: "xhigh",
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
  xhigh: "Maximum reasoning depth for the hardest problems",
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
    const backingModel = OKOU_BACKING_MODELS[metadata.backingModel];
    return {
      ...CODEX_MODEL_DEFAULTS,
      slug,
      display_name: metadata.displayName,
      description: `OpenRouter preset backed by ${
        backingModel.displayName
      } (${backingModel.openRouterModelId}).`,
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
      effective_context_window_percent:
        metadata.codex.effectiveContextWindowPercent,
      input_modalities: [...metadata.inputModalities],
    };
  }),
};
