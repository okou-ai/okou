/**
 * Catalog of prompt-based built-in image generation models.
 *
 * Provider request shapes, pricing, and model-specific parameters stay in the
 * API service. Promptless transforms are deliberately excluded because they
 * cannot act as chat defaults.
 */
import {
  IMAGE_MODEL_IDS,
  isImageModelId,
  type ImageModelId,
} from "@okouai/api-contracts/contracts/image-models";

interface ImageModelConfig {
  /** Value accepted by the CLI's `--model` flag. */
  readonly alias: string;
  /** Human-facing name for pickers. */
  readonly label: string;
}

export const IMAGE_MODEL_CONFIGS = {
  "gpt-image-1": {
    alias: "gpt-image-1",
    label: "GPT Image 1",
  },
  "gpt-image-2": {
    alias: "gpt-image-2",
    label: "GPT Image 2",
  },
  "gpt-image-2.5-flare": {
    alias: "gpt-image-2.5-flare",
    label: "GPT Image 2.5 Flare",
  },
  "gpt-image-2.5-sunburst": {
    alias: "gpt-image-2.5-sunburst",
    label: "GPT Image 2.5 Sunburst",
  },
  "fal-ai/flux-pro/v1.1": {
    alias: "flux-pro-1.1",
    label: "Flux Pro v1.1",
  },
  "fal-ai/flux-pro/v1.1-ultra": {
    alias: "flux-pro-1.1-ultra",
    label: "Flux Pro v1.1 Ultra",
  },
  "fal-ai/flux-2-pro": {
    alias: "flux-2-pro",
    label: "FLUX.2 Pro",
  },
  "alibaba/qwen-image-3/text-to-image": {
    alias: "qwen-image-3",
    label: "Qwen Image 3",
  },
  "ideogram/v4": {
    alias: "ideogram-4",
    label: "Ideogram 4",
  },
  "fal-ai/bytedance/seedream/v4/text-to-image": {
    alias: "seedream4",
    label: "Seedream 4",
  },
  "dola-seedream-5-0-pro-260628": {
    alias: "seedream5-pro",
    label: "Seedream 5 Pro",
  },
  "seedream-5-0-lite-260128": {
    alias: "seedream5-lite",
    label: "Seedream 5 Lite",
  },
  "fal-ai/nano-banana-2": {
    alias: "nano-banana-2",
    label: "Nano Banana 2",
  },
  "google/nano-banana-2-lite": {
    alias: "nano-banana-2-lite",
    label: "Nano Banana 2 Lite",
  },
} as const satisfies Record<ImageModelId, ImageModelConfig>;

export type ImageModel = ImageModelId;

/** Reserved run environment key carrying the built-in image default alias. */
export const DEFAULT_IMAGE_MODEL_ENV = "OKOU_DEFAULT_IMAGE_MODEL";

/** All catalog models, in user-facing picker order. */
export const IMAGE_MODELS: readonly ImageModel[] = IMAGE_MODEL_IDS;

/**
 * Catalog models offered by the user-facing picker, in display order. The
 * picker presents the current entry for each family rather than every catalog
 * entry: Seedream 4, both Flux 1.1 variants, and Seedream 5 Lite are all
 * deliberately absent. Every one of them stays generatable through its alias
 * and through defaults that already point at it.
 * Nano Banana 2 Lite is the exception: it is offered beside Nano Banana 2
 * because it is the cheaper way to reach the same family.
 */
export const PUBLIC_IMAGE_MODELS = [
  "gpt-image-1",
  "gpt-image-2",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
  "fal-ai/nano-banana-2",
  "google/nano-banana-2-lite",
  "fal-ai/flux-2-pro",
  "ideogram/v4",
  "dola-seedream-5-0-pro-260628",
  "alibaba/qwen-image-3/text-to-image",
] as const satisfies readonly ImageModel[];

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
  "seedream5-pro": "dola-seedream-5-0-pro-260628",
  "seedream5-lite": "seedream-5-0-lite-260128",
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

/** Global fallback when no more specific image model default exists. */
export const DEFAULT_IMAGE_MODEL = "gpt-image-1" satisfies ImageModel;
