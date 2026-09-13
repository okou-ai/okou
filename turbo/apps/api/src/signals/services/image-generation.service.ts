import { Buffer } from "node:buffer";

import { command, computed, type Computed } from "ccstate";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { usagePricing } from "@okouai/db/schema/usage-pricing";
import {
  DEFAULT_IMAGE_MODEL,
  IMAGE_MODEL_ALIASES as SELECTABLE_IMAGE_MODEL_ALIASES,
  type ImageModel as SelectableImageModel,
} from "@okouai/core/image-model-catalog";
import { r2ImageTransformUrl } from "@okouai/core/r2-image-transform";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { redactPresignedUrls } from "../../lib/presigned-url-redaction";
import { safeJsonParse } from "../utils";
import {
  canonicalUsagePricingProvider,
  resolveUsagePricingProvider,
  usagePricingResolution$,
  type UsagePricingResolution,
} from "../context/usage-pricing-resolution";
import { db$, writeDb$ } from "../external/db";
import { checkBillableOperationCredits$ } from "./billable-operation-admission.service";
import { storeGeneratedArtifactObject$ } from "./artifact-storage.service";
import { recordWebUploadedFile$ } from "./run-uploaded-files.service";
import { processOrgUsageEvents$ } from "./credit-usage.service";
import {
  builtInGenerationUsageIdempotencyKey,
  type BuiltInGenerationUsageIdempotency,
} from "./built-in-generation-usage-idempotency";

const FAL_IMAGE_QUEUE_URL_PREFIX = "https://queue.fal.run";
const FAL_BILLABLE_UNITS_HEADER = "x-fal-billable-units";
const OPENAI_IMAGES_URL_PREFIX = "https://api.openai.com/v1/images";
const BYTEPLUS_IMAGE_GENERATIONS_URL =
  "https://ark.ap-southeast.bytepluses.com/api/v3/images/generations";
const IMAGE_IO_MAX_PROMPT_LENGTH = 32_000;
const IMAGE_IO_MIN_PIXELS = 655_360;
const IMAGE_IO_MAX_PIXELS = 8_294_400;
const IMAGE_IO_MAX_EDGE = 3840;
const IMAGE_IO_EDGE_MULTIPLE = 16;
const IMAGE_IO_MAX_ASPECT_RATIO = 3;
const NANO_BANANA_2_MODEL = "fal-ai/nano-banana-2";
const NANO_BANANA_2_LITE_MODEL = "google/nano-banana-2-lite";
const NANO_BANANA_2_MAX_SOURCE_IMAGE_URLS = 14;
const FLUX_2_PRO_MODEL = "fal-ai/flux-2-pro";
const FLUX_2_PRO_MAX_SOURCE_IMAGE_URLS = 9;
const FLUX_2_PRO_MAX_PIXELS = 4_194_304;
const FLUX_2_PRO_MAX_EDGE = 2560;
const QWEN_IMAGE_3_MODEL = "alibaba/qwen-image-3/text-to-image";
const QWEN_IMAGE_3_MAX_SOURCE_IMAGE_URLS = 3;
const IDEOGRAM_4_MODEL = "ideogram/v4";
/**
 * fal prices Qwen Image 3 per generated image in two resolution tiers, split at
 * 2,250,000 output pixels: $0.04 at or below it, $0.075 above it.
 */
const QWEN_IMAGE_3_STANDARD_TIER_MAX_PIXELS = 2_250_000;
/** fal caps Qwen Image 3 output at 2048x2048 total pixels. */
const QWEN_IMAGE_3_MAX_PIXELS = 2048 * 2048;
/** Largest fal flexible-size preset, used when a request carries `auto`. */
const FAL_SIZE_PRESET_MAX_PIXELS = 1024 * 1024;
const SEEDREAM_5_PRO_MODEL = "dola-seedream-5-0-pro-260628";
const SEEDREAM_5_LITE_MODEL = "seedream-5-0-lite-260128";
const SEEDREAM_5_LITE_MAX_SOURCE_IMAGE_URLS = 14;
const SEEDREAM_5_PRO_LOW_TIER_MAX_PIXELS = 2_610_000;
const SEEDREAM_5_PRO_LOW_TIER_OUTPUT_COST_USD_MICROS = 45_000;
const SEEDREAM_5_PRO_HIGH_TIER_OUTPUT_COST_USD_MICROS = 90_000;
const SEEDREAM_5_PRO_ADDITIONAL_INPUT_COST_USD_MICROS = 3000;
const SEEDREAM_5_LITE_OUTPUT_COST_USD_MICROS = 35_000;
const BIREFNET_MODEL = "fal-ai/birefnet/v2";
const CLARITY_UPSCALER_MODEL = "fal-ai/clarity-upscaler";

const USAGE_KIND = "image";
const FAL_OUTPUT_IMAGE_CATEGORY = "output_image";
const FAL_OUTPUT_MEGAPIXEL_CATEGORY = "output_megapixel";
const PROVIDER_COST_USD_MICROS_CATEGORY = "provider_cost_usd_micros";
const FAL_QUALITY_SIZE_IMAGE_PRICING_CATEGORIES = [
  "output_image.low.standard",
  "output_image.low.large",
  "output_image.medium.standard",
  "output_image.medium.large",
  "output_image.high.standard",
  "output_image.high.large",
] as const;
const FAL_PIXEL_TIER_IMAGE_PRICING_CATEGORIES = [
  "output_image.1k",
  "output_image.2k",
] as const;
const FLUX_2_PRO_PRICING_CATEGORIES = [
  "processed_megapixel.first",
  "processed_megapixel.additional",
] as const;
const IDEOGRAM_4_PRICING_CATEGORIES = [
  "output_megapixel.turbo",
  "output_megapixel.balanced",
  "output_megapixel.quality",
] as const;
const OPENAI_IMAGE_PRICING_CATEGORIES = [
  "tokens.input.text",
  "tokens.input.image",
  "tokens.output.image",
] as const;
const IMAGE_PRICING_CATEGORIES = [
  FAL_OUTPUT_IMAGE_CATEGORY,
  FAL_OUTPUT_MEGAPIXEL_CATEGORY,
  PROVIDER_COST_USD_MICROS_CATEGORY,
  ...FAL_QUALITY_SIZE_IMAGE_PRICING_CATEGORIES,
  ...FAL_PIXEL_TIER_IMAGE_PRICING_CATEGORIES,
  ...FLUX_2_PRO_PRICING_CATEGORIES,
  ...IDEOGRAM_4_PRICING_CATEGORIES,
  ...OPENAI_IMAGE_PRICING_CATEGORIES,
] as const;

const IMAGE_QUALITIES = ["low", "medium", "high", "auto"] as const;
const OPENAI_IMAGE_QUALITIES = [...IMAGE_QUALITIES, "xhigh", "max"] as const;
const IMAGE_BACKGROUNDS = ["auto", "opaque", "transparent"] as const;
const IMAGE_OUTPUT_FORMATS = ["png", "webp", "jpeg"] as const;
const IMAGE_MODERATIONS = ["auto", "low"] as const;
const IMAGE_SAFETY_TOLERANCES = ["1", "2", "3", "4", "5", "6"] as const;
const IMAGE_INPUT_FIDELITIES = ["low", "high"] as const;
const MAX_SOURCE_IMAGE_URLS = 10;
const STANDARD_GPT_IMAGE_SIZES = [
  "auto",
  "1024x1024",
  "1536x1024",
  "1024x1536",
] as const;
const FAL_IMAGE_OUTPUT_FORMATS = ["png", "jpeg"] as const;
const BYTEPLUS_IMAGE_OUTPUT_FORMATS = ["png", "jpeg"] as const;
const SEEDREAM_5_PRO_SIZE_PRESETS = ["1K", "1.5K", "2K"] as const;
const SEEDREAM_5_LITE_SIZE_PRESETS = ["2K", "3K", "4K"] as const;
const FAL_IMAGE_ASPECT_RATIOS = [
  "21:9",
  "16:9",
  "4:3",
  "3:2",
  "1:1",
  "2:3",
  "3:4",
  "9:16",
  "9:21",
] as const;

const IMAGE_MODEL_ALIASES = {
  ...SELECTABLE_IMAGE_MODEL_ALIASES,
  birefnet: BIREFNET_MODEL,
  "clarity-upscaler": CLARITY_UPSCALER_MODEL,
} as const;

const OPENAI_IMAGE_MODEL_CONFIG = {
  promptless: false,
  sourceImageInput: "image_urls",
  provider: "openai",
  sizeMode: "flexible",
  sizeParameter: undefined,
  outputFormats: IMAGE_OUTPUT_FORMATS,
  pricingCategories: OPENAI_IMAGE_PRICING_CATEGORIES,
  billingMode: "tokens",
  supportsTransparentBackground: true,
  supportsOutputCompression: true,
  supportsModeration: true,
  supportsQuality: true,
  supportsBackground: true,
  usesOpenAiByok: false,
  supportsSeed: false,
  supportsSafetyTolerance: false,
  supportsEnhancePrompt: false,
  supportsMaskImage: true,
  supportsInputFidelity: false,
  supportsImagePromptStrength: false,
} as const;

const IMAGE_GENERATION_MODEL_CONFIGS = {
  "gpt-image-2.5-flare": {
    ...OPENAI_IMAGE_MODEL_CONFIG,
    alias: "gpt-image-2.5-flare",
    endpointId: "gpt-image-2.5-flare",
    imageToImageEndpointId: "gpt-image-2.5-flare",
  },
  "gpt-image-2.5-sunburst": {
    ...OPENAI_IMAGE_MODEL_CONFIG,
    alias: "gpt-image-2.5-sunburst",
    endpointId: "gpt-image-2.5-sunburst",
    imageToImageEndpointId: "gpt-image-2.5-sunburst",
  },
  "gpt-image-2": {
    alias: "gpt-image-2",
    promptless: false,
    endpointId: "openai/gpt-image-2",
    imageToImageEndpointId: "openai/gpt-image-2/edit",
    sourceImageInput: "image_urls",
    provider: "fal",
    sizeMode: "flexible",
    sizeParameter: undefined,
    outputFormats: IMAGE_OUTPUT_FORMATS,
    pricingCategories: FAL_QUALITY_SIZE_IMAGE_PRICING_CATEGORIES,
    billingMode: "quality_size_image",
    supportsTransparentBackground: false,
    supportsOutputCompression: false,
    supportsModeration: false,
    supportsQuality: true,
    supportsBackground: false,
    usesOpenAiByok: true,
    supportsSeed: false,
    supportsSafetyTolerance: false,
    supportsEnhancePrompt: false,
    supportsMaskImage: true,
    supportsInputFidelity: false,
    supportsImagePromptStrength: false,
  },
  "gpt-image-1": {
    alias: "gpt-image-1",
    promptless: false,
    endpointId: "fal-ai/gpt-image-1/text-to-image",
    imageToImageEndpointId: "fal-ai/gpt-image-1/edit-image",
    sourceImageInput: "image_urls",
    provider: "fal",
    sizeMode: "standard",
    sizeParameter: undefined,
    outputFormats: IMAGE_OUTPUT_FORMATS,
    pricingCategories: FAL_QUALITY_SIZE_IMAGE_PRICING_CATEGORIES,
    billingMode: "quality_size_image",
    supportsTransparentBackground: true,
    supportsOutputCompression: false,
    supportsModeration: false,
    supportsQuality: true,
    supportsBackground: true,
    usesOpenAiByok: true,
    supportsSeed: false,
    supportsSafetyTolerance: false,
    supportsEnhancePrompt: false,
    supportsMaskImage: false,
    supportsInputFidelity: true,
    supportsImagePromptStrength: false,
  },
  "fal-ai/flux-pro/v1.1": {
    alias: "flux-pro-1.1",
    promptless: false,
    endpointId: "fal-ai/flux-pro/v1.1",
    imageToImageEndpointId: "fal-ai/flux-pro/v1.1/redux",
    sourceImageInput: "image_url",
    provider: "fal",
    sizeMode: "flexible",
    sizeParameter: "image_size",
    outputFormats: FAL_IMAGE_OUTPUT_FORMATS,
    pricingCategories: [FAL_OUTPUT_MEGAPIXEL_CATEGORY],
    billingMode: "megapixel",
    supportsTransparentBackground: false,
    supportsOutputCompression: false,
    supportsModeration: false,
    supportsQuality: false,
    supportsBackground: false,
    usesOpenAiByok: false,
    supportsSeed: true,
    supportsSafetyTolerance: true,
    supportsEnhancePrompt: true,
    supportsMaskImage: false,
    supportsInputFidelity: false,
    supportsImagePromptStrength: true,
  },
  "fal-ai/flux-pro/v1.1-ultra": {
    alias: "flux-pro-1.1-ultra",
    promptless: false,
    endpointId: "fal-ai/flux-pro/v1.1-ultra",
    imageToImageEndpointId: "fal-ai/flux-pro/v1.1-ultra/redux",
    sourceImageInput: "image_url",
    provider: "fal",
    sizeMode: "flexible",
    sizeParameter: "aspect_ratio",
    outputFormats: FAL_IMAGE_OUTPUT_FORMATS,
    pricingCategories: [FAL_OUTPUT_IMAGE_CATEGORY],
    billingMode: "image",
    supportsTransparentBackground: false,
    supportsOutputCompression: false,
    supportsModeration: false,
    supportsQuality: false,
    supportsBackground: false,
    usesOpenAiByok: false,
    supportsSeed: true,
    supportsSafetyTolerance: true,
    supportsEnhancePrompt: false,
    supportsMaskImage: false,
    supportsInputFidelity: false,
    supportsImagePromptStrength: true,
  },
  [FLUX_2_PRO_MODEL]: {
    alias: "flux-2-pro",
    promptless: false,
    endpointId: FLUX_2_PRO_MODEL,
    imageToImageEndpointId: `${FLUX_2_PRO_MODEL}/edit`,
    sourceImageInput: "image_urls",
    provider: "fal",
    sizeMode: "flexible",
    sizeParameter: "image_size",
    outputFormats: FAL_IMAGE_OUTPUT_FORMATS,
    pricingCategories: FLUX_2_PRO_PRICING_CATEGORIES,
    billingMode: "flux_2_processed_megapixel",
    supportsTransparentBackground: false,
    supportsOutputCompression: false,
    supportsModeration: false,
    supportsQuality: false,
    supportsBackground: false,
    usesOpenAiByok: false,
    supportsSeed: true,
    supportsSafetyTolerance: true,
    supportsEnhancePrompt: false,
    supportsMaskImage: false,
    supportsInputFidelity: false,
    supportsImagePromptStrength: false,
  },
  "fal-ai/qwen-image": {
    alias: "qwen-image",
    promptless: false,
    endpointId: "fal-ai/qwen-image",
    imageToImageEndpointId: "fal-ai/qwen-image-2/edit",
    sourceImageInput: "image_url",
    provider: "fal",
    sizeMode: "flexible",
    sizeParameter: "image_size",
    outputFormats: FAL_IMAGE_OUTPUT_FORMATS,
    pricingCategories: [FAL_OUTPUT_MEGAPIXEL_CATEGORY],
    billingMode: "megapixel",
    supportsTransparentBackground: false,
    supportsOutputCompression: false,
    supportsModeration: false,
    supportsQuality: false,
    supportsBackground: false,
    usesOpenAiByok: false,
    supportsSeed: true,
    supportsSafetyTolerance: false,
    supportsEnhancePrompt: false,
    supportsMaskImage: false,
    supportsInputFidelity: false,
    supportsImagePromptStrength: false,
  },
  [QWEN_IMAGE_3_MODEL]: {
    alias: "qwen-image-3",
    promptless: false,
    endpointId: QWEN_IMAGE_3_MODEL,
    imageToImageEndpointId: "alibaba/qwen-image-3/edit",
    sourceImageInput: "image_urls",
    provider: "fal",
    sizeMode: "flexible",
    sizeParameter: "image_size",
    outputFormats: IMAGE_OUTPUT_FORMATS,
    pricingCategories: FAL_PIXEL_TIER_IMAGE_PRICING_CATEGORIES,
    billingMode: "pixel_tier_image",
    supportsTransparentBackground: false,
    supportsOutputCompression: false,
    supportsModeration: false,
    supportsQuality: false,
    supportsBackground: false,
    usesOpenAiByok: false,
    supportsSeed: true,
    supportsSafetyTolerance: false,
    supportsEnhancePrompt: false,
    supportsMaskImage: false,
    supportsInputFidelity: false,
    supportsImagePromptStrength: false,
  },
  [IDEOGRAM_4_MODEL]: {
    alias: "ideogram-4",
    promptless: false,
    endpointId: IDEOGRAM_4_MODEL,
    imageToImageEndpointId: `${IDEOGRAM_4_MODEL}/image-to-image`,
    sourceImageInput: "image_url",
    provider: "fal",
    sizeMode: "flexible",
    sizeParameter: "image_size",
    outputFormats: FAL_IMAGE_OUTPUT_FORMATS,
    pricingCategories: IDEOGRAM_4_PRICING_CATEGORIES,
    billingMode: "ideogram_rendering_speed_megapixel",
    supportsTransparentBackground: false,
    supportsOutputCompression: false,
    supportsModeration: false,
    supportsQuality: true,
    supportsBackground: false,
    usesOpenAiByok: false,
    supportsSeed: true,
    supportsSafetyTolerance: false,
    supportsEnhancePrompt: false,
    supportsMaskImage: false,
    supportsInputFidelity: false,
    supportsImagePromptStrength: false,
  },
  "fal-ai/bytedance/seedream/v4/text-to-image": {
    alias: "seedream4",
    promptless: false,
    endpointId: "fal-ai/bytedance/seedream/v4/text-to-image",
    imageToImageEndpointId: "fal-ai/bytedance/seedream/v4/edit",
    sourceImageInput: "image_urls",
    provider: "fal",
    sizeMode: "flexible",
    sizeParameter: "image_size",
    outputFormats: ["png"],
    pricingCategories: [FAL_OUTPUT_IMAGE_CATEGORY],
    billingMode: "image",
    supportsTransparentBackground: false,
    supportsOutputCompression: false,
    supportsModeration: false,
    supportsQuality: false,
    supportsBackground: false,
    usesOpenAiByok: false,
    supportsSeed: true,
    supportsSafetyTolerance: false,
    supportsEnhancePrompt: false,
    supportsMaskImage: false,
    supportsInputFidelity: false,
    supportsImagePromptStrength: false,
  },
  [SEEDREAM_5_PRO_MODEL]: {
    alias: "seedream5-pro",
    promptless: false,
    endpointId: BYTEPLUS_IMAGE_GENERATIONS_URL,
    imageToImageEndpointId: BYTEPLUS_IMAGE_GENERATIONS_URL,
    sourceImageInput: "image_urls",
    provider: "byteplus",
    sizeMode: "flexible",
    sizeParameter: "size",
    outputFormats: BYTEPLUS_IMAGE_OUTPUT_FORMATS,
    pricingCategories: [PROVIDER_COST_USD_MICROS_CATEGORY],
    billingMode: "byteplus_provider_cost",
    supportsTransparentBackground: false,
    supportsOutputCompression: false,
    supportsModeration: false,
    supportsQuality: false,
    supportsBackground: false,
    usesOpenAiByok: false,
    supportsSeed: false,
    supportsSafetyTolerance: false,
    supportsEnhancePrompt: false,
    supportsMaskImage: false,
    supportsInputFidelity: false,
    supportsImagePromptStrength: false,
  },
  [SEEDREAM_5_LITE_MODEL]: {
    alias: "seedream5-lite",
    promptless: false,
    endpointId: BYTEPLUS_IMAGE_GENERATIONS_URL,
    imageToImageEndpointId: BYTEPLUS_IMAGE_GENERATIONS_URL,
    sourceImageInput: "image_urls",
    provider: "byteplus",
    sizeMode: "flexible",
    sizeParameter: "size",
    outputFormats: BYTEPLUS_IMAGE_OUTPUT_FORMATS,
    pricingCategories: [PROVIDER_COST_USD_MICROS_CATEGORY],
    billingMode: "byteplus_provider_cost",
    supportsTransparentBackground: false,
    supportsOutputCompression: false,
    supportsModeration: false,
    supportsQuality: false,
    supportsBackground: false,
    usesOpenAiByok: false,
    supportsSeed: false,
    supportsSafetyTolerance: false,
    supportsEnhancePrompt: false,
    supportsMaskImage: false,
    supportsInputFidelity: false,
    supportsImagePromptStrength: false,
  },
  [NANO_BANANA_2_MODEL]: {
    alias: "nano-banana-2",
    promptless: false,
    endpointId: NANO_BANANA_2_MODEL,
    imageToImageEndpointId: "fal-ai/nano-banana-2/edit",
    sourceImageInput: "image_urls",
    provider: "fal",
    sizeMode: "flexible",
    sizeParameter: "aspect_ratio",
    outputFormats: IMAGE_OUTPUT_FORMATS,
    pricingCategories: [FAL_OUTPUT_IMAGE_CATEGORY],
    billingMode: "image",
    supportsTransparentBackground: false,
    supportsOutputCompression: false,
    supportsModeration: false,
    supportsQuality: false,
    supportsBackground: false,
    usesOpenAiByok: false,
    supportsSeed: true,
    supportsSafetyTolerance: true,
    supportsEnhancePrompt: false,
    supportsMaskImage: false,
    supportsInputFidelity: false,
    supportsImagePromptStrength: false,
  },
  [NANO_BANANA_2_LITE_MODEL]: {
    alias: "nano-banana-2-lite",
    promptless: false,
    endpointId: NANO_BANANA_2_LITE_MODEL,
    imageToImageEndpointId: "google/nano-banana-2-lite/edit",
    sourceImageInput: "image_urls",
    provider: "fal",
    sizeMode: "flexible",
    sizeParameter: "aspect_ratio",
    outputFormats: IMAGE_OUTPUT_FORMATS,
    pricingCategories: [FAL_OUTPUT_IMAGE_CATEGORY],
    billingMode: "image",
    supportsTransparentBackground: false,
    supportsOutputCompression: false,
    supportsModeration: false,
    supportsQuality: false,
    supportsBackground: false,
    usesOpenAiByok: false,
    supportsSeed: true,
    supportsSafetyTolerance: true,
    supportsEnhancePrompt: false,
    supportsMaskImage: false,
    supportsInputFidelity: false,
    supportsImagePromptStrength: false,
  },
} as const satisfies Record<SelectableImageModel, unknown>;

const IMAGE_TRANSFORM_MODEL_CONFIGS = {
  [BIREFNET_MODEL]: {
    alias: "birefnet",
    promptless: true,
    endpointId: BIREFNET_MODEL,
    imageToImageEndpointId: BIREFNET_MODEL,
    sourceImageInput: "image_url",
    provider: "fal",
    sizeMode: "flexible",
    sizeParameter: undefined,
    outputFormats: ["png"],
    pricingCategories: [FAL_OUTPUT_IMAGE_CATEGORY],
    billingMode: "image",
    supportsTransparentBackground: true,
    supportsOutputCompression: false,
    supportsModeration: false,
    supportsQuality: false,
    supportsBackground: false,
    usesOpenAiByok: false,
    supportsSeed: false,
    supportsSafetyTolerance: false,
    supportsEnhancePrompt: false,
    supportsMaskImage: false,
    supportsInputFidelity: false,
    supportsImagePromptStrength: false,
  },
  [CLARITY_UPSCALER_MODEL]: {
    alias: "clarity-upscaler",
    promptless: true,
    endpointId: CLARITY_UPSCALER_MODEL,
    imageToImageEndpointId: CLARITY_UPSCALER_MODEL,
    sourceImageInput: "image_url",
    provider: "fal",
    sizeMode: "flexible",
    sizeParameter: undefined,
    outputFormats: FAL_IMAGE_OUTPUT_FORMATS,
    pricingCategories: [FAL_OUTPUT_MEGAPIXEL_CATEGORY],
    billingMode: "megapixel",
    supportsTransparentBackground: false,
    supportsOutputCompression: false,
    supportsModeration: false,
    supportsQuality: false,
    supportsBackground: false,
    usesOpenAiByok: false,
    supportsSeed: false,
    supportsSafetyTolerance: false,
    supportsEnhancePrompt: false,
    supportsMaskImage: false,
    supportsInputFidelity: false,
    supportsImagePromptStrength: false,
  },
} as const;

const IMAGE_MODEL_CONFIGS = {
  ...IMAGE_GENERATION_MODEL_CONFIGS,
  ...IMAGE_TRANSFORM_MODEL_CONFIGS,
} as const;

const IMAGE_MODELS = Object.keys(IMAGE_MODEL_CONFIGS) as ImageModel[];
const L = logger("ImageGeneration");

type ImageQuality = (typeof OPENAI_IMAGE_QUALITIES)[number];
type ImageBackground = (typeof IMAGE_BACKGROUNDS)[number];
type ImageOutputFormat = (typeof IMAGE_OUTPUT_FORMATS)[number];
type ImageModeration = (typeof IMAGE_MODERATIONS)[number];
type ImageSafetyTolerance = (typeof IMAGE_SAFETY_TOLERANCES)[number];
type ImageInputFidelity = (typeof IMAGE_INPUT_FIDELITIES)[number];
type ImagePricingCategory = (typeof IMAGE_PRICING_CATEGORIES)[number];
export type ImageModel = keyof typeof IMAGE_MODEL_CONFIGS;
export type ImageProvider = "fal" | "byteplus" | "openai";
type ImageModelConfig = (typeof IMAGE_MODEL_CONFIGS)[ImageModel];

type ErrorStatus = 400 | 402 | 500 | 502 | 503;

interface ErrorBody {
  readonly error: {
    readonly message: string;
    readonly code: string;
  };
}

type ErrorResponse = {
  readonly status: ErrorStatus;
  readonly body: ErrorBody;
};

interface ImagePricingRow {
  readonly provider: ImageModel;
  readonly category: ImagePricingCategory;
  readonly unitPrice: number;
  readonly unitSize: number;
}

export type ImagePricing = ReadonlyMap<string, ImagePricingRow>;

interface ImageOutputOptions {
  readonly outputFormat: ImageOutputFormat;
  readonly outputCompression: number | undefined;
}

export interface ImageOptions {
  readonly model: ImageModel;
  readonly provider: ImageProvider;
  readonly prompt: string;
  readonly size: string;
  readonly quality: ImageQuality;
  readonly background: ImageBackground;
  readonly outputFormat: ImageOutputFormat;
  readonly outputCompression: number | undefined;
  readonly moderation: ImageModeration;
  readonly seed: number | undefined;
  readonly safetyTolerance: ImageSafetyTolerance;
  readonly enhancePrompt: boolean;
  readonly sourceImageUrls: readonly string[];
  readonly maskImageUrl: string | undefined;
  readonly inputFidelity: ImageInputFidelity | undefined;
  readonly imagePromptStrength: number | undefined;
}

interface ParsedImageGeneration {
  readonly model: ImageModel;
  readonly provider: ImageProvider;
  readonly imageBytes: Buffer;
  readonly revisedPrompt: string | undefined;
  readonly imageSize: string;
  readonly quality: string;
  readonly background: string;
  readonly outputFormat: ImageOutputFormat;
  readonly outputCompression: number | undefined;
  readonly moderation: ImageModeration;
  readonly safetyTolerance: ImageSafetyTolerance | undefined;
  readonly billing: readonly ImageBillingEntry[];
  readonly sourceUrl: string | undefined;
  readonly seed: number | undefined;
  readonly sourceImageUrls: readonly string[];
  readonly maskImageUrl: string | undefined;
  readonly inputFidelity: ImageInputFidelity | undefined;
  readonly imagePromptStrength: number | undefined;
}

interface RecordedImage {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
  readonly url: string;
  readonly embedUrl: string | undefined;
  readonly creditsCharged: number;
  readonly model: string;
  readonly provider: ImageProvider;
  readonly imageSize: string;
  readonly quality: string;
  readonly background: string;
  readonly outputFormat: ImageOutputFormat;
  readonly outputCompression: number | undefined;
  readonly moderation: ImageModeration;
  readonly safetyTolerance: ImageSafetyTolerance | undefined;
  readonly revisedPrompt: string | undefined;
  readonly billingCategory: string | undefined;
  readonly billingQuantity: number | undefined;
  readonly sourceUrl: string | undefined;
  readonly seed: number | undefined;
  readonly sourceImageUrls: readonly string[];
  readonly maskImageUrl: string | undefined;
  readonly inputFidelity: ImageInputFidelity | undefined;
  readonly imagePromptStrength: number | undefined;
}

interface ImageBillingEntry {
  readonly category: ImagePricingCategory;
  readonly quantity: number;
}

interface FalImageFile {
  readonly url: string;
  readonly contentType: string | undefined;
  readonly width: number | undefined;
  readonly height: number | undefined;
}

interface FalImageResult {
  readonly image: FalImageFile;
  readonly revisedPrompt: string | undefined;
  readonly seed: number | undefined;
}

interface BytePlusImageFile {
  readonly url: string;
  readonly width: number | undefined;
  readonly height: number | undefined;
  readonly size: string | undefined;
  readonly outputFormat: ImageOutputFormat | undefined;
}

interface BytePlusImageResult {
  readonly image: BytePlusImageFile;
}

interface FalImageQueueHandle {
  readonly requestId: string | undefined;
  readonly statusUrl: string;
  readonly responseUrl: string;
}

function errorBody(message: string, code: string): ErrorBody {
  return { error: { message, code } };
}

function badRequest(message: string, code = "BAD_REQUEST") {
  return { status: 400 as const, body: errorBody(message, code) };
}

function badGateway(message: string, code: string) {
  return { status: 502 as const, body: errorBody(message, code) };
}

export function serviceUnavailable(message: string, code: string) {
  return { status: 503 as const, body: errorBody(message, code) };
}

export function insufficientCredits() {
  return {
    status: 402 as const,
    body: errorBody(
      "Insufficient credits. Please add credits to continue.",
      "INSUFFICIENT_CREDITS",
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(
  body: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const value = body[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : fallback;
}

function readOptionalInteger(
  body: Record<string, unknown>,
  key: string,
): number | ErrorResponse | undefined {
  const value = body[key];
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isInteger(parsed)) {
    return badRequest(`${key} must be an integer`);
  }

  return parsed;
}

function readOptionalNumberFromKeys(
  body: Record<string, unknown>,
  keys: readonly string[],
): number | ErrorResponse | undefined {
  for (const key of keys) {
    const value = body[key];
    if (value === undefined || value === null || value === "") {
      continue;
    }
    const parsed =
      typeof value === "number"
        ? value
        : typeof value === "string" && value.trim().length > 0
          ? Number(value.trim())
          : Number.NaN;
    if (!Number.isFinite(parsed)) {
      return badRequest(`${key} must be a number`);
    }
    return parsed;
  }
  return undefined;
}

function readOptionalStringFromKeys(
  body: Record<string, unknown>,
  keys: readonly string[],
): string | ErrorResponse | undefined {
  for (const key of keys) {
    const value = body[key];
    if (value === undefined || value === null || value === "") {
      continue;
    }
    if (typeof value !== "string" || value.trim().length === 0) {
      return badRequest(`${key} must be a non-empty string`);
    }
    return value.trim();
  }
  return undefined;
}

function includesString<T extends string>(
  values: readonly T[],
  value: string,
): value is T {
  return values.some((candidate) => {
    return candidate === value;
  });
}

function hasString(values: readonly string[], value: string): boolean {
  return values.includes(value);
}

function normalizeImageModel(value: string): ImageModel | null {
  if (value in IMAGE_MODEL_CONFIGS) {
    return value as ImageModel;
  }
  if (value in IMAGE_MODEL_ALIASES) {
    return IMAGE_MODEL_ALIASES[value as keyof typeof IMAGE_MODEL_ALIASES];
  }
  return null;
}

function imageModelList(): string {
  return Object.keys(IMAGE_MODEL_ALIASES).join(", ");
}

function imagePricingKey(
  model: ImageModel,
  category: ImagePricingCategory,
): string {
  return `${model}:${category}`;
}

export function getMissingImagePricing(
  pricing: ImagePricing,
  model: ImageModel,
): readonly ImagePricingCategory[] {
  return IMAGE_MODEL_CONFIGS[model].pricingCategories.filter((category) => {
    return !pricing.has(imagePricingKey(model, category));
  });
}

function parseSize(size: string): {
  readonly width: number;
  readonly height: number;
} | null {
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) {
    return null;
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}

interface BytePlusImageSizeLimits {
  readonly presets: readonly string[];
  readonly minPixels: number;
  readonly maxPixels: number;
}

function bytePlusImageSizeLimits(
  model: ImageModel,
): BytePlusImageSizeLimits | null {
  if (model === SEEDREAM_5_PRO_MODEL) {
    return {
      presets: SEEDREAM_5_PRO_SIZE_PRESETS,
      minPixels: 921_600,
      maxPixels: 4_624_220,
    };
  }
  if (model === SEEDREAM_5_LITE_MODEL) {
    return {
      presets: SEEDREAM_5_LITE_SIZE_PRESETS,
      minPixels: 3_686_400,
      maxPixels: 16_777_216,
    };
  }
  return null;
}

function validateBytePlusImageSize(
  model: ImageModel,
  size: string,
  limits: BytePlusImageSizeLimits,
): ErrorResponse | null {
  if (hasString(limits.presets, size)) {
    return null;
  }
  const modelConfig = IMAGE_MODEL_CONFIGS[model];
  const parsed = parseSize(size);
  if (!parsed) {
    return badRequest(
      `Unsupported image size for ${modelConfig.alias}: ${size}. Use auto, ${limits.presets.join(", ")}, or WIDTHxHEIGHT`,
    );
  }

  const { width, height } = parsed;
  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);
  const pixels = width * height;
  if (longEdge / shortEdge > 16) {
    return badRequest(
      `Unsupported image size: ${size}; aspect ratio must be at most 16:1`,
    );
  }
  if (pixels < limits.minPixels || pixels > limits.maxPixels) {
    return badRequest(
      `Unsupported image size for ${modelConfig.alias}: ${size}; total pixels must be between ${limits.minPixels} and ${limits.maxPixels}`,
    );
  }
  return null;
}

function validateImageSize(
  model: ImageModel,
  size: string,
): ErrorResponse | null {
  if (size === "auto") {
    return null;
  }

  const bytePlusLimits = bytePlusImageSizeLimits(model);
  if (bytePlusLimits) {
    return validateBytePlusImageSize(model, size, bytePlusLimits);
  }

  const parsed = parseSize(size);
  if (!parsed) {
    return badRequest(`Unsupported image size: ${size}`);
  }

  const { width, height } = parsed;
  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);
  const pixels = width * height;
  const modelConfig = IMAGE_MODEL_CONFIGS[model];

  if (
    modelConfig.sizeMode === "standard" &&
    !hasString(STANDARD_GPT_IMAGE_SIZES, size)
  ) {
    return badRequest(
      `Unsupported image size for ${modelConfig.alias}: ${size}. Use auto, 1024x1024, 1536x1024, or 1024x1536`,
    );
  }

  if (longEdge > IMAGE_IO_MAX_EDGE) {
    return badRequest(
      `Unsupported image size: ${size}; max edge is ${IMAGE_IO_MAX_EDGE}px`,
    );
  }
  if (
    model === FLUX_2_PRO_MODEL &&
    (longEdge > FLUX_2_PRO_MAX_EDGE || pixels > FLUX_2_PRO_MAX_PIXELS)
  ) {
    return badRequest(
      `Unsupported image size for ${modelConfig.alias}: ${size}; max edge is ${FLUX_2_PRO_MAX_EDGE}px and total pixels must be at most ${FLUX_2_PRO_MAX_PIXELS}`,
    );
  }
  if (
    width % IMAGE_IO_EDGE_MULTIPLE !== 0 ||
    height % IMAGE_IO_EDGE_MULTIPLE !== 0
  ) {
    return badRequest(
      `Unsupported image size: ${size}; both edges must be multiples of ${IMAGE_IO_EDGE_MULTIPLE}px`,
    );
  }
  if (longEdge / shortEdge > IMAGE_IO_MAX_ASPECT_RATIO) {
    return badRequest(
      `Unsupported image size: ${size}; aspect ratio must be at most ${IMAGE_IO_MAX_ASPECT_RATIO}:1`,
    );
  }
  if (pixels < IMAGE_IO_MIN_PIXELS || pixels > IMAGE_IO_MAX_PIXELS) {
    return badRequest(
      `Unsupported image size: ${size}; total pixels must be between ${IMAGE_IO_MIN_PIXELS} and ${IMAGE_IO_MAX_PIXELS}`,
    );
  }
  if (model === QWEN_IMAGE_3_MODEL && pixels > QWEN_IMAGE_3_MAX_PIXELS) {
    return badRequest(
      `Unsupported image size for ${modelConfig.alias}: ${size}; total pixels must be at most ${QWEN_IMAGE_3_MAX_PIXELS}`,
    );
  }

  return null;
}

function readOptionalSafeInteger(
  body: Record<string, unknown>,
  key: string,
): number | ErrorResponse | undefined {
  const value = readOptionalInteger(body, key);
  if (typeof value === "object") {
    return value;
  }
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    return badRequest(`${key} must be a non-negative safe integer`);
  }
  return value;
}

function readBoolean(
  body: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const value = body[key];
  return typeof value === "boolean" ? value : fallback;
}

function parsePrompt(
  body: Record<string, unknown>,
  modelConfig: ImageModelConfig,
): string | ErrorResponse {
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (prompt.length === 0) {
    if (modelConfig.promptless) {
      return prompt;
    }
    return badRequest("prompt is required");
  }
  if (prompt.length > IMAGE_IO_MAX_PROMPT_LENGTH) {
    return badRequest(
      `prompt exceeds ${IMAGE_IO_MAX_PROMPT_LENGTH} characters`,
    );
  }

  return prompt;
}

function parseImageModel(
  body: Record<string, unknown>,
  defaultModel: ImageModel,
): ImageModel | ErrorResponse {
  const rawModel = readString(body, "model", defaultModel);
  const model = normalizeImageModel(rawModel);
  if (!model) {
    return badRequest(
      `Unsupported image model: ${rawModel}. Available models: ${imageModelList()}`,
    );
  }

  return model;
}

function parseImageQuality(
  body: Record<string, unknown>,
  modelConfig: ImageModelConfig,
): ImageQuality | ErrorResponse {
  const quality = readString(body, "quality", "medium");
  const qualities =
    modelConfig.provider === "openai"
      ? OPENAI_IMAGE_QUALITIES
      : IMAGE_QUALITIES;
  if (!includesString(qualities, quality)) {
    return badRequest(`Unsupported image quality: ${quality}`);
  }

  return quality;
}

function parseImageBackground(
  body: Record<string, unknown>,
  modelConfig: ImageModelConfig,
): ImageBackground | ErrorResponse {
  const background = readString(body, "background", "auto");
  if (!includesString(IMAGE_BACKGROUNDS, background)) {
    return badRequest(`Unsupported image background: ${background}`);
  }
  if (
    background === "transparent" &&
    !modelConfig.supportsTransparentBackground
  ) {
    return badRequest(
      `${modelConfig.alias} does not support transparent backgrounds`,
    );
  }

  return background;
}

function parseImageOutputOptions(
  body: Record<string, unknown>,
  modelConfig: ImageModelConfig,
  background: ImageBackground,
): ImageOutputOptions | ErrorResponse {
  const outputFormat = readString(body, "outputFormat", "png");
  if (!includesString(IMAGE_OUTPUT_FORMATS, outputFormat)) {
    return badRequest(`Unsupported image output format: ${outputFormat}`);
  }
  if (!hasString(modelConfig.outputFormats, outputFormat)) {
    return badRequest(
      `Unsupported image output format for ${modelConfig.alias}: ${outputFormat}`,
    );
  }

  const outputCompression = readOptionalInteger(body, "outputCompression");
  if (typeof outputCompression === "object") {
    return outputCompression;
  }
  if (
    outputCompression !== undefined &&
    (outputCompression < 0 || outputCompression > 100)
  ) {
    return badRequest("outputCompression must be between 0 and 100");
  }
  if (outputCompression !== undefined && outputFormat === "png") {
    return badRequest(
      "outputCompression is only supported for jpeg or webp output",
    );
  }
  if (
    outputCompression !== undefined &&
    !modelConfig.supportsOutputCompression
  ) {
    return badRequest(
      `outputCompression is not supported for ${modelConfig.alias}`,
    );
  }
  if (background === "transparent" && outputFormat === "jpeg") {
    return badRequest("transparent backgrounds require png or webp output");
  }

  return { outputFormat, outputCompression };
}

function parseImageModeration(
  body: Record<string, unknown>,
  modelConfig: ImageModelConfig,
): ImageModeration | ErrorResponse {
  const moderation = readString(body, "moderation", "auto");
  if (!includesString(IMAGE_MODERATIONS, moderation)) {
    return badRequest(`Unsupported image moderation: ${moderation}`);
  }
  if (moderation !== "auto" && !modelConfig.supportsModeration) {
    return badRequest(`moderation is not supported for ${modelConfig.alias}`);
  }

  return moderation;
}

function parseImageSeed(
  body: Record<string, unknown>,
  modelConfig: ImageModelConfig,
): number | ErrorResponse | undefined {
  const seed = readOptionalSafeInteger(body, "seed");
  if (typeof seed === "object") {
    return seed;
  }
  if (seed !== undefined && !modelConfig.supportsSeed) {
    return badRequest(`seed is not supported for ${modelConfig.alias}`);
  }

  return seed;
}

function parseSafetyTolerance(
  body: Record<string, unknown>,
  modelConfig: ImageModelConfig,
): ImageSafetyTolerance | ErrorResponse {
  const safetyTolerance = readString(body, "safetyTolerance", "4");
  if (!includesString(IMAGE_SAFETY_TOLERANCES, safetyTolerance)) {
    return badRequest(`Unsupported safety tolerance: ${safetyTolerance}`);
  }
  if (modelConfig.alias === "flux-2-pro" && safetyTolerance === "6") {
    return badRequest("flux-2-pro supports safetyTolerance from 1 to 5");
  }
  if (safetyTolerance !== "4" && !modelConfig.supportsSafetyTolerance) {
    return badRequest(
      `safetyTolerance is not supported for ${modelConfig.alias}`,
    );
  }

  return safetyTolerance;
}

function parseEnhancePrompt(
  body: Record<string, unknown>,
  modelConfig: ImageModelConfig,
): boolean | ErrorResponse {
  const enhancePrompt = readBoolean(
    body,
    "enhancePrompt",
    readBoolean(body, "enhance_prompt", false),
  );
  if (enhancePrompt && !modelConfig.supportsEnhancePrompt) {
    return badRequest(
      `enhancePrompt is not supported for ${modelConfig.alias}`,
    );
  }

  return enhancePrompt;
}

function appendSourceImageUrls(
  target: string[],
  value: unknown,
  key: string,
): ErrorResponse | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const values = Array.isArray(value) ? value : [value];
  for (const item of values) {
    if (typeof item !== "string" || item.trim().length === 0) {
      return badRequest(`${key} must contain non-empty strings`);
    }
    target.push(item.trim());
  }
  return null;
}

function parseSourceImageUrls(
  body: Record<string, unknown>,
  modelConfig: ImageModelConfig,
): readonly string[] | ErrorResponse {
  const sourceImageUrls: string[] = [];
  for (const key of [
    "imageUrl",
    "image_url",
    "imageUrls",
    "image_urls",
    "sourceImageUrls",
  ]) {
    const error = appendSourceImageUrls(sourceImageUrls, body[key], key);
    if (error) {
      return error;
    }
  }

  if (sourceImageUrls.length === 0) {
    if (modelConfig.promptless) {
      return badRequest(`${modelConfig.alias} requires imageUrl`);
    }
    return sourceImageUrls;
  }
  const maxSourceImageUrls =
    modelConfig.provider === "openai"
      ? 16
      : modelConfig.alias === "nano-banana-2" ||
          modelConfig.alias === "nano-banana-2-lite"
        ? NANO_BANANA_2_MAX_SOURCE_IMAGE_URLS
        : modelConfig.alias === "flux-2-pro"
          ? FLUX_2_PRO_MAX_SOURCE_IMAGE_URLS
          : modelConfig.alias === "seedream5-lite"
            ? SEEDREAM_5_LITE_MAX_SOURCE_IMAGE_URLS
            : modelConfig.alias === "qwen-image-3"
              ? QWEN_IMAGE_3_MAX_SOURCE_IMAGE_URLS
              : MAX_SOURCE_IMAGE_URLS;
  if (sourceImageUrls.length > maxSourceImageUrls) {
    return badRequest(
      `imageUrls supports at most ${maxSourceImageUrls} images`,
    );
  }
  if (
    modelConfig.sourceImageInput === "image_url" &&
    sourceImageUrls.length > 1
  ) {
    return badRequest(`${modelConfig.alias} accepts one source image`);
  }

  return sourceImageUrls;
}

function parseMaskImageUrl(
  body: Record<string, unknown>,
  modelConfig: ImageModelConfig,
  hasSourceImages: boolean,
): string | ErrorResponse | undefined {
  const maskImageUrl = readOptionalStringFromKeys(body, [
    "maskImageUrl",
    "mask_image_url",
  ]);
  if (typeof maskImageUrl === "object") {
    return maskImageUrl;
  }
  if (!maskImageUrl) {
    return undefined;
  }
  if (!hasSourceImages) {
    return badRequest("maskImageUrl requires imageUrl");
  }
  if (!modelConfig.supportsMaskImage) {
    return badRequest(`maskImageUrl is not supported for ${modelConfig.alias}`);
  }
  return maskImageUrl;
}

function parseInputFidelity(
  body: Record<string, unknown>,
  modelConfig: ImageModelConfig,
  hasSourceImages: boolean,
): ImageInputFidelity | ErrorResponse | undefined {
  const inputFidelity = readOptionalStringFromKeys(body, [
    "inputFidelity",
    "input_fidelity",
  ]);
  if (typeof inputFidelity === "object") {
    return inputFidelity;
  }
  if (!inputFidelity) {
    return undefined;
  }
  if (!includesString(IMAGE_INPUT_FIDELITIES, inputFidelity)) {
    return badRequest(`Unsupported input fidelity: ${inputFidelity}`);
  }
  if (!hasSourceImages) {
    return badRequest("inputFidelity requires imageUrl");
  }
  if (!modelConfig.supportsInputFidelity) {
    return badRequest(
      `inputFidelity is not supported for ${modelConfig.alias}`,
    );
  }
  return inputFidelity;
}

function parseImagePromptStrength(
  body: Record<string, unknown>,
  modelConfig: ImageModelConfig,
  hasSourceImages: boolean,
): number | ErrorResponse | undefined {
  const imagePromptStrength = readOptionalNumberFromKeys(body, [
    "imagePromptStrength",
    "image_prompt_strength",
  ]);
  if (typeof imagePromptStrength === "object") {
    return imagePromptStrength;
  }
  if (imagePromptStrength !== undefined) {
    if (imagePromptStrength < 0 || imagePromptStrength > 1) {
      return badRequest("imagePromptStrength must be between 0 and 1");
    }
    if (!hasSourceImages) {
      return badRequest("imagePromptStrength requires imageUrl");
    }
    if (!modelConfig.supportsImagePromptStrength) {
      return badRequest(
        `imagePromptStrength is not supported for ${modelConfig.alias}`,
      );
    }
    return imagePromptStrength;
  }
  return undefined;
}

function requestedDefaultImageModel(
  options: { readonly defaultModel?: ImageModel } | undefined,
): ImageModel {
  return options?.defaultModel ?? DEFAULT_IMAGE_MODEL;
}

function requestedImageSize(
  body: Record<string, unknown>,
  model: ImageModel,
  hasSourceImages: boolean,
): string {
  const defaultSize =
    hasSourceImages || model === SEEDREAM_5_LITE_MODEL ? "auto" : "1024x1024";
  return readString(body, "size", defaultSize);
}

export function parseImageOptions(
  body: unknown,
  options?: { readonly defaultModel?: ImageModel },
): ImageOptions | ErrorResponse {
  if (!isRecord(body)) {
    return badRequest("Invalid JSON body");
  }

  const model = parseImageModel(body, requestedDefaultImageModel(options));
  if (typeof model === "object") {
    return model;
  }
  const modelConfig = IMAGE_MODEL_CONFIGS[model];

  const prompt = parsePrompt(body, modelConfig);
  if (typeof prompt === "object") {
    return prompt;
  }

  const sourceImageUrls = parseSourceImageUrls(body, modelConfig);
  if (typeof sourceImageUrls === "object" && "status" in sourceImageUrls) {
    return sourceImageUrls;
  }
  const hasSourceImages = sourceImageUrls.length > 0;

  const size = requestedImageSize(body, model, hasSourceImages);
  const sizeError = validateImageSize(model, size);
  if (sizeError) {
    return sizeError;
  }

  const quality = parseImageQuality(body, modelConfig);
  if (typeof quality === "object") {
    return quality;
  }

  const background = parseImageBackground(body, modelConfig);
  if (typeof background === "object") {
    return background;
  }

  const outputOptions = parseImageOutputOptions(body, modelConfig, background);
  if (typeof outputOptions === "object" && "status" in outputOptions) {
    return outputOptions;
  }

  const moderation = parseImageModeration(body, modelConfig);
  if (typeof moderation === "object") {
    return moderation;
  }

  const seed = parseImageSeed(body, modelConfig);
  if (typeof seed === "object") {
    return seed;
  }

  const safetyTolerance = parseSafetyTolerance(body, modelConfig);
  if (typeof safetyTolerance === "object") {
    return safetyTolerance;
  }

  const enhancePrompt = parseEnhancePrompt(body, modelConfig);
  if (typeof enhancePrompt === "object") {
    return enhancePrompt;
  }

  const maskImageUrl = parseMaskImageUrl(body, modelConfig, hasSourceImages);
  if (typeof maskImageUrl === "object") {
    return maskImageUrl;
  }

  const inputFidelity = parseInputFidelity(body, modelConfig, hasSourceImages);
  if (typeof inputFidelity === "object") {
    return inputFidelity;
  }

  const imagePromptStrength = parseImagePromptStrength(
    body,
    modelConfig,
    hasSourceImages,
  );
  if (typeof imagePromptStrength === "object") {
    return imagePromptStrength;
  }

  return {
    model,
    provider: modelConfig.provider,
    prompt,
    size,
    quality,
    background,
    outputFormat: outputOptions.outputFormat,
    outputCompression: outputOptions.outputCompression,
    moderation,
    seed,
    safetyTolerance,
    enhancePrompt,
    sourceImageUrls,
    maskImageUrl,
    inputFidelity,
    imagePromptStrength,
  };
}

function mapPricingRows(
  rows: readonly {
    readonly provider: string;
    readonly category: string;
    readonly unitPrice: number;
    readonly unitSize: number;
  }[],
  resolution: UsagePricingResolution,
): ImagePricing {
  const pricing = new Map<string, ImagePricingRow>();
  for (const row of rows) {
    const model = normalizeImageModel(
      canonicalUsagePricingProvider(resolution, USAGE_KIND, row.provider),
    );
    if (model && includesString(IMAGE_PRICING_CATEGORIES, row.category)) {
      pricing.set(imagePricingKey(model, row.category), {
        provider: model,
        category: row.category,
        unitPrice: row.unitPrice,
        unitSize: row.unitSize,
      });
    }
  }
  return pricing;
}

export const imagePricing$: Computed<Promise<ImagePricing>> = computed(
  async (get): Promise<ImagePricing> => {
    const db = get(db$);
    const resolution = get(usagePricingResolution$);
    const lookupProviders = IMAGE_MODELS.map((provider) => {
      return resolveUsagePricingProvider(resolution, USAGE_KIND, provider);
    });
    const rows = await db
      .select({
        provider: usagePricing.provider,
        category: usagePricing.category,
        unitPrice: usagePricing.unitPrice,
        unitSize: usagePricing.unitSize,
      })
      .from(usagePricing)
      .where(
        and(
          eq(usagePricing.kind, USAGE_KIND),
          inArray(usagePricing.provider, lookupProviders),
          inArray(usagePricing.category, [...IMAGE_PRICING_CATEGORIES]),
        ),
      );

    return mapPricingRows(rows, resolution);
  },
);

export const checkImageCredits$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly runId?: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    return await set(checkBillableOperationCredits$, args, signal);
  },
);

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function contentTypeForFormat(format: ImageOutputFormat): string {
  if (format === "webp") {
    return "image/webp";
  }
  if (format === "jpeg") {
    return "image/jpeg";
  }
  return "image/png";
}

function normalizeImageContentType(value: string | null | undefined) {
  const contentType = value?.split(";")[0]?.trim().toLowerCase();
  if (
    contentType === "image/png" ||
    contentType === "image/webp" ||
    contentType === "image/jpeg"
  ) {
    return contentType;
  }
  return null;
}

function formatForContentType(contentType: string): ImageOutputFormat {
  if (contentType === "image/webp") {
    return "webp";
  }
  if (contentType === "image/jpeg") {
    return "jpeg";
  }
  return "png";
}

function extensionForFormat(format: ImageOutputFormat): string {
  return format === "jpeg" ? "jpg" : format;
}

function estimateImageCredits(
  model: ImageModel,
  billing: readonly ImageBillingEntry[],
  pricing: ImagePricing,
): number {
  return billing.reduce((total, row) => {
    const { category, quantity } = row;
    if (quantity <= 0) {
      return total;
    }
    const pricingRow = pricing.get(imagePricingKey(model, category));
    if (!pricingRow) {
      return total;
    }
    return (
      total + Math.ceil((quantity * pricingRow.unitPrice) / pricingRow.unitSize)
    );
  }, 0);
}

function falHeaders(falKey: string): Record<string, string> {
  return {
    Authorization: `Key ${falKey}`,
    "Content-Type": "application/json",
  };
}

function bytePlusHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

function parseFalQueueHandle(value: unknown): FalImageQueueHandle | null {
  if (!isRecord(value)) {
    return null;
  }
  const statusUrl =
    typeof value.status_url === "string" ? value.status_url : undefined;
  const responseUrl =
    typeof value.response_url === "string" ? value.response_url : undefined;
  if (!statusUrl || !responseUrl) {
    return null;
  }
  return {
    requestId:
      typeof value.request_id === "string" ? value.request_id : undefined,
    statusUrl,
    responseUrl,
  };
}

function nearestFalAspectRatio(width: number, height: number): string {
  const requestedRatio = width / height;
  let bestRatio: (typeof FAL_IMAGE_ASPECT_RATIOS)[number] =
    FAL_IMAGE_ASPECT_RATIOS[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const ratio of FAL_IMAGE_ASPECT_RATIOS) {
    const [ratioWidth, ratioHeight] = ratio.split(":").map(Number) as [
      number,
      number,
    ];
    const distance = Math.abs(requestedRatio - ratioWidth / ratioHeight);
    if (distance < bestDistance) {
      bestRatio = ratio;
      bestDistance = distance;
    }
  }
  return bestRatio;
}

function falImageSize(options: ImageOptions) {
  const modelConfig = IMAGE_MODEL_CONFIGS[options.model];
  if (options.size === "auto") {
    if (
      options.sourceImageUrls.length > 0 &&
      (options.model === FLUX_2_PRO_MODEL || options.model === IDEOGRAM_4_MODEL)
    ) {
      return "auto";
    }
    if (modelConfig.sizeMode === "standard") {
      return "1024x1024";
    }
    return "landscape_4_3";
  }
  const parsed = parseSize(options.size);
  if (!parsed) {
    return "landscape_4_3";
  }
  if (modelConfig.sizeMode === "standard") {
    return options.size;
  }
  return parsed;
}

function falAspectRatio(options: ImageOptions): string {
  if (options.size === "auto") {
    if (
      options.model === NANO_BANANA_2_MODEL ||
      options.model === NANO_BANANA_2_LITE_MODEL
    ) {
      return "auto";
    }
    return "16:9";
  }
  const parsed = parseSize(options.size);
  if (!parsed) {
    return "16:9";
  }
  return nearestFalAspectRatio(parsed.width, parsed.height);
}

function falSourceImageInput(
  modelConfig: ImageModelConfig,
  sourceImageUrls: readonly string[],
): Record<string, unknown> {
  return modelConfig.sourceImageInput === "image_url"
    ? { image_url: sourceImageUrls[0] }
    : { image_urls: sourceImageUrls };
}

function ideogramRenderingSpeed(
  quality: ImageQuality,
): "TURBO" | "BALANCED" | "QUALITY" {
  if (quality === "low") {
    return "TURBO";
  }
  if (quality === "high") {
    return "QUALITY";
  }
  return "BALANCED";
}

function falImageCountInput(options: ImageOptions): Record<string, unknown> {
  const providerSelectsCount =
    options.model === FLUX_2_PRO_MODEL ||
    (options.model === IDEOGRAM_4_MODEL && options.sourceImageUrls.length > 0);
  return providerSelectsCount ? {} : { num_images: 1 };
}

function falQualityInput(
  options: ImageOptions,
  modelConfig: ImageModelConfig,
): Record<string, unknown> {
  if (options.model === IDEOGRAM_4_MODEL) {
    return {
      rendering_speed: ideogramRenderingSpeed(options.quality),
      // Prompt compilation already happens in Okou. Disabling Ideogram's
      // expansion avoids changing the prompt and its separate $0.03 fee.
      expansion_model: "None",
    };
  }
  return modelConfig.supportsQuality ? { quality: options.quality } : {};
}

export interface ImageProviderReferences {
  readonly sourceImageUrls: readonly string[];
  readonly maskImageUrl: string | undefined;
}

function falImageInput(
  options: ImageOptions,
  references: ImageProviderReferences,
): Record<string, unknown> {
  const modelConfig = IMAGE_MODEL_CONFIGS[options.model];
  if (modelConfig.promptless) {
    return falSourceImageInput(modelConfig, references.sourceImageUrls);
  }
  return {
    prompt: options.prompt,
    ...(modelConfig.sizeParameter === "aspect_ratio"
      ? { aspect_ratio: falAspectRatio(options) }
      : { image_size: falImageSize(options) }),
    ...falImageCountInput(options),
    ...(hasString(modelConfig.outputFormats, options.outputFormat) &&
    modelConfig.alias !== "seedream4"
      ? { output_format: options.outputFormat }
      : {}),
    ...(options.model === NANO_BANANA_2_MODEL ? { resolution: "1K" } : {}),
    ...falQualityInput(options, modelConfig),
    ...(modelConfig.supportsBackground
      ? { background: options.background }
      : {}),
    ...(modelConfig.usesOpenAiByok
      ? { openai_api_key: env("OPENAI_API_KEY") }
      : {}),
    ...(modelConfig.supportsSeed && options.seed !== undefined
      ? { seed: options.seed }
      : {}),
    ...(modelConfig.supportsSafetyTolerance
      ? { safety_tolerance: options.safetyTolerance }
      : {}),
    ...(modelConfig.supportsEnhancePrompt
      ? { enhance_prompt: options.enhancePrompt }
      : {}),
    ...(options.sourceImageUrls.length > 0
      ? falSourceImageInput(modelConfig, references.sourceImageUrls)
      : {}),
    ...(modelConfig.supportsMaskImage && references.maskImageUrl
      ? { mask_image_url: references.maskImageUrl }
      : {}),
    ...(modelConfig.supportsInputFidelity && options.inputFidelity
      ? { input_fidelity: options.inputFidelity }
      : {}),
    ...(modelConfig.supportsImagePromptStrength &&
    options.imagePromptStrength !== undefined
      ? { image_prompt_strength: options.imagePromptStrength }
      : {}),
  };
}

function falImageEndpointId(options: ImageOptions): string {
  const modelConfig = IMAGE_MODEL_CONFIGS[options.model];
  return options.sourceImageUrls.length > 0
    ? modelConfig.imageToImageEndpointId
    : modelConfig.endpointId;
}

async function readImageProviderErrorBody(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  const body = await response.text();
  signal.throwIfAborted();
  return redactPresignedUrls(body).slice(0, 4000);
}

export async function submitFalImageQueueGeneration(
  options: ImageOptions,
  references: ImageProviderReferences,
  falKey: string,
  webhookUrl: string,
  signal: AbortSignal,
): Promise<FalImageQueueHandle | ErrorResponse> {
  const endpointId = falImageEndpointId(options);
  const queueUrl = new URL(`${FAL_IMAGE_QUEUE_URL_PREFIX}/${endpointId}`);
  queueUrl.searchParams.set("fal_webhook", webhookUrl);
  const response = await fetch(queueUrl, {
    method: "POST",
    headers: falHeaders(falKey),
    body: JSON.stringify(falImageInput(options, references)),
    signal,
  });

  if (!response.ok) {
    const errorBody = await readImageProviderErrorBody(response, signal);
    L.error("Fal image queue request failed", {
      endpointId,
      model: options.model,
      status: response.status,
      body: errorBody,
    });
    return badGateway("Image generation failed", "FAL_IMAGE_REQUEST_FAILED");
  }

  const body: unknown = await response.json();
  const handle = parseFalQueueHandle(body);
  if (!handle) {
    return badGateway("Fal returned no queue handle", "NO_QUEUE_HANDLE");
  }
  return handle;
}

function falQueueResponseUrl(value: string | undefined): URL | null {
  if (!value || !URL.canParse(value)) {
    return null;
  }
  const url = new URL(value);
  const queueOrigin = new URL(FAL_IMAGE_QUEUE_URL_PREFIX);
  return url.origin === queueOrigin.origin ? url : null;
}

export async function getFalImageBillableUnits(
  options: ImageOptions,
  responseUrl: string | undefined,
  falKey: string | undefined,
  signal: AbortSignal,
): Promise<number | ErrorResponse | undefined> {
  const modelConfig = IMAGE_MODEL_CONFIGS[options.model];
  if (modelConfig.billingMode !== "flux_2_processed_megapixel") {
    return undefined;
  }
  const url = falQueueResponseUrl(responseUrl);
  if (!url) {
    return badGateway("Fal returned no billing details", "NO_BILLING_UNITS");
  }
  if (!falKey) {
    return serviceUnavailable(
      "Fal image generation is not configured",
      "NOT_CONFIGURED",
    );
  }

  const response = await fetch(url, {
    method: "GET",
    headers: falHeaders(falKey),
    signal,
  });
  if (!response.ok) {
    const errorBody = await readImageProviderErrorBody(response, signal);
    L.error("Fal image billing response failed", {
      model: options.model,
      status: response.status,
      body: errorBody,
    });
    return badGateway("Fal returned no billing details", "NO_BILLING_UNITS");
  }

  const rawBillableUnits = response.headers.get(FAL_BILLABLE_UNITS_HEADER);
  await response.arrayBuffer();
  signal.throwIfAborted();
  const billableUnits = Number(rawBillableUnits);
  if (
    !rawBillableUnits ||
    !Number.isFinite(billableUnits) ||
    billableUnits <= 0
  ) {
    return badGateway("Fal returned no billing details", "NO_BILLING_UNITS");
  }
  return billableUnits;
}

function bytePlusImageSize(options: ImageOptions): string {
  return options.size === "auto" ? "2K" : options.size;
}

function bytePlusImageInput(
  options: ImageOptions,
  references: ImageProviderReferences,
): Record<string, unknown> {
  const sourceImages =
    references.sourceImageUrls.length === 1
      ? references.sourceImageUrls[0]
      : references.sourceImageUrls;
  return {
    model: options.model,
    prompt: options.prompt,
    ...(options.sourceImageUrls.length > 0 ? { image: sourceImages } : {}),
    size: bytePlusImageSize(options),
    output_format: options.outputFormat,
    response_format: "url",
    watermark: false,
  };
}

function parseBytePlusImageFile(value: unknown): BytePlusImageFile | null {
  if (!isRecord(value) || typeof value.url !== "string") {
    return null;
  }
  const size = typeof value.size === "string" ? value.size : undefined;
  const parsedSize = size ? parseSize(size) : null;
  const outputFormat =
    typeof value.output_format === "string" &&
    includesString(IMAGE_OUTPUT_FORMATS, value.output_format)
      ? value.output_format
      : undefined;
  return {
    url: value.url,
    width: parsedSize?.width,
    height: parsedSize?.height,
    size,
    outputFormat,
  };
}

function parseBytePlusImageResult(
  value: unknown,
): BytePlusImageResult | ErrorResponse {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    return badGateway("BytePlus returned no image data", "NO_IMAGE_RETURNED");
  }
  const image = parseBytePlusImageFile(value.data[0]);
  if (!image) {
    return badGateway("BytePlus returned no image data", "NO_IMAGE_RETURNED");
  }
  return { image };
}

export async function generateBytePlusImage(
  options: ImageOptions,
  references: ImageProviderReferences,
  apiKey: string,
  signal: AbortSignal,
): Promise<ParsedImageGeneration | ErrorResponse> {
  const response = await fetch(BYTEPLUS_IMAGE_GENERATIONS_URL, {
    method: "POST",
    headers: bytePlusHeaders(apiKey),
    body: JSON.stringify(bytePlusImageInput(options, references)),
    signal,
  });
  if (!response.ok) {
    const responseBody = await readImageProviderErrorBody(response, signal);
    L.error("BytePlus image generation request failed", {
      model: options.model,
      status: response.status,
      body: responseBody,
    });
    return badGateway(
      "Image generation failed",
      "BYTEPLUS_IMAGE_REQUEST_FAILED",
    );
  }

  const responseText = await response.text();
  signal.throwIfAborted();
  const body = safeJsonParse(responseText);
  if (body === undefined) {
    return badGateway(
      "BytePlus returned an invalid response",
      "BYTEPLUS_IMAGE_BAD_RESPONSE",
    );
  }
  const result = parseBytePlusImageResult(body);
  if ("status" in result) {
    return result;
  }
  return await downloadBytePlusImage(result, options, signal);
}

const openAiImageResponseSchema = z.object({
  data: z.tuple([
    z.object({
      b64_json: z.string().min(1),
      revised_prompt: z.string().optional(),
    }),
  ]),
  size: z.string().optional(),
  quality: z.enum(OPENAI_IMAGE_QUALITIES).optional(),
  background: z.enum(IMAGE_BACKGROUNDS).optional(),
  output_format: z.enum(IMAGE_OUTPUT_FORMATS).optional(),
  usage: z.object({
    input_tokens_details: z.object({
      text_tokens: z.number().int().nonnegative(),
      image_tokens: z.number().int().nonnegative(),
    }),
    output_tokens: z.number().int().positive(),
    output_tokens_details: z
      .object({
        image_tokens: z.number().int().positive(),
      })
      .optional(),
  }),
});

const openAiImageErrorSchema = z.object({
  error: z.object({
    type: z.string().optional(),
    code: z.string().optional(),
    moderation_details: z
      .object({
        moderation_stage: z.enum(["input", "output", "unknown"]).optional(),
      })
      .optional(),
  }),
});

interface OpenAiImageFailure {
  readonly response: ErrorResponse;
  readonly retryPolicy: string;
  /** A failure the caller resolves by changing the request, not an operator. */
  readonly userInput: boolean;
}

const OPENAI_IMAGE_USER_ERROR_TYPE = "image_generation_user_error";

function unclassifiedOpenAiImageFailure(): OpenAiImageFailure {
  return {
    response: badGateway(
      "Image generation failed",
      "OPENAI_IMAGE_REQUEST_FAILED",
    ),
    retryPolicy: "retry_once",
    userInput: false,
  };
}

/**
 * OpenAI documents `image_generation_user_error` as user-correctable, tells
 * callers not to retry it unmodified, and names `error.code` the stable
 * discriminator. Only the allowlisted codes below become an actionable input
 * failure; every other status, type, or code keeps the provider-fault
 * classification so an unrecognized failure stays visible to an operator.
 */
function classifyOpenAiImageFailure(
  status: number,
  body: unknown,
): OpenAiImageFailure {
  const parsed = openAiImageErrorSchema.safeParse(body);
  if (!parsed.success || status !== 400) {
    return unclassifiedOpenAiImageFailure();
  }
  const providerError = parsed.data.error;
  if (providerError.type !== OPENAI_IMAGE_USER_ERROR_TYPE) {
    return unclassifiedOpenAiImageFailure();
  }
  if (providerError.code === "invalid_image_file") {
    return {
      response: badRequest(
        "An input image could not be read by the generation provider.",
        "GENERATION_INPUT_MEDIA_INVALID",
      ),
      retryPolicy: "after_input_change",
      userInput: true,
    };
  }
  if (providerError.code === "moderation_blocked") {
    // Only an explicit output stage means our generated image was blocked;
    // input and unknown stages stay a caller-correctable input rejection.
    return providerError.moderation_details?.moderation_stage === "output"
      ? {
          response: badRequest(
            "The generated image was blocked by the safety filter.",
            "GENERATION_OUTPUT_SAFETY_BLOCKED",
          ),
          retryPolicy: "manual_once",
          userInput: true,
        }
      : {
          response: badRequest(
            "The prompt or reference image was blocked by the safety filter.",
            "GENERATION_INPUT_SAFETY_REJECTED",
          ),
          retryPolicy: "after_input_change",
          userInput: true,
        };
  }
  return unclassifiedOpenAiImageFailure();
}

export async function generateOpenAiImage(
  options: ImageOptions,
  references: ImageProviderReferences,
  apiKey: string,
  signal: AbortSignal,
): Promise<ParsedImageGeneration | ErrorResponse> {
  const editing = references.sourceImageUrls.length > 0;
  const response = await fetch(
    `${OPENAI_IMAGES_URL_PREFIX}/${editing ? "edits" : "generations"}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: options.model,
        prompt: options.prompt,
        n: 1,
        size: options.size,
        quality: options.quality,
        background: options.background,
        output_format: options.outputFormat,
        output_compression: options.outputCompression,
        moderation: options.moderation,
        ...(editing
          ? {
              images: references.sourceImageUrls.map((imageUrl) => {
                return { image_url: imageUrl };
              }),
              ...(references.maskImageUrl
                ? {
                    mask: { image_url: references.maskImageUrl },
                  }
                : {}),
            }
          : {}),
      }),
      signal,
    },
  );
  if (!response.ok) {
    const responseBody = await response.text();
    signal.throwIfAborted();
    const failure = classifyOpenAiImageFailure(
      response.status,
      safeJsonParse(responseBody),
    );
    // Provider-rejected input is routine and already carried by the public
    // error code the caller receives, so only a provider-side failure is
    // logged. The provider body echoes request input and provider request IDs,
    // so it never reaches the log.
    if (!failure.userInput) {
      L.warn("OpenAI image generation request failed", {
        provider: "openai",
        model: options.model,
        providerStatus: response.status,
        publicErrorCode: failure.response.body.error.code,
        retryPolicy: failure.retryPolicy,
      });
    }
    return failure.response;
  }

  const responseText = await response.text();
  signal.throwIfAborted();
  const parsed = openAiImageResponseSchema.safeParse(
    safeJsonParse(responseText),
  );
  if (!parsed.success) {
    return badGateway(
      "OpenAI returned invalid image data or token usage",
      "OPENAI_IMAGE_BAD_RESPONSE",
    );
  }
  const result = parsed.data;
  const image = result.data[0];
  const imageBytes = Buffer.from(image.b64_json, "base64");
  if (imageBytes.byteLength === 0) {
    return badGateway("Model returned empty image", "NO_IMAGE_RETURNED");
  }

  return {
    model: options.model,
    provider: "openai",
    imageBytes,
    revisedPrompt: image.revised_prompt,
    imageSize: result.size ?? options.size,
    quality: result.quality ?? options.quality,
    background: result.background ?? options.background,
    outputFormat: result.output_format ?? options.outputFormat,
    outputCompression: options.outputCompression,
    moderation: options.moderation,
    safetyTolerance: undefined,
    billing: [
      {
        category: "tokens.input.text",
        quantity: result.usage.input_tokens_details.text_tokens,
      },
      {
        category: "tokens.input.image",
        quantity: result.usage.input_tokens_details.image_tokens,
      },
      {
        category: "tokens.output.image",
        quantity:
          result.usage.output_tokens_details?.image_tokens ??
          result.usage.output_tokens,
      },
    ],
    sourceUrl: undefined,
    seed: undefined,
    sourceImageUrls: options.sourceImageUrls,
    maskImageUrl: options.maskImageUrl,
    inputFidelity: undefined,
    imagePromptStrength: undefined,
  };
}

function parseFalImageFile(value: unknown): FalImageFile | null {
  if (!isRecord(value) || typeof value.url !== "string") {
    return null;
  }
  return {
    url: value.url,
    contentType:
      typeof value.content_type === "string" ? value.content_type : undefined,
    width: readNumber(value.width),
    height: readNumber(value.height),
  };
}

function readFalSeed(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : undefined;
}

export function parseFalImageResult(
  value: unknown,
): FalImageResult | ErrorResponse {
  if (!isRecord(value) || !Array.isArray(value.images)) {
    return badGateway("Model returned no image data", "NO_IMAGE_RETURNED");
  }

  const image = parseFalImageFile(value.images[0]);
  if (!image) {
    return badGateway("Model returned no image data", "NO_IMAGE_RETURNED");
  }

  return {
    image,
    revisedPrompt:
      typeof value.prompt === "string"
        ? value.prompt
        : typeof value.description === "string"
          ? value.description
          : undefined,
    seed: readFalSeed(value.seed),
  };
}

function megapixelsForImage(
  image: FalImageFile,
  options: ImageOptions,
): number {
  if (image.width && image.height) {
    return Math.max(1, Math.ceil((image.width * image.height) / 1_000_000));
  }
  const parsed = parseSize(options.size);
  if (!parsed) {
    return 1;
  }
  return Math.max(1, Math.ceil((parsed.width * parsed.height) / 1_000_000));
}

function providerMegapixelsForImage(
  image: FalImageFile,
): number | ErrorResponse {
  if (!image.width || !image.height) {
    return badGateway("Fal returned no billing details", "NO_BILLING_UNITS");
  }
  // fal's pricing examples treat 1024x1024 as one MP and 2048x2048 as four.
  return Math.max(1, Math.ceil((image.width * image.height) / (1024 * 1024)));
}

/**
 * fal returns Qwen Image 3 files without dimensions, so the tier falls back to
 * the requested size. An unparsed size means the request carried `auto` and
 * therefore sent a fal size preset; every preset fal accepts tops out at
 * 1024x1024, which stays under the tier split.
 */
function pixelsForImage(image: FalImageFile, options: ImageOptions): number {
  if (image.width && image.height) {
    return image.width * image.height;
  }
  const parsed = parseSize(options.size);
  return parsed ? parsed.width * parsed.height : FAL_SIZE_PRESET_MAX_PIXELS;
}

function falPixelTierImageCategory(
  image: FalImageFile,
  options: ImageOptions,
): ImagePricingCategory {
  return pixelsForImage(image, options) > QWEN_IMAGE_3_STANDARD_TIER_MAX_PIXELS
    ? "output_image.2k"
    : "output_image.1k";
}

function ideogramMegapixelCategory(
  options: ImageOptions,
): ImagePricingCategory {
  return `output_megapixel.${ideogramRenderingSpeed(options.quality).toLowerCase()}` as ImagePricingCategory;
}

function flux2AdditionalProcessedMegapixels(falBillableUnits: number): number {
  // Fal reports one billable unit for the first processed MP and half a unit
  // for each additional processed MP, matching FLUX.2 Pro's tiered pricing.
  return Math.max(0, Math.round((falBillableUnits - 1) * 2));
}

function falBillingEntries(
  image: FalImageFile,
  options: ImageOptions,
  falBillableUnits: number | undefined,
): readonly ImageBillingEntry[] | ErrorResponse {
  const modelConfig = IMAGE_MODEL_CONFIGS[options.model];
  if (modelConfig.billingMode === "flux_2_processed_megapixel") {
    if (falBillableUnits === undefined) {
      throw new Error("FLUX.2 Pro requires Fal billable units");
    }
    return [
      { category: "processed_megapixel.first", quantity: 1 },
      {
        category: "processed_megapixel.additional",
        quantity: flux2AdditionalProcessedMegapixels(falBillableUnits),
      },
    ];
  }
  if (modelConfig.billingMode === "ideogram_rendering_speed_megapixel") {
    const outputMegapixels = providerMegapixelsForImage(image);
    if (typeof outputMegapixels !== "number") {
      return outputMegapixels;
    }
    return [
      {
        category: ideogramMegapixelCategory(options),
        quantity: outputMegapixels,
      },
    ];
  }
  if (modelConfig.billingMode === "pixel_tier_image") {
    return [
      { category: falPixelTierImageCategory(image, options), quantity: 1 },
    ];
  }
  if (modelConfig.billingMode === "megapixel") {
    return [
      {
        category: FAL_OUTPUT_MEGAPIXEL_CATEGORY,
        quantity: megapixelsForImage(image, options),
      },
    ];
  }
  if (modelConfig.billingMode === "quality_size_image") {
    return [
      { category: falQualitySizeImageCategory(image, options), quantity: 1 },
    ];
  }
  return [{ category: FAL_OUTPUT_IMAGE_CATEGORY, quantity: 1 }];
}

function bytePlusOutputPixels(
  image: BytePlusImageFile,
  options: ImageOptions,
): number | undefined {
  if (image.width && image.height) {
    return image.width * image.height;
  }
  const parsedRequestedSize = parseSize(options.size);
  if (parsedRequestedSize) {
    return parsedRequestedSize.width * parsedRequestedSize.height;
  }
  if (options.size === "2K" || options.size === "auto") {
    return 2048 * 2048;
  }
  if (options.size === "1.5K") {
    return 1536 * 1536;
  }
  if (options.size === "1K") {
    return 1024 * 1024;
  }
  return undefined;
}

function bytePlusProviderCostUsdMicros(
  image: BytePlusImageFile,
  options: ImageOptions,
): number {
  if (options.model === SEEDREAM_5_LITE_MODEL) {
    return SEEDREAM_5_LITE_OUTPUT_COST_USD_MICROS;
  }
  const outputPixels = bytePlusOutputPixels(image, options);
  const outputCost =
    outputPixels !== undefined &&
    outputPixels > SEEDREAM_5_PRO_LOW_TIER_MAX_PIXELS
      ? SEEDREAM_5_PRO_HIGH_TIER_OUTPUT_COST_USD_MICROS
      : SEEDREAM_5_PRO_LOW_TIER_OUTPUT_COST_USD_MICROS;
  const additionalInputCost =
    Math.max(0, options.sourceImageUrls.length - 1) *
    SEEDREAM_5_PRO_ADDITIONAL_INPUT_COST_USD_MICROS;
  return outputCost + additionalInputCost;
}

function bytePlusBillingEntries(
  image: BytePlusImageFile,
  options: ImageOptions,
): readonly ImageBillingEntry[] {
  return [
    {
      category: PROVIDER_COST_USD_MICROS_CATEGORY,
      quantity: bytePlusProviderCostUsdMicros(image, options),
    },
  ];
}

function falQualitySizeImageCategory(
  image: FalImageFile,
  options: ImageOptions,
): ImagePricingCategory {
  const quality =
    options.quality === "high" || options.quality === "low"
      ? options.quality
      : "medium";
  const imageSize =
    image.width && image.height
      ? `${image.width}x${image.height}`
      : options.size;
  const sizeTier =
    imageSize === "auto" || imageSize === "1024x1024" ? "standard" : "large";
  return `output_image.${quality}.${sizeTier}` as ImagePricingCategory;
}

export async function downloadFalImage(
  result: FalImageResult,
  options: ImageOptions,
  falBillableUnits: number | undefined,
  signal: AbortSignal,
): Promise<ParsedImageGeneration | ErrorResponse> {
  const billing = falBillingEntries(result.image, options, falBillableUnits);
  if ("status" in billing) {
    return billing;
  }

  const response = await fetch(result.image.url, { method: "GET", signal });
  if (!response.ok) {
    return badGateway(
      "Could not download generated image",
      "IMAGE_DOWNLOAD_FAILED",
    );
  }

  const imageBytes = Buffer.from(await response.arrayBuffer());
  if (imageBytes.byteLength === 0) {
    return badGateway("Model returned empty image", "NO_IMAGE_RETURNED");
  }

  const contentType =
    normalizeImageContentType(result.image.contentType) ??
    normalizeImageContentType(response.headers.get("content-type")) ??
    contentTypeForFormat(options.outputFormat);
  const outputFormat = formatForContentType(contentType);
  const imageSize =
    result.image.width && result.image.height
      ? `${result.image.width}x${result.image.height}`
      : options.size;
  const modelConfig = IMAGE_MODEL_CONFIGS[options.model];

  return {
    model: options.model,
    provider: "fal",
    imageBytes,
    revisedPrompt: result.revisedPrompt,
    imageSize,
    quality: modelConfig.supportsQuality ? options.quality : "model-default",
    background: modelConfig.supportsBackground ? options.background : "auto",
    outputFormat,
    outputCompression: undefined,
    moderation: options.moderation,
    safetyTolerance: modelConfig.supportsSafetyTolerance
      ? options.safetyTolerance
      : undefined,
    billing,
    sourceUrl: result.image.url,
    seed: result.seed ?? options.seed,
    sourceImageUrls: options.sourceImageUrls,
    maskImageUrl: options.maskImageUrl,
    inputFidelity: options.inputFidelity,
    imagePromptStrength: options.imagePromptStrength,
  };
}

async function downloadBytePlusImage(
  result: BytePlusImageResult,
  options: ImageOptions,
  signal: AbortSignal,
): Promise<ParsedImageGeneration | ErrorResponse> {
  const response = await fetch(result.image.url, { method: "GET", signal });
  if (!response.ok) {
    return badGateway(
      "Could not download generated image",
      "IMAGE_DOWNLOAD_FAILED",
    );
  }

  const imageBytes = Buffer.from(await response.arrayBuffer());
  if (imageBytes.byteLength === 0) {
    return badGateway("Model returned empty image", "NO_IMAGE_RETURNED");
  }

  const fallbackFormat = result.image.outputFormat ?? options.outputFormat;
  const contentType =
    normalizeImageContentType(response.headers.get("content-type")) ??
    contentTypeForFormat(fallbackFormat);
  const outputFormat = formatForContentType(contentType);
  const imageSize =
    result.image.width && result.image.height
      ? `${result.image.width}x${result.image.height}`
      : (result.image.size ?? bytePlusImageSize(options));

  return {
    model: options.model,
    provider: "byteplus",
    imageBytes,
    revisedPrompt: undefined,
    imageSize,
    quality: "model-default",
    background: "auto",
    outputFormat,
    outputCompression: undefined,
    moderation: options.moderation,
    safetyTolerance: undefined,
    billing: bytePlusBillingEntries(result.image, options),
    sourceUrl: result.image.url,
    seed: undefined,
    sourceImageUrls: options.sourceImageUrls,
    maskImageUrl: options.maskImageUrl,
    inputFidelity: options.inputFidelity,
    imagePromptStrength: options.imagePromptStrength,
  };
}

function generatedImageMetadata(
  generation: ParsedImageGeneration,
  isPrivate: boolean,
) {
  return {
    generatedBy: "zero-official-image",
    model: generation.model,
    provider: generation.provider,
    imageSize: generation.imageSize,
    quality: generation.quality,
    background: generation.background,
    outputFormat: generation.outputFormat,
    ...(generation.outputCompression !== undefined
      ? { outputCompression: generation.outputCompression }
      : {}),
    moderation: generation.moderation,
    safetyTolerance: generation.safetyTolerance,
    sourceUrl: isPrivate ? undefined : generation.sourceUrl,
    seed: generation.seed,
    sourceImageUrls: generation.sourceImageUrls,
    maskImageUrl: generation.maskImageUrl,
    inputFidelity: generation.inputFidelity,
    imagePromptStrength: generation.imagePromptStrength,
  };
}

export const recordGeneratedImage$ = command(
  async (
    { set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly runId: string | undefined;
      readonly publicBrand: PublicBrand;
      readonly privateArtifacts: boolean;
      readonly pricing: ImagePricing;
      readonly generation: ParsedImageGeneration;
      readonly recordArtifact?: boolean;
      readonly usageIdempotency: BuiltInGenerationUsageIdempotency;
    },
    signal: AbortSignal,
  ): Promise<RecordedImage> => {
    const writeDb = set(writeDb$);
    const artifact = await set(
      storeGeneratedArtifactObject$,
      {
        userId: params.userId,
        orgId: params.orgId,
        privateArtifacts: params.privateArtifacts,
        filenamePrefix: "image",
        extension: extensionForFormat(params.generation.outputFormat),
        body: params.generation.imageBytes,
        contentType: contentTypeForFormat(params.generation.outputFormat),
        publicBrand: params.publicBrand,
      },
      signal,
    );
    const { id: fileId, filename, key: s3Key, url } = artifact;
    const contentType = contentTypeForFormat(params.generation.outputFormat);

    if (params.recordArtifact !== false) {
      await set(
        recordWebUploadedFile$,
        {
          runId: params.runId,
          externalId: fileId,
          userId: params.userId,
          orgId: params.orgId,
          filename,
          contentType,
          sizeBytes: params.generation.imageBytes.byteLength,
          url,
          s3Key,
          publicBrand: params.publicBrand,
          metadata: generatedImageMetadata(
            params.generation,
            artifact.isPrivate,
          ),
        },
        signal,
      );
      signal.throwIfAborted();
    }

    const usageRows = params.generation.billing.filter((row) => {
      return row.quantity > 0;
    });

    await writeDb
      .insert(usageEvent)
      .values(
        usageRows.map((row) => {
          return {
            runId: params.runId ?? null,
            idempotencyKey: builtInGenerationUsageIdempotencyKey({
              ...params.usageIdempotency,
              category: row.category,
            }),
            orgId: params.orgId,
            userId: params.userId,
            kind: USAGE_KIND,
            provider: params.generation.model,
            category: row.category,
            quantity: row.quantity,
          };
        }),
      )
      .onConflictDoNothing({ target: [usageEvent.idempotencyKey] });
    signal.throwIfAborted();

    await set(processOrgUsageEvents$, params.orgId, signal);
    signal.throwIfAborted();

    return {
      id: fileId,
      filename,
      contentType,
      size: params.generation.imageBytes.byteLength,
      url,
      // Models such as seedream4 only emit PNG. Serving the stored object
      // through Cloudflare Image Resizing negotiates AVIF/WebP per request, so
      // pages embedding this image download a fraction of the PNG bytes.
      embedUrl: artifact.isPrivate ? undefined : r2ImageTransformUrl(url, {}),
      creditsCharged: estimateImageCredits(
        params.generation.model,
        params.generation.billing,
        params.pricing,
      ),
      model: params.generation.model,
      provider: params.generation.provider,
      imageSize: params.generation.imageSize,
      quality: params.generation.quality,
      background: params.generation.background,
      outputFormat: params.generation.outputFormat,
      outputCompression: params.generation.outputCompression,
      moderation: params.generation.moderation,
      safetyTolerance: params.generation.safetyTolerance,
      revisedPrompt: params.generation.revisedPrompt,
      billingCategory: params.generation.billing[0]?.category,
      billingQuantity: params.generation.billing[0]?.quantity,
      sourceUrl: artifact.isPrivate ? undefined : params.generation.sourceUrl,
      seed: params.generation.seed,
      sourceImageUrls: params.generation.sourceImageUrls,
      maskImageUrl: params.generation.maskImageUrl,
      inputFidelity: params.generation.inputFidelity,
      imagePromptStrength: params.generation.imagePromptStrength,
    };
  },
);
