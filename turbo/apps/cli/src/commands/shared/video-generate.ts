import { parseArtifactReference } from "@okouai/api-contracts/contracts/artifact-references";
import { Command, InvalidArgumentError } from "commander";
import chalk from "chalk";
import { ApiRequestError } from "../../lib/api/core/client-factory";
import {
  fetchGenerationReference,
  generateWebVideo,
} from "../../lib/api/domains/web";
import { getBillingStatus } from "../../lib/api/domains/billing";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { assertPaidToolEnabled } from "../../lib/command/paid-tools";
import { createArtifactPresentation } from "./artifact-return";
import {
  applyArtifactVisibility,
  createArtifactVisibilityOption,
  prepareArtifactVisibility,
  type ArtifactVisibility,
} from "./artifact-visibility";
import {
  findVideoTemplate,
  listVideoTemplates,
} from "@okouai/core/resource-registry";
import { DEFAULT_VIDEO_MODEL_ALIAS } from "@okouai/core/video-model-catalog";
import { formatRegistryListing } from "./resource-listing";
import { createVideoTemplateAuthoringPacket } from "./video-template-authoring";
import {
  currentPlanAllowsVideo,
  currentTokenCanReadBilling,
} from "./billing-capabilities";
import { dispatchGenerate } from "../generate/lib/dispatch";
import type { GenerationType } from "../generate/lib/lister";

interface VideoOptions {
  prompt?: string;
  provider?: string;
  template?: string;
  model?: string;
  aspectRatio: string;
  duration: string;
  resolution?: string;
  audio?: boolean;
  negativePrompt?: string;
  seed?: number;
  autoFix?: boolean;
  safetyTolerance: string;
  imageUrl?: string[];
  videoUrl?: string[];
  audioUrl?: string[];
  firstFrameImageUrl?: string;
  lastFrameImageUrl?: string;
  all?: boolean;
  json?: boolean;
  visibility?: ArtifactVisibility;
}

interface VideoGenerateCommandConfig {
  name: string;
  generationType: GenerationType;
  usageCommand: string;
  examples: string;
}

interface ImageDimensions {
  width: number;
  height: number;
}

const FRAME_ASPECT_RATIO_TOLERANCE = 0.02;
const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function parseSeed(value: string): number {
  const seed = Number(value);
  if (!Number.isInteger(seed) || seed < 0 || !Number.isSafeInteger(seed)) {
    throw new InvalidArgumentError("seed must be a non-negative safe integer");
  }
  return seed;
}

function collectUrl(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function unknownTemplateError(id: string, usageCommand: string): Error {
  const templates = listVideoTemplates();
  const message = [
    `Unknown video template: ${id}`,
    "",
    "Available video templates:",
    formatRegistryListing(templates, "video templates"),
    "",
    `Example:`,
    `  ${usageCommand} --template ${templates[0]?.id ?? "<template-id>"} --prompt "..."`,
  ].join("\n");
  return new Error(message);
}

function parseAspectRatio(value: string): ImageDimensions {
  const [widthText, heightText] = value.split(":");
  const width = Number(widthText);
  const height = Number(heightText);
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error(`Invalid --aspect-ratio "${value}"`);
  }
  return { width, height };
}

function readPngDimensions(buffer: Buffer): ImageDimensions | undefined {
  if (
    buffer.length < 24 ||
    buffer.toString("latin1", 0, 8) !== "\x89PNG\r\n\x1a\n"
  ) {
    return undefined;
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function readGifDimensions(buffer: Buffer): ImageDimensions | undefined {
  if (
    buffer.length < 10 ||
    !buffer.toString("latin1", 0, 6).startsWith("GIF")
  ) {
    return undefined;
  }
  return {
    width: buffer.readUInt16LE(6),
    height: buffer.readUInt16LE(8),
  };
}

function readJpegDimensions(buffer: Buffer): ImageDimensions | undefined {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return undefined;
  }

  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = buffer[offset + 1] as number;
    if (marker === 0xd9 || marker === 0xda) {
      break;
    }

    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (segmentLength < 2 || offset + 2 + segmentLength > buffer.length) {
      break;
    }

    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }

    offset += 2 + segmentLength;
  }

  return undefined;
}

function readUnsigned24LE(buffer: Buffer, offset: number): number {
  return (
    buffer.readUInt8(offset) +
    (buffer.readUInt8(offset + 1) << 8) +
    (buffer.readUInt8(offset + 2) << 16)
  );
}

function readWebpDimensions(buffer: Buffer): ImageDimensions | undefined {
  if (
    buffer.length < 30 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WEBP"
  ) {
    return undefined;
  }

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkType = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const payloadOffset = offset + 8;
    if (payloadOffset + chunkSize > buffer.length) {
      break;
    }

    if (chunkType === "VP8X" && chunkSize >= 10) {
      return {
        width: readUnsigned24LE(buffer, payloadOffset + 4) + 1,
        height: readUnsigned24LE(buffer, payloadOffset + 7) + 1,
      };
    }

    if (
      chunkType === "VP8L" &&
      chunkSize >= 5 &&
      buffer[payloadOffset] === 0x2f
    ) {
      const byte1 = buffer.readUInt8(payloadOffset + 1);
      const byte2 = buffer.readUInt8(payloadOffset + 2);
      const byte3 = buffer.readUInt8(payloadOffset + 3);
      const byte4 = buffer.readUInt8(payloadOffset + 4);
      return {
        width: 1 + byte1 + ((byte2 & 0x3f) << 8),
        height:
          1 + ((byte2 & 0xc0) >> 6) + (byte3 << 2) + ((byte4 & 0x0f) << 10),
      };
    }

    if (
      chunkType === "VP8 " &&
      chunkSize >= 10 &&
      buffer[payloadOffset + 3] === 0x9d &&
      buffer[payloadOffset + 4] === 0x01 &&
      buffer[payloadOffset + 5] === 0x2a
    ) {
      return {
        width: buffer.readUInt16LE(payloadOffset + 6) & 0x3fff,
        height: buffer.readUInt16LE(payloadOffset + 8) & 0x3fff,
      };
    }

    offset = payloadOffset + chunkSize + (chunkSize % 2);
  }

  return undefined;
}

function readImageDimensions(buffer: Buffer): ImageDimensions | undefined {
  return (
    readPngDimensions(buffer) ??
    readJpegDimensions(buffer) ??
    readWebpDimensions(buffer) ??
    readGifDimensions(buffer)
  );
}

function formatDimensionsAsRatio({ width, height }: ImageDimensions): string {
  const divisor = greatestCommonDivisor(width, height);
  return `${width / divisor}:${height / divisor}`;
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a || 1;
}

function hasMatchingAspectRatio(
  actual: ImageDimensions,
  expected: ImageDimensions,
): boolean {
  const actualRatio = actual.width / actual.height;
  const expectedRatio = expected.width / expected.height;
  return (
    Math.abs(actualRatio - expectedRatio) / expectedRatio <=
    FRAME_ASPECT_RATIO_TOLERANCE
  );
}

async function fetchImageDimensions(
  optionName: string,
  imageUrl: string,
): Promise<ImageDimensions> {
  if (!parseArtifactReference(imageUrl) && !URL.canParse(imageUrl)) {
    throw new Error(
      `${optionName} must be an absolute URL or /artifacts/<hash> reference`,
    );
  }
  const response = await fetchGenerationReference(imageUrl);
  if (!response.ok) {
    throw new Error(
      `Could not validate ${optionName}: failed to fetch image (HTTP ${response.status})`,
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const dimensions = readImageDimensions(buffer);
  if (!dimensions) {
    throw new Error(
      `Could not validate ${optionName}: unsupported image format or missing dimensions`,
    );
  }
  return dimensions;
}

async function validateFrameImageAspectRatio(
  optionName: string,
  imageUrl: string | undefined,
  aspectRatio: string,
): Promise<void> {
  if (!imageUrl) {
    return;
  }

  const expected = parseAspectRatio(aspectRatio);
  const actual = await fetchImageDimensions(optionName, imageUrl);
  if (hasMatchingAspectRatio(actual, expected)) {
    return;
  }

  throw new Error(
    `${optionName} has aspect ratio ${formatDimensionsAsRatio(actual)} (${actual.width}x${actual.height}), but --aspect-ratio is ${aspectRatio}. Use --aspect-ratio ${formatDimensionsAsRatio(actual)} or provide a frame image with ${aspectRatio} dimensions.`,
  );
}

async function validateVideoOptions(options: VideoOptions): Promise<void> {
  const model = options.model?.toLowerCase();
  if (model !== undefined && ["minimax-h3", "h3"].includes(model)) {
    return;
  }
  await Promise.all([
    validateFrameImageAspectRatio(
      "--first-frame-image-url",
      options.firstFrameImageUrl,
      options.aspectRatio,
    ),
    validateFrameImageAspectRatio(
      "--last-frame-image-url",
      options.lastFrameImageUrl,
      options.aspectRatio,
    ),
  ]);
}

function formatOptionalVideoParameter(
  value: string | number | undefined,
  fallback = "none",
): string {
  return `${value ?? fallback}`;
}

function formatVideoUrlList(values: readonly string[] | undefined): string {
  const list = values ?? [];
  if (list.length === 0) {
    return "none";
  }
  return list.join(", ");
}

function formatVideoToggle(enabled: boolean): string {
  return enabled ? "on" : "off";
}

function createVideoTemplateDetails(options: VideoOptions): readonly string[] {
  return [
    `Model preference if direct video generation is used: ${formatOptionalVideoParameter(
      options.model,
      "provider default",
    )}`,
    `Requested aspect ratio: ${options.aspectRatio}`,
    `Requested duration: ${options.duration}`,
    `Requested resolution: ${formatOptionalVideoParameter(
      options.resolution,
      "provider default",
    )}`,
    `Requested audio: ${formatVideoToggle(options.audio !== false)}`,
    `Requested negative prompt: ${formatOptionalVideoParameter(
      options.negativePrompt,
    )}`,
    `Requested seed: ${formatOptionalVideoParameter(options.seed)}`,
    `Prompt auto-fix: ${formatVideoToggle(options.autoFix !== false)}`,
    `Safety tolerance: ${options.safetyTolerance}`,
    `Reference image URLs: ${formatVideoUrlList(options.imageUrl)}`,
    `Reference video URLs: ${formatVideoUrlList(options.videoUrl)}`,
    `Reference audio URLs: ${formatVideoUrlList(options.audioUrl)}`,
    `First frame image URL: ${formatOptionalVideoParameter(
      options.firstFrameImageUrl,
    )}`,
    `Last frame image URL: ${formatOptionalVideoParameter(
      options.lastFrameImageUrl,
    )}`,
  ];
}

export function createVideoGenerateCommand(
  config: VideoGenerateCommandConfig,
): Command {
  return new Command()
    .name(config.name)
    .description("Generate a billed video file from a prompt")
    .option("--prompt <text>", "Video prompt; can also be piped via stdin")
    .option(
      "--provider <name>",
      "Provider: 'built-in' to run Okou's pipeline, or a connector name to get its skill-invocation guidance",
    )
    .option("--template <id>", "Registered video template id")
    .option(
      "--all",
      "When listing providers (no --prompt given), include unavailable or not-yet-authorized connectors",
    )
    .option("--json", "Print the complete generation result as JSON")
    .addOption(createArtifactVisibilityOption())
    .option(
      "--model <model>",
      "Model: dreamina-seedance-2.0-fast, dreamina-seedance-2.5, dreamina-seedance-2.0, dreamina-seedance-2.0-mini, seedance-1.5-pro, minimax-h3, veo3.1-fast, or kling-v3-4k. Do not pass this unless the user named a model",
    )
    .option(
      "--aspect-ratio <ratio>",
      "Aspect ratio: 21:9, 16:9, 4:3, 1:1, 3:4, or 9:16",
      "16:9",
    )
    .option(
      "--duration <duration>",
      "Duration: 2s-30s depending on model",
      "8s",
    )
    .option(
      "--resolution <resolution>",
      "Resolution: 480p, 720p, 768p, 1080p, 2k, or 4k depending on model",
    )
    .option("--no-audio", "Generate a silent video (unsupported by MiniMax H3)")
    .option("--negative-prompt <text>", "Negative prompt")
    .option("--seed <integer>", "Deterministic seed", parseSeed)
    .option("--no-auto-fix", "Disable prompt auto-fix")
    .option("--safety-tolerance <level>", "Safety tolerance", "4")
    .option(
      "--image-url <url>",
      "Reference image URL; repeat for models that support multiple references",
      collectUrl,
      [],
    )
    .option(
      "--video-url <url>",
      "Reference video URL; repeat up to 10 times depending on model",
      collectUrl,
      [],
    )
    .option(
      "--audio-url <url>",
      "Reference audio URL; repeat up to 10 times depending on model",
      collectUrl,
      [],
    )
    .option("--first-frame-image-url <url>", "First frame image URL")
    .option("--last-frame-image-url <url>", "Last frame image URL")
    .addHelpText(
      "after",
      `
Examples:
${config.examples}

Output:
  Prints the generated /f/ video file URL and metadata. Use --json for the
  complete result object.

  Successful results include inline-link and rich-preview Markdown guidance.
  --json includes inlineMarkdownLink, previewMarkdownBlock, and artifactPresentationContext.

Notes:
  - Authenticates via OKOU_TOKEN (requires file:write capability)
  - Charges org credits after successful video generation
  - Uses MiniMax, BytePlus ModelArk, and fal.ai video models with configured usage pricing
  - Omitting --model generates with ${DEFAULT_VIDEO_MODEL_ALIAS}
  - BytePlus/Seedance: first/last frame inputs cannot be combined with
    reference image/video/audio inputs. Choose one input mode before generating.

Models:
  - Dreamina Seedance 2.5: dreamina-seedance-2.5. Supports 4s-30s,
    480p/720p/1080p, optional audio, up to 30 image references, and up to
    10 video and 10 audio references, or first/last frames.
  - Dreamina Seedance 2.0: dreamina-seedance-2.0,
    dreamina-seedance-2.0-fast, dreamina-seedance-2.0-mini.
    Supports 4s-15s,
    480p/720p, seed, optional audio, image references, and first/last
    frames. The full model also supports 1080p; the full and Mini models
    support video/audio references.
  - Seedance 1.5 Pro: seedance-1.5-pro. Supports 4s-12s,
    480p/720p/1080p, seed, optional audio, image references, and
    first/last frames.
  - MiniMax H3: minimax-h3. Supports 4s-15s, 768p/2k, image/video/audio
    references, and first/last frames. H3 always generates native audio.
  - fal.ai: veo3.1-fast and kling-v3-4k. veo3.1-fast supports
    4s/6s/8s, 720p/1080p/4k, negative prompts, seed, auto-fix,
    safety tolerance, and optional audio. kling-v3-4k supports 3s-15s,
    4k output, negative prompts, and optional audio.`,
    )
    .action(
      withErrorHandler(async (options: VideoOptions) => {
        const dispatch = await dispatchGenerate({
          generationType: config.generationType,
          provider: options.provider,
          prompt: options.prompt,
          all: options.all,
          requireExecutionFor: options.visibility
            ? "--visibility"
            : options.json
              ? "--json"
              : undefined,
        });
        if (dispatch.outcome === "handled") return;
        const prompt = dispatch.prompt;

        if (options.template) {
          if (options.json) {
            throw new Error(
              "--json is only available for direct built-in generation",
            );
          }
          const template = findVideoTemplate(options.template);
          if (!template) {
            throw unknownTemplateError(options.template, config.usageCommand);
          }

          await prepareArtifactVisibility(options.visibility);
          const packet = createVideoTemplateAuthoringPacket({
            prompt,
            template,
            details: createVideoTemplateDetails(options),
            visibility: options.visibility,
          });

          console.log(packet.instructions);
          return;
        }

        await assertPaidToolEnabled("video-generation");
        if (currentTokenCanReadBilling()) {
          const billing = await getBillingStatus();
          if (!currentPlanAllowsVideo(billing)) {
            throw new ApiRequestError(
              "Built-in video generation requires Pro, Team, or Custom workspace access.",
              "PRO_REQUIRED",
              402,
            );
          }
        }

        await validateVideoOptions(options);
        const requirePrivateArtifact = await prepareArtifactVisibility(
          options.visibility,
        );
        const generated = await generateWebVideo({
          prompt,
          model: options.model,
          aspectRatio: options.aspectRatio,
          duration: options.duration,
          resolution: options.resolution,
          generateAudio: options.audio !== false,
          negativePrompt: options.negativePrompt,
          seed: options.seed,
          autoFix: options.autoFix !== false,
          safetyTolerance: options.safetyTolerance,
          imageUrls: options.imageUrl,
          videoUrls: options.videoUrl,
          audioUrls: options.audioUrl,
          firstFrameImageUrl: options.firstFrameImageUrl,
          lastFrameImageUrl: options.lastFrameImageUrl,
          requirePrivateArtifact,
        });
        const result = await applyArtifactVisibility(
          generated,
          { kind: "file", id: generated.id },
          options.visibility,
        );

        const presentation = createArtifactPresentation(
          result.filename,
          result.url,
          undefined,
          result,
        );
        if (options.json) {
          console.log(JSON.stringify({ ...result, ...presentation.json }));
          return;
        }

        console.log(chalk.green(`✓ Video generated: ${result.url}`));
        console.log(chalk.dim(`  File: ${result.filename}`));
        console.log(chalk.dim(`  Duration: ${result.duration}`));
        console.log(chalk.dim(`  Resolution: ${result.resolution}`));
        console.log(chalk.dim(`  Aspect ratio: ${result.aspectRatio}`));
        console.log(
          chalk.dim(`  Audio: ${result.generateAudio ? "on" : "off"}`),
        );
        console.log(chalk.dim(`  Credits charged: ${result.creditsCharged}`));
        console.log(chalk.dim(`  Model: ${result.model}`));
        console.log(`\n${presentation.text}`);
      }),
    );
}
