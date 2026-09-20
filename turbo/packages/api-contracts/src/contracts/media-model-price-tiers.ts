/**
 * Built-in credit price tiers for the image and video generation catalogs.
 *
 * Each tier ranks what one generation costs against the rest of its own
 * catalog, read off the `usage_pricing` rows the generation services bill
 * against. Image models are compared on a 1024x1024 output at the default
 * quality, video models on an 8-second 16:9 clip at the model's own default
 * resolution. Revisit a tier when its pricing row moves.
 */
import type { ImageModelId } from "./image-models";
import type { ModelPriceTier } from "./model-price-tiers";
import type { VideoModelId } from "./video-models";

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
  "dola-seedream-5-0-pro-260628": "$$",
  "seedream-5-0-lite-260128": "$$",
  "fal-ai/nano-banana-2": "$$$",
  "google/nano-banana-2-lite": "$$",
});

export const VIDEO_MODEL_PRICE_TIER = Object.freeze<
  Record<VideoModelId, ModelPriceTier>
>({
  "dreamina-seedance-2-5-260628": "$$$",
  "dreamina-seedance-2-0-260128": "$$",
  "dreamina-seedance-2-0-fast-260128": "$$",
  "dreamina-seedance-2-0-mini-260615": "$",
  "seedance-1-5-pro-251215": "$",
  "fal-ai/veo3.1/fast": "$$",
  "fal-ai/kling-video/v3/4k/text-to-video": "$$$$",
  "MiniMax-H3": "$$",
});
