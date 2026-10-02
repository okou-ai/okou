/**
 * Built-in credit price tiers for the image generation catalog.
 *
 * Each tier ranks what one generation costs against the rest of the catalog,
 * read off the `usage_pricing` rows the generation service bills against.
 * Image models are compared on a 1024x1024 output at the default quality.
 * Revisit a tier when its pricing row moves.
 */
import type { ImageModelId } from "./image-models";
import type { ModelPriceTier } from "./model-price-tiers";

export const IMAGE_MODEL_PRICE_TIER = Object.freeze<
  Record<ImageModelId, ModelPriceTier>
>({
  "gpt-image-1": "$$",
  "gpt-image-2": "$$$",
  "gpt-image-2.5-flare": "$$$",
  "gpt-image-2.5-sunburst": "$$$",
  "fal-ai/flux-pro/v1.1": "$$$",
  "fal-ai/flux-pro/v1.1-ultra": "$$$",
  "fal-ai/flux-2-pro": "$$",
  "alibaba/qwen-image-3/text-to-image": "$$",
  "ideogram/v4": "$",
  "fal-ai/bytedance/seedream/v4/text-to-image": "$$",
  "fal-ai/nano-banana-2": "$$$",
  "google/nano-banana-2-lite": "$$",
});
