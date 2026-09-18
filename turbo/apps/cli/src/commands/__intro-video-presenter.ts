import { Command, InvalidArgumentError } from "commander";
import chalk from "chalk";

import { generateWebIntroVideoPresenter } from "../lib/api/domains/web";
import { withErrorHandler } from "../lib/command/with-error-handler";
import { assertPaidToolEnabled } from "../lib/command/paid-tools";
import { createArtifactPresentation } from "./shared/artifact-return";

interface IntroVideoPresenterCommandOptions {
  readonly avatarId: string;
  readonly avatarGroupId?: string;
  readonly audioUrl: string;
  readonly videoName?: string;
  readonly json?: boolean;
}

function parseAvatarId(value: string): string {
  const parsed = value.trim();
  if (!/^[A-Za-z0-9._:-]+$/.test(parsed)) {
    throw new InvalidArgumentError("avatar id contains unsupported characters");
  }
  return parsed;
}

async function runIntroVideoPresenterCommand(
  options: IntroVideoPresenterCommandOptions,
): Promise<void> {
  await assertPaidToolEnabled("avatar-video-generation");
  const result = await generateWebIntroVideoPresenter({
    avatarId: options.avatarId,
    ...(options.avatarGroupId ? { avatarGroupId: options.avatarGroupId } : {}),
    audioUrl: options.audioUrl,
    ...(options.videoName ? { videoName: options.videoName } : {}),
  });
  const presentation = createArtifactPresentation(
    result.filename,
    result.url,
    "This result is a presenter clip that can be used in subsequent video composition.",
    result,
  );
  if (options.json) {
    console.log(JSON.stringify({ ...result, ...presentation.json }));
    return;
  }
  console.log(chalk.green(`✓ Intro Video presenter generated: ${result.url}`));
  console.log(chalk.dim(`  File: ${result.filename}`));
  console.log(chalk.dim(`  Duration: ${result.durationSeconds}s`));
  console.log(chalk.dim(`  Avatar: ${result.avatarId}`));
  console.log(chalk.dim(`  Credits charged: ${result.creditsCharged}`));
  console.log(`\n${presentation.text}`);
}

export const introVideoPresenterCommand = new Command()
  .name("__intro-video-presenter")
  .description("Internal Intro Video HeyGen presenter renderer")
  .requiredOption(
    "--avatar-id <id>",
    "Curated Intro Video avatar ID",
    parseAvatarId,
  )
  .option(
    "--avatar-group-id <id>",
    "Public HeyGen avatar group ID",
    parseAvatarId,
  )
  .requiredOption("--audio-url <url>", "Resolved narration or silent audio URL")
  .option("--video-name <name>", "Internal presenter take name")
  .option("--json", "Print the internal presenter result as JSON")
  .action(withErrorHandler(runIntroVideoPresenterCommand));
