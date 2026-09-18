import { Command, InvalidArgumentError } from "commander";
import chalk from "chalk";

import { generateWebIntroVideoVoice } from "../lib/api/domains/web";
import { withErrorHandler } from "../lib/command/with-error-handler";
import { createArtifactPresentation } from "./shared/artifact-return";

interface IntroVideoVoiceCommandOptions {
  readonly voiceId: string;
  readonly text: string;
  readonly json?: boolean;
}

function parseVoiceId(value: string): string {
  const parsed = value.trim();
  if (!/^[A-Za-z0-9._:-]+$/.test(parsed)) {
    throw new InvalidArgumentError("voice id contains unsupported characters");
  }
  return parsed;
}

function parseNarration(value: string): string {
  const parsed = value.trim();
  if (!parsed) {
    throw new InvalidArgumentError("narration text cannot be empty");
  }
  if (parsed.length > 5_000) {
    throw new InvalidArgumentError(
      "narration text cannot exceed 5,000 characters",
    );
  }
  return parsed;
}

async function runIntroVideoVoiceCommand(
  options: IntroVideoVoiceCommandOptions,
): Promise<void> {
  const result = await generateWebIntroVideoVoice({
    voiceId: options.voiceId,
    text: options.text,
  });
  const presentation = createArtifactPresentation(
    result.filename,
    result.url,
    "This result is narration audio that can be used in subsequent video composition.",
    result,
  );
  if (options.json) {
    console.log(JSON.stringify({ ...result, ...presentation.json }));
    return;
  }
  console.log(chalk.green(`✓ Intro Video narration generated: ${result.url}`));
  console.log(chalk.dim(`  File: ${result.filename}`));
  console.log(chalk.dim(`  Duration: ${result.durationSeconds}s`));
  console.log(chalk.dim(`  Voice: ${result.voiceId}`));
  console.log(chalk.dim(`  Credits charged: ${result.creditsCharged}`));
  console.log(`\n${presentation.text}`);
}

export const introVideoVoiceCommand = new Command()
  .name("__intro-video-voice")
  .description("Internal Intro Video HeyGen narration renderer")
  .requiredOption("--voice-id <id>", "Selected HeyGen voice ID", parseVoiceId)
  .requiredOption("--text <text>", "Final narration script", parseNarration)
  .option("--json", "Print the internal narration result as JSON")
  .action(withErrorHandler(runIntroVideoVoiceCommand));
