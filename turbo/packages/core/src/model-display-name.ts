import type { CodexServiceTier } from "@okouai/api-contracts/contracts/chat-threads";

import { IMAGE_MODEL_CONFIGS, resolveImageModel } from "./image-model-catalog";

/**
 * Human-readable display names for model IDs across all providers.
 * Falls back to the raw model ID if no mapping is found.
 */
const MODEL_DISPLAY_NAMES = Object.freeze<Record<string, string>>({
  // Anthropic direct (claude-code-oauth-token, anthropic-api-key, built-in)
  "claude-fable-5-1": "Claude Fable 5.1",
  "claude-fable-5": "Claude Fable 5",
  "claude-opus-5": "Claude Opus 5",
  "claude-sonnet-5": "Claude Sonnet 5",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-opus-4-8": "Claude Opus 4.8",
  "claude-haiku-4-5": "Claude Haiku 4.5",
  // Anthropic via OpenRouter / Vercel AI Gateway
  "anthropic/claude-fable-5.1": "Claude Fable 5.1",
  "anthropic/claude-fable-5": "Claude Fable 5",
  "anthropic/claude-opus-5": "Claude Opus 5",
  "anthropic/claude-sonnet-5": "Claude Sonnet 5",
  "anthropic/claude-sonnet-4.6": "Claude Sonnet 4.6",
  "anthropic/claude-opus-4.8": "Claude Opus 4.8",
  "anthropic/claude-sonnet-4.5": "Claude Sonnet 4.5",
  "anthropic/claude-opus-4.5": "Claude Opus 4.5",
  "anthropic/claude-haiku-4.5": "Claude Haiku 4.5",
  // Canonical DeepSeek model IDs
  "deepseek-v4.1-flash": "DeepSeek V4.1 Flash",
  "deepseek-v4-flash": "DeepSeek V4 Flash",
  "deepseek-v4-pro": "DeepSeek V4 Pro",
  // MiniMax via shared gateways
  "minimax/minimax-m2.5": "MiniMax M2.5",
  // Minimax via OpenRouter
  "minimax/minimax-m2.7": "MiniMax M2.7",
  // OpenAI / Codex
  "gpt-6-astra": "GPT 6 Astra",
  "openai/gpt-6-astra": "GPT 6 Astra",
  "gpt-5.6-sol": "GPT 5.6 Sol",
  "gpt-5.6-terra": "GPT 5.6 Terra",
  "gpt-5.6-luna": "GPT 5.6 Luna",
  "gpt-5.5": "GPT 5.5",
  "gpt-5.3-codex": "GPT-5.3 Codex",
  "gpt-5.2": "GPT-5.2",
  // Built-in video generation
  "dreamina-seedance-2-5-260628": "Seedance 2.5",
  "dreamina-seedance-2-0-260128": "Seedance 2.0",
  "dreamina-seedance-2-0-fast-260128": "Seedance 2.0 Fast",
  "dreamina-seedance-2-0-mini-260615": "Seedance 2.0 Mini",
  "seedance-2-0-260128": "Seedance 2.0",
  "seedance-2-0-fast-260128": "Seedance 2.0 Fast",
  "seedance-1-5-pro-251215": "Seedance 1.5 Pro",
  "MiniMax-H3": "MiniMax H3",
  "fal-ai/veo3.1": "Veo 3.1",
  "fal-ai/veo3.1/fast": "Veo 3.1 Fast",
  "fal-ai/kling-video/o3/standard/text-to-video": "Kling O3 Standard",
  "fal-ai/kling-video/v3/4k/text-to-video": "Kling 3 4K",
});

/**
 * Get a human-readable display name for a model ID.
 * Returns the raw model ID if no friendly name is defined.
 */
export function getModelDisplayName(model: string): string {
  const imageModel = resolveImageModel(model);
  if (imageModel !== undefined) {
    return IMAGE_MODEL_CONFIGS[imageModel].label;
  }
  return MODEL_DISPLAY_NAMES[model] ?? model;
}

/**
 * Get the model label for one run, including its user-facing service tier.
 */
export function getRunModelDisplayName(
  model: string,
  codexServiceTier: CodexServiceTier | null | undefined,
): string {
  const modelName = getModelDisplayName(model);
  return codexServiceTier === "fast" ? `${modelName} Fast` : modelName;
}
