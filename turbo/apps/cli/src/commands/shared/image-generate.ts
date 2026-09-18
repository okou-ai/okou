import { Command, InvalidArgumentError } from "commander";
import chalk from "chalk";
import { generateWebImage } from "../../lib/api/domains/web";
import { decodeSandboxTokenPayload } from "../../lib/api/sandbox-token";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { createArtifactPresentation } from "./artifact-return";
import {
  applyArtifactVisibility,
  createArtifactVisibilityOption,
  prepareArtifactVisibility,
  type ArtifactVisibility,
} from "./artifact-visibility";
import { createStyledImageCompilationPacket } from "./image-style-authoring";
import { runDefaultImageModelFromEnvironment } from "./run-default-image-model";
import {
  findImageStyle,
  listImageStyles,
} from "@okouai/core/resource-registry";
import {
  DEFAULT_IMAGE_MODEL,
  IMAGE_MODEL_CONFIGS,
} from "@okouai/core/image-model-catalog";
import { formatRegistryListing } from "./resource-listing";
import { dispatchGenerate } from "../generate/lib/dispatch";
import type { GenerationType } from "../generate/lib/lister";

interface ImageOptions {
  prompt?: string;
  compiledPrompt?: string;
  rawPrompt?: string;
  provider?: string;
  model: string;
  size: string;
  quality: string;
  background: string;
  format: string;
  compression?: string;
  moderation: string;
  seed?: number;
  safetyTolerance: string;
  enhancePrompt?: boolean;
  imageUrl: string[];
  maskImageUrl?: string;
  inputFidelity?: string;
  imagePromptStrength?: string;
  style?: string;
  styleSource: "github" | "r2";
  compile?: boolean;
  all?: boolean;
  json?: boolean;
  visibility?: ArtifactVisibility;
}

interface ImageGenerateCommandConfig {
  name: string;
  generationType: GenerationType;
  usageCommand: string;
  examples: string;
}

type ImagePromptMode = "compile" | "compiled" | "raw";

function requireImageModeError(usageCommand: string): Error {
  const styles = listImageStyles();
  const message = [
    "Choose one image prompt mode",
    "",
    "Modes:",
    `  Compile styled prompt: ${usageCommand} --style ${styles[0]?.id ?? "<style-id>"} --prompt "..." --compile`,
    `  Generate compiled prompt: ${usageCommand} --compiled-prompt "..."`,
    `  Generate raw prompt: ${usageCommand} --raw-prompt "..."`,
    "",
    "Available styles:",
    formatRegistryListing(styles, "image styles"),
  ].join("\n");
  return new Error(message);
}

function unknownStyleError(id: string, usageCommand: string): Error {
  const styles = listImageStyles();
  const message = [
    `Unknown image style: ${id}`,
    "",
    "Available styles:",
    formatRegistryListing(styles, "image styles"),
    "",
    `Example:`,
    `  ${usageCommand} --style ${styles[0]?.id ?? "<style-id>"} --prompt "..." --compile`,
  ].join("\n");
  return new Error(message);
}

function parseCompression(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const compression = Number(value);
  if (!Number.isInteger(compression) || compression < 0 || compression > 100) {
    throw new Error("--compression must be an integer from 0 to 100");
  }

  return compression;
}

function parseSeed(value: string): number {
  const seed = Number(value);
  if (!Number.isInteger(seed) || seed < 0 || !Number.isSafeInteger(seed)) {
    throw new InvalidArgumentError("seed must be a non-negative safe integer");
  }
  return seed;
}

function collectString(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseStyleSource(value: string): "github" | "r2" {
  if (value !== "github" && value !== "r2") {
    throw new InvalidArgumentError("style source must be github or r2");
  }
  return value;
}

function parseInputFidelity(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value !== "low" && value !== "high") {
    throw new Error("--input-fidelity must be low or high");
  }
  return value;
}

function parseImagePromptStrength(
  value: string | undefined,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const strength = Number(value);
  if (!Number.isFinite(strength) || strength < 0 || strength > 1) {
    throw new Error("--image-prompt-strength must be a number from 0 to 1");
  }
  return strength;
}

function resolvePromptInput(options: ImageOptions): string | undefined {
  return options.compiledPrompt ?? options.rawPrompt ?? options.prompt;
}

function resolveImageRequestModel(
  command: Command,
  model: string,
): string | undefined {
  const modelSource = command.getOptionValueSource("model");
  const hasRunDefault =
    runDefaultImageModelFromEnvironment() !== undefined ||
    decodeSandboxTokenPayload() !== undefined;
  return hasRunDefault && modelSource === "default" ? undefined : model;
}

function resolveImageRequestSize(
  command: Command,
  options: ImageOptions,
): string {
  if (command.getOptionValueSource("size") !== "default") {
    return options.size;
  }
  if (options.imageUrl.length > 0) {
    return "auto";
  }

  const selectedModel =
    command.getOptionValueSource("model") === "default"
      ? (runDefaultImageModelFromEnvironment() ?? options.model)
      : options.model;
  return selectedModel === IMAGE_MODEL_CONFIGS["seedream-5-0-lite-260128"].alias
    ? "auto"
    : options.size;
}

function imageModelPreferenceDetail(command: Command, model: string): string {
  const runDefaultModel = runDefaultImageModelFromEnvironment();
  if (runDefaultModel === undefined) {
    return `Model preference if direct image generation is used: ${model}`;
  }
  if (command.getOptionValueSource("model") === "default") {
    return `Run default model if direct image generation is used: ${runDefaultModel}; omit --model so the server applies it`;
  }
  return `Explicit model if direct image generation is used: ${model}`;
}

function hasImagePromptModeRequest(options: ImageOptions): boolean {
  return (
    options.style !== undefined ||
    options.compile === true ||
    options.prompt !== undefined ||
    options.compiledPrompt !== undefined ||
    options.rawPrompt !== undefined
  );
}

function imageExecutionOnlyOption(
  options: ImageOptions,
): "--visibility" | "--json" | undefined {
  if (options.visibility) {
    return "--visibility";
  }
  return options.json ? "--json" : undefined;
}

function resolveImagePromptMode(
  options: ImageOptions,
  usageCommand: string,
): ImagePromptMode {
  const hasCompiledPrompt = options.compiledPrompt !== undefined;
  const hasRawPrompt = options.rawPrompt !== undefined;
  const compile = options.compile === true;

  if (!compile && options.style) {
    throw new Error("--style can only be used with --compile");
  }
  if (!compile && options.styleSource !== "github") {
    throw new Error("--style-source can only be used with --compile");
  }

  if ([compile, hasCompiledPrompt, hasRawPrompt].filter(Boolean).length !== 1) {
    throw requireImageModeError(usageCommand);
  }

  if (compile && !options.style) {
    throw new Error("--compile requires --style <id>");
  }

  if (!compile && options.prompt !== undefined) {
    throw new Error(
      "--prompt can only be used with --style <id> --compile; use --compiled-prompt or --raw-prompt to generate",
    );
  }

  if (compile) {
    return "compile";
  }
  if (hasCompiledPrompt) {
    return "compiled";
  }
  return "raw";
}

export function createImageGenerateCommand(
  config: ImageGenerateCommandConfig,
): Command {
  return new Command()
    .name(config.name)
    .description("Generate a billed image file from a prompt")
    .option(
      "--prompt <text>",
      "User prompt to compile with --style and --compile; can also be piped via stdin",
    )
    .option(
      "--compiled-prompt <text>",
      "Final image prompt produced from a prompt-compilation packet",
    )
    .option(
      "--raw-prompt <text>",
      "Final image prompt for unstyled/model-native generation",
    )
    .option(
      "--provider <name>",
      "Provider: 'built-in' to run Okou's pipeline, or a connector name to get its skill-invocation guidance",
    )
    .option(
      "--all",
      "When listing providers (no --prompt given), include unavailable or not-yet-authorized connectors",
    )
    .option("--json", "Print the complete generation result as JSON")
    .addOption(createArtifactVisibilityOption())
    .option(
      "--model <model>",
      "Model: gpt-image-1 (default), gpt-image-2, gpt-image-2.5-flare, gpt-image-2.5-sunburst, flux-2-pro, ideogram-4, flux-pro-1.1, flux-pro-1.1-ultra, qwen-image, qwen-image-3, seedream4, seedream5-pro, seedream5-lite, nano-banana-2, or nano-banana-2-lite",
      IMAGE_MODEL_CONFIGS[DEFAULT_IMAGE_MODEL].alias,
    )
    .option(
      "--size <size>",
      "Image size: auto, WIDTHxHEIGHT, or a model-specific resolution preset; support varies by model",
      "1024x1024",
    )
    .option(
      "--quality <quality>",
      "Image quality: low, medium, high, or auto; GPT Image 2.5 also supports xhigh and max",
      "medium",
    )
    .option(
      "--background <background>",
      "Background: auto, opaque, or transparent when supported",
      "auto",
    )
    .option("--format <format>", "Output format: png, webp, or jpeg", "png")
    .option("--compression <0-100>", "Output compression for jpeg/webp only")
    .option(
      "--moderation <moderation>",
      "Moderation strictness: auto or low",
      "auto",
    )
    .option("--seed <integer>", "Deterministic seed when supported", parseSeed)
    .option("--safety-tolerance <level>", "fal safety tolerance: 1-6", "4")
    .option("--enhance-prompt", "Enable fal prompt enhancement when supported")
    .option(
      "--image-url <url>",
      "Source/mockup image URL for image-to-image; repeat for multi-image edit models",
      collectString,
      [],
    )
    .option(
      "--mask-image-url <url>",
      "Mask image URL for supported edit models",
    )
    .option(
      "--input-fidelity <low|high>",
      "Source-image fidelity for GPT edit models",
    )
    .option(
      "--image-prompt-strength <0-1>",
      "Reference strength override for Flux Redux",
    )
    .option(
      "--style <id>",
      "Image style id to compile from the registry (see Image Styles below)",
    )
    .option(
      "--style-source <source>",
      "Style package source for compile mode: github or r2",
      parseStyleSource,
      "github",
    )
    .option(
      "--compile",
      "Resolve the selected style and print a prompt-compilation packet",
    )
    .addHelpText("after", () => {
      const styles = listImageStyles();
      return `
Examples:
${config.examples}

Output:
  Prints the generated /f/ image file URL and metadata with --compiled-prompt
  or --raw-prompt. Use --json for the complete result object. With
  --style <id> --prompt "..." --compile, prints a prompt-compilation packet
  for the current agent.

  Successful results include inline-link and rich-preview Markdown guidance.
  --json includes inlineMarkdownLink, previewMarkdownBlock, and artifactPresentationContext.

Notes:
  - Authenticates via OKOU_TOKEN (requires file:write capability)
  - Charges org credits after successful image generation
  - Uses OpenAI, fal.ai, and BytePlus for built-in image model execution

Models:
  - OpenAI: gpt-image-2.5-flare and gpt-image-2.5-sunburst.
    GPT Image 2.5 generations bill the returned text input, image input,
    and image output tokens using configured model pricing.
  - fal.ai: gpt-image-1 (default), gpt-image-2, flux-2-pro, ideogram-4,
    flux-pro-1.1, flux-pro-1.1-ultra, qwen-image, qwen-image-3, seedream4,
    nano-banana-2, nano-banana-2-lite.
    GPT Image models bill by fal output image quality and size.
    Other fal generations bill by output image or rounded-up output
    megapixel, depending on the model. qwen-image-3 bills per output image
    in two resolution tiers, split at 2,250,000 output pixels. FLUX.2 Pro
    bills the first processed megapixel separately from additional input and
    output megapixels. Ideogram 4 maps low/medium/high quality to
    Turbo/Balanced/Quality output-megapixel pricing.
  - BytePlus: seedream5-pro and seedream5-lite.
    BytePlus generations bill the documented provider cost plus 25%, rounded
    up to whole credits after the request's output and reference costs are
    combined.

Options:
  - Prompt modes: choose exactly one mode. Use --style <id> --prompt "..."
    --compile to prepare a styled prompt-compilation packet, --compiled-prompt
    to generate from an agent-compiled prompt, or --raw-prompt to generate
    without a style. stdin is supported for --prompt in compile mode.
  - Size: GPT Image 2 and 2.5 accept auto or WIDTHxHEIGHT. Popular sizes include
    1024x1024,
    1536x1024, 1024x1536, 2048x2048, 2048x1152, 3840x2160,
    and 2160x3840. Custom sizes must have edges <= 3840px, both
    edges divisible by 16, long:short ratio <= 3:1, and total pixels
    between 655,360 and 8,294,400. gpt-image-1 uses auto, 1024x1024,
    1536x1024, or 1024x1536.
    seedream5-pro accepts 1K, 1.5K, 2K, auto, or supported custom sizes;
    seedream5-lite accepts 2K, 3K, 4K, auto, or supported custom sizes.
    qwen-image-3 and flux-2-pro accept at most 4,194,304 total pixels.
  - Quality: low, medium, high, or auto. Low is fastest for drafts.
    GPT Image 2.5 also accepts xhigh and max for more detailed output.
  - Background: auto, opaque, or transparent when supported. gpt-image-2,
    Flux, Qwen, and Seedream do not support transparent backgrounds.
    GPT Image 2.5 supports transparent backgrounds with png or webp.
  - Format: png, jpeg, or webp for GPT Image, Nano Banana 2, and qwen-image-3
    models; png or jpeg for other fal and BytePlus models.
  - fal-only controls: --seed and --safety-tolerance for supported fal models;
    --enhance-prompt for flux-pro-1.1. --compression and --moderation low are
    not supported on the fal-backed image path. Ideogram prompt expansion is
    disabled because Okou supplies the final prompt and expansion costs extra.
  - Image-to-image: pass --image-url to use the model's edit/reference path.
    GPT Image 2.5 accepts up to 16 source images and an optional mask.
    Nano Banana 2 models and Seedream 5 Lite accept up to 14 source images;
    Seedream 5 Pro accepts up to 10; flux-2-pro accepts up to 9;
    qwen-image-3 accepts up to 3. Flux Redux accepts --image-prompt-strength
    to override the provider default; GPT edit models accept --input-fidelity
    and supported models accept --mask-image-url.

Image Styles:
${formatRegistryListing(styles, "image styles")}`;
    })
    .action(
      withErrorHandler(async (options: ImageOptions, command: Command) => {
        const dispatch = await dispatchGenerate({
          generationType: config.generationType,
          provider: options.provider,
          prompt: resolvePromptInput(options),
          all: options.all,
          listOnMissingPrompt: !hasImagePromptModeRequest(options),
          missingPromptError:
            options.compile || options.style
              ? "--compile requires --prompt <text> or piped stdin"
              : undefined,
          requireExecutionFor: imageExecutionOnlyOption(options),
        });
        if (dispatch.outcome === "handled") return;
        const resolvedPrompt = dispatch.prompt;
        const mode = resolveImagePromptMode(options, config.usageCommand);

        if (mode === "compile") {
          if (options.visibility) {
            throw new Error(
              "--visibility is only available for direct built-in generation; pass it with --compiled-prompt or --raw-prompt",
            );
          }
          if (options.json) {
            throw new Error(
              "--json is only available for direct built-in generation",
            );
          }
          const styleId = options.style;
          if (!styleId) {
            throw new Error("--compile requires --style <id>");
          }
          const style = findImageStyle(styleId);
          if (!style) {
            throw unknownStyleError(styleId, config.usageCommand);
          }

          const packet = createStyledImageCompilationPacket({
            prompt: resolvedPrompt,
            style,
            sourceMode: options.styleSource,
            details: [
              imageModelPreferenceDetail(command, options.model),
              `Requested size: ${options.size}`,
              `Requested quality: ${options.quality}`,
              `Requested background: ${options.background}`,
              `Requested format: ${options.format}`,
              `Source image URLs: ${
                options.imageUrl.length > 0
                  ? options.imageUrl.join(", ")
                  : "none"
              }`,
              `Mask image URL: ${options.maskImageUrl ?? "none"}`,
            ],
          });

          console.log(packet.instructions);
          return;
        }

        const compression = parseCompression(options.compression);
        const inputFidelity = parseInputFidelity(options.inputFidelity);
        const imagePromptStrength = parseImagePromptStrength(
          options.imagePromptStrength,
        );
        const requirePrivateArtifact = await prepareArtifactVisibility(
          options.visibility,
        );
        const generated = await generateWebImage({
          prompt: resolvedPrompt,
          model: resolveImageRequestModel(command, options.model),
          size: resolveImageRequestSize(command, options),
          quality: options.quality,
          background: options.background,
          outputFormat: options.format,
          outputCompression: compression,
          moderation: options.moderation,
          seed: options.seed,
          safetyTolerance: options.safetyTolerance,
          enhancePrompt: options.enhancePrompt,
          imageUrls: options.imageUrl,
          maskImageUrl: options.maskImageUrl,
          inputFidelity,
          imagePromptStrength,
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
          result.embedUrl !== undefined && result.embedUrl !== result.url
            ? `${result.url} is the artifact reference for chat. ${result.embedUrl} is for embedding the image in authored HTML.`
            : undefined,
          result,
        );
        if (options.json) {
          console.log(JSON.stringify({ ...result, ...presentation.json }));
          return;
        }

        console.log(chalk.green(`✓ Image generated: ${result.url}`));
        if (result.embedUrl !== undefined && result.embedUrl !== result.url) {
          console.log(
            chalk.green(`  Embed this URL in HTML: ${result.embedUrl}`),
          );
        }
        console.log(chalk.dim(`  File: ${result.filename}`));
        console.log(chalk.dim(`  Size: ${result.imageSize}`));
        console.log(chalk.dim(`  Quality: ${result.quality}`));
        console.log(chalk.dim(`  Format: ${result.outputFormat}`));
        if (result.outputCompression !== undefined) {
          console.log(chalk.dim(`  Compression: ${result.outputCompression}`));
        }
        if (result.moderation) {
          console.log(chalk.dim(`  Moderation: ${result.moderation}`));
        }
        if (result.safetyTolerance) {
          console.log(
            chalk.dim(`  Safety tolerance: ${result.safetyTolerance}`),
          );
        }
        if (result.seed !== undefined) {
          console.log(chalk.dim(`  Seed: ${result.seed}`));
        }
        console.log(chalk.dim(`  Credits charged: ${result.creditsCharged}`));
        console.log(chalk.dim(`  Model: ${result.model}`));
        console.log(chalk.dim(`  Provider: ${result.provider}`));
        console.log(`\n${presentation.text}`);
      }),
    );
}
