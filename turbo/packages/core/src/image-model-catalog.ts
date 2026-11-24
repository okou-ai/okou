/**
 * Catalog of prompt-based built-in image generation models.
 *
 * Provider request shapes, pricing, and model-specific parameters stay in the
 * API service. Members choose their model in Settings > Built-in tools.
 */
import {
  isImageModelId,
  type ImageModelId,
} from "@okouai/api-contracts/contracts/image-models";

export {
  DEFAULT_IMAGE_MODEL,
  IMAGE_MODEL_CONFIGS,
  PUBLIC_IMAGE_MODELS,
} from "@okouai/api-contracts/contracts/image-models";
export type ImageModel = ImageModelId;

export const IMAGE_MODEL_ALIASES = {
  "gpt-image-2": "gpt-image-2",
  "gpt-image-2.5-flare": "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst": "gpt-image-2.5-sunburst",
  "gpt-image-1": "gpt-image-1",
  "flux-pro-1.1": "fal-ai/flux-pro/v1.1",
  "flux-pro-1.1-ultra": "fal-ai/flux-pro/v1.1-ultra",
  "flux-2-pro": "fal-ai/flux-2-pro",
  "qwen-image-3": "alibaba/qwen-image-3/text-to-image",
  "ideogram-4": "ideogram/v4",
  seedream4: "fal-ai/bytedance/seedream/v4/text-to-image",
  "nano-banana-2": "fal-ai/nano-banana-2",
  "nano-banana2": "fal-ai/nano-banana-2",
  "nano-banana-2-lite": "google/nano-banana-2-lite",
  "nano-banana2-lite": "google/nano-banana-2-lite",
} as const satisfies Readonly<Record<string, ImageModel>>;

type ImageModelAlias = keyof typeof IMAGE_MODEL_ALIASES;

function isImageModelAlias(model: string): model is ImageModelAlias {
  return Object.hasOwn(IMAGE_MODEL_ALIASES, model);
}

/** Resolves a canonical image model ID or supported alias. */
export function resolveImageModel(model: string): ImageModel | undefined {
  if (isImageModelId(model)) {
    return model;
  }
  return isImageModelAlias(model) ? IMAGE_MODEL_ALIASES[model] : undefined;
}
