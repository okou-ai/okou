import { Command, InvalidArgumentError } from "commander";
import chalk from "chalk";

import { ApiRequestError } from "../../lib/api/core/client-factory";
import {
  generateWebAvatarVideo,
  listWebAvatarVideoAvatars,
  listWebAvatarVideoVoices,
} from "../../lib/api/domains/web";
import { getBillingStatus } from "../../lib/api/domains/billing";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { createArtifactPresentation } from "../shared/artifact-return";
import {
  applyArtifactVisibility,
  createArtifactVisibilityOption,
  prepareArtifactVisibility,
  type ArtifactVisibility,
} from "../shared/artifact-visibility";
import {
  currentPlanAllowsVideo,
  currentTokenCanReadBilling,
} from "../shared/billing-capabilities";
import { dispatchGenerate } from "./lib/dispatch";

type AspectRatio = "portrait" | "landscape" | "square";
type Gender = "female" | "male";
type AvatarStyle = "professional" | "social";
type AvatarAge = "adult" | "senior" | "young_adult";
type AvatarScene =
  | "lifestyle"
  | "outdoors"
  | "business"
  | "studio"
  | "health_fitness"
  | "education"
  | "news";
type AvatarEthnicity =
  | "european"
  | "african"
  | "south_asian"
  | "east_asian"
  | "middle_eastern"
  | "south_american"
  | "north_american";
type VoiceAge = "young" | "middle_aged" | "old";

interface AvatarVideoCommandOptions {
  readonly script?: string;
  readonly audioUrl?: string;
  readonly avatarId?: number;
  readonly voiceId?: string;
  readonly aspectRatio?: AspectRatio;
  readonly screenStyle: 1 | 2 | 3;
  readonly caption: boolean;
  readonly videoName?: string;
  readonly listAvatars?: boolean;
  readonly listVoices?: boolean;
  readonly page: number;
  readonly pageSize: number;
  readonly avatarStyle?: AvatarStyle;
  readonly avatarGender?: Gender;
  readonly avatarAge?: AvatarAge;
  readonly avatarScene?: AvatarScene;
  readonly avatarEthnicity?: AvatarEthnicity;
  readonly voiceLanguage?: string;
  readonly voiceGender?: Gender;
  readonly voiceAge?: VoiceAge;
  readonly voiceUseCase?: string;
  readonly provider?: string;
  readonly all?: boolean;
  readonly json?: boolean;
  readonly visibility?: ArtifactVisibility;
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseAvatarId(value: string): number {
  return parsePositiveInteger(value, "avatar id");
}

function parsePage(value: string): number {
  return parsePositiveInteger(value, "page");
}

function parsePageSize(value: string): number {
  const parsed = parsePositiveInteger(value, "page size");
  if (parsed > 100) {
    throw new InvalidArgumentError("page size must be at most 100");
  }
  return parsed;
}

function parseScreenStyle(value: string): 1 | 2 | 3 {
  const parsed = Number(value);
  if (parsed === 1 || parsed === 2 || parsed === 3) {
    return parsed;
  }
  throw new InvalidArgumentError("screen style must be 1, 2, or 3");
}

function parseChoice<T extends string>(
  value: string,
  choices: readonly T[],
  name: string,
): T {
  const match = choices.find((choice) => {
    return choice === value;
  });
  if (!match) {
    throw new InvalidArgumentError(
      `${name} must be one of: ${choices.join(", ")}`,
    );
  }
  return match;
}

function parseAspectRatio(value: string): AspectRatio {
  return parseChoice(
    value,
    ["portrait", "landscape", "square"],
    "aspect ratio",
  );
}

function parseGender(value: string): Gender {
  return parseChoice(value, ["female", "male"], "gender");
}

function parseAvatarStyle(value: string): AvatarStyle {
  return parseChoice(value, ["professional", "social"], "avatar style");
}

function parseAvatarAge(value: string): AvatarAge {
  return parseChoice(value, ["adult", "senior", "young_adult"], "avatar age");
}

function parseAvatarScene(value: string): AvatarScene {
  return parseChoice(
    value,
    [
      "lifestyle",
      "outdoors",
      "business",
      "studio",
      "health_fitness",
      "education",
      "news",
    ],
    "avatar scene",
  );
}

function parseAvatarEthnicity(value: string): AvatarEthnicity {
  return parseChoice(
    value,
    [
      "european",
      "african",
      "south_asian",
      "east_asian",
      "middle_eastern",
      "south_american",
      "north_american",
    ],
    "avatar ethnicity",
  );
}

function parseVoiceAge(value: string): VoiceAge {
  return parseChoice(value, ["young", "middle_aged", "old"], "voice age");
}

function hasAvatarFilters(options: AvatarVideoCommandOptions): boolean {
  return Boolean(
    options.avatarStyle ||
    options.avatarGender ||
    options.avatarAge ||
    options.avatarScene ||
    options.avatarEthnicity,
  );
}

function hasVoiceFilters(options: AvatarVideoCommandOptions): boolean {
  return Boolean(
    options.voiceLanguage ||
    options.voiceGender ||
    options.voiceAge ||
    options.voiceUseCase,
  );
}

function hasGenerationInput(options: AvatarVideoCommandOptions): boolean {
  return Boolean(
    options.script ||
    options.audioUrl ||
    options.avatarId ||
    options.voiceId ||
    options.videoName,
  );
}

async function listAvatars(options: AvatarVideoCommandOptions): Promise<void> {
  if (hasVoiceFilters(options)) {
    throw new Error("Voice filters can only be used with --list-voices");
  }
  const result = await listWebAvatarVideoAvatars({
    page: options.page,
    pageSize: options.pageSize,
    aspectRatio: options.aspectRatio,
    style: options.avatarStyle,
    gender: options.avatarGender,
    age: options.avatarAge,
    scene: options.avatarScene,
    ethnicity: options.avatarEthnicity,
  });
  if (options.json) {
    console.log(JSON.stringify(result));
    return;
  }
  console.log("Public JoggAI avatars");
  if (result.avatars.length === 0) {
    console.log("  No avatars matched the selected filters.");
    return;
  }
  for (const avatar of result.avatars) {
    const details = [avatar.style, avatar.gender, avatar.age]
      .filter(Boolean)
      .join(", ");
    console.log(
      `  ${avatar.id}  ${avatar.name}${details ? `  ${details}` : ""}`,
    );
    if (avatar.coverUrl) {
      console.log(chalk.dim(`    Preview: ${avatar.coverUrl}`));
    }
  }
}

async function listVoices(options: AvatarVideoCommandOptions): Promise<void> {
  if (hasAvatarFilters(options)) {
    throw new Error("Avatar filters can only be used with --list-avatars");
  }
  const result = await listWebAvatarVideoVoices({
    page: options.page,
    pageSize: options.pageSize,
    language: options.voiceLanguage,
    gender: options.voiceGender,
    age: options.voiceAge,
    useCase: options.voiceUseCase,
  });
  if (options.json) {
    console.log(JSON.stringify(result));
    return;
  }
  console.log("Public JoggAI voices");
  if (result.voices.length === 0) {
    console.log("  No voices matched the selected filters.");
    return;
  }
  for (const voice of result.voices) {
    const details = [voice.language, voice.gender, voice.age, voice.accent]
      .filter(Boolean)
      .join(", ");
    console.log(`  ${voice.id}  ${voice.name}${details ? `  ${details}` : ""}`);
    if (voice.sampleUrl) {
      console.log(chalk.dim(`    Sample: ${voice.sampleUrl}`));
    }
  }
  if (result.hasMore) {
    console.log(
      chalk.dim("  More voices are available; use --page to continue."),
    );
  }
}

async function ensureVideoPlan(): Promise<void> {
  if (!currentTokenCanReadBilling()) {
    return;
  }
  const billing = await getBillingStatus();
  if (!currentPlanAllowsVideo(billing)) {
    throw new ApiRequestError(
      "Built-in avatar video generation requires Pro, Team, or Custom workspace access.",
      "PRO_REQUIRED",
      402,
    );
  }
}

function validateCommandModes(options: AvatarVideoCommandOptions): void {
  if (options.listAvatars && options.listVoices) {
    throw new Error("Use only one of --list-avatars and --list-voices");
  }
  if (options.script && options.audioUrl) {
    throw new Error("Use exactly one of --script and --audio-url");
  }

  const listingResources = options.listAvatars || options.listVoices;
  if (listingResources && options.visibility) {
    throw new Error(
      "--visibility is only available for direct built-in generation",
    );
  }
  if (listingResources && hasGenerationInput(options)) {
    throw new Error(
      "Resource listing flags cannot be combined with generation options",
    );
  }
  if (!options.listAvatars && hasAvatarFilters(options)) {
    throw new Error("Avatar filters require --list-avatars");
  }
  if (!options.listVoices && hasVoiceFilters(options)) {
    throw new Error("Voice filters require --list-voices");
  }
}

type DispatchResolution =
  | { readonly outcome: "handled" }
  | { readonly outcome: "continue"; readonly script: string | undefined };

async function resolveCommandDispatch(
  options: AvatarVideoCommandOptions,
): Promise<DispatchResolution> {
  const listingResources = options.listAvatars || options.listVoices;
  const builtInResourceListing =
    listingResources && (!options.provider || options.provider === "built-in");
  if (builtInResourceListing) {
    return { outcome: "continue", script: options.script };
  }

  const dispatch = await dispatchGenerate({
    generationType: "avatar-video",
    provider: options.provider,
    prompt: options.audioUrl
      ? "Generate from the supplied audio URL"
      : options.script,
    all: options.all,
    requireExecutionFor: options.visibility
      ? "--visibility"
      : options.json
        ? "--json"
        : undefined,
  });
  if (dispatch.outcome === "handled") {
    return { outcome: "handled" };
  }
  return {
    outcome: "continue",
    script: options.audioUrl ? undefined : dispatch.prompt,
  };
}

async function handleResourceListing(
  options: AvatarVideoCommandOptions,
): Promise<boolean> {
  if (options.listAvatars) {
    await listAvatars(options);
    return true;
  }
  if (options.listVoices) {
    await listVoices(options);
    return true;
  }
  return false;
}

function printAvatarVideoResult(
  result: Awaited<ReturnType<typeof generateWebAvatarVideo>>,
  json: boolean,
): void {
  const presentation = createArtifactPresentation(result.filename, result.url);
  if (json) {
    console.log(JSON.stringify({ ...result, ...presentation.json }));
    return;
  }
  console.log(chalk.green(`✓ Avatar video generated: ${result.url}`));
  console.log(chalk.dim(`  File: ${result.filename}`));
  console.log(chalk.dim(`  Duration: ${result.durationSeconds}s`));
  console.log(chalk.dim(`  Aspect ratio: ${result.aspectRatio}`));
  console.log(chalk.dim(`  Avatar: ${result.avatarId}`));
  console.log(chalk.dim(`  Voice: ${result.voiceId}`));
  console.log(chalk.dim(`  Credits charged: ${result.creditsCharged}`));
  console.log(`\n${presentation.text}`);
}

async function generateAvatarVideo(
  options: AvatarVideoCommandOptions,
  script: string | undefined,
): Promise<void> {
  if (!script && !options.audioUrl) {
    return;
  }
  if (!options.avatarId) {
    throw new Error(
      "--avatar-id is required; use --list-avatars to discover IDs",
    );
  }
  const voiceId = options.voiceId?.trim();
  if (!voiceId) {
    throw new Error(
      "--voice-id is required; use --list-voices to discover IDs",
    );
  }

  await ensureVideoPlan();
  const requirePrivateArtifact = await prepareArtifactVisibility(
    options.visibility,
  );
  const generated = await generateWebAvatarVideo({
    avatarId: options.avatarId,
    voiceId,
    ...(script ? { script } : {}),
    ...(options.audioUrl ? { audioUrl: options.audioUrl } : {}),
    aspectRatio: options.aspectRatio ?? "portrait",
    screenStyle: options.screenStyle,
    caption: options.caption,
    ...(options.videoName ? { videoName: options.videoName } : {}),
    requirePrivateArtifact,
  });
  const result = await applyArtifactVisibility(
    generated,
    { kind: "file", id: generated.id },
    options.visibility,
  );
  printAvatarVideoResult(result, options.json === true);
}

async function runAvatarVideoCommand(
  options: AvatarVideoCommandOptions,
): Promise<void> {
  validateCommandModes(options);
  const dispatch = await resolveCommandDispatch(options);
  if (dispatch.outcome === "handled") {
    return;
  }
  if (await handleResourceListing(options)) {
    return;
  }
  await generateAvatarVideo(options, dispatch.script);
}

export const avatarVideoCommand = new Command()
  .name("avatar-video")
  .description("Generate a billed JoggAI talking-avatar video")
  .option("--script <text>", "Speech script; can also be piped via stdin")
  .option("--audio-url <url>", "Public audio URL to drive the avatar")
  .option("--avatar-id <id>", "Public JoggAI avatar ID", parseAvatarId)
  .option("--voice-id <id>", "JoggAI voice ID")
  .option(
    "--aspect-ratio <ratio>",
    "Output ratio: portrait, landscape, or square",
    parseAspectRatio,
  )
  .option(
    "--screen-style <style>",
    "Background: 1 scene, 2 green screen, or 3 transparent WebM (alpha)",
    parseScreenStyle,
    1,
  )
  .option("--no-caption", "Disable generated captions")
  .option("--video-name <name>", "Name the video in JoggAI")
  .option("--list-avatars", "List public JoggAI avatars")
  .option("--list-voices", "List public JoggAI voices")
  .option("--page <number>", "Discovery page", parsePage, 1)
  .option(
    "--page-size <number>",
    "Discovery page size (1-100)",
    parsePageSize,
    10,
  )
  .option("--avatar-style <style>", "professional or social", parseAvatarStyle)
  .option("--avatar-gender <gender>", "female or male", parseGender)
  .option("--avatar-age <age>", "adult, senior, or young_adult", parseAvatarAge)
  .option("--avatar-scene <scene>", "Avatar scene filter", parseAvatarScene)
  .option(
    "--avatar-ethnicity <ethnicity>",
    "Avatar ethnicity filter",
    parseAvatarEthnicity,
  )
  .option("--voice-language <language>", "Voice language filter")
  .option("--voice-gender <gender>", "female or male", parseGender)
  .option("--voice-age <age>", "young, middle_aged, or old", parseVoiceAge)
  .option("--voice-use-case <use-case>", "Voice use-case filter")
  .option(
    "--provider <name>",
    "Provider: 'built-in' to use Okou credits, or a connector name for skill guidance",
  )
  .option(
    "--all",
    "When listing providers, include unavailable or unauthorized connectors",
  )
  .option("--json", "Print resource lists or the generation result as JSON")
  .addOption(createArtifactVisibilityOption())
  .addHelpText(
    "after",
    `
Examples:
  List provider choices: okou generate avatar-video
  Generate from audio:   okou generate avatar-video --provider built-in --avatar-id 81 --voice-id en-US-ChristopherNeural --audio-url https://example.com/voice.mp3
  Pipe a script:         cat script.txt | okou generate avatar-video --provider built-in --avatar-id 81 --voice-id en-US-ChristopherNeural

Built-in workflow (Okou credits):
  1. okou generate avatar-video --provider built-in --list-avatars
  2. okou generate avatar-video --provider built-in --list-voices --voice-language english
  3. okou generate avatar-video --provider built-in --avatar-id 81 --voice-id en-US-ChristopherNeural --script "Welcome to Okou"

JoggAI connector workflow (BYOK):
  1. okou connector status joggai
  2. okou generate avatar-video --provider joggai
     Follow the printed JoggAI skill guidance for direct provider operations.

Output:
  Prints the generated /f/ video URL and metadata. Use --json for a complete,
  machine-readable resource list or generation result.

Notes:
  - Run the command with no script/audio to reflect built-in and connector choices.
  - Use exactly one of --script (or piped stdin) and --audio-url.
  - Public avatar and voice IDs are discoverable with the list flags.
  - Built-in generation uses Okou-managed JoggAI credentials and charges org credits.
  - Connector generation uses the connected JoggAI account and provider credits.
  - After starting built-in generation, wait for the command to finish and use its returned artifact; do not launch a duplicate because polling takes time.
  - Authenticates via OKOU_TOKEN and requires file:write capability.`,
  )
  .action(withErrorHandler(runAvatarVideoCommand));
