import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Command, InvalidArgumentError, Option } from "commander";
import chalk from "chalk";
import {
  introVideoAgentGenerateRequestSchema,
  type IntroVideoAgentResponse,
} from "@okouai/api-contracts/contracts/intro-video-agent";

import {
  generateWebIntroVideoAgent,
  getWebIntroVideoAgent,
} from "../lib/api/domains/web";
import { withErrorHandler } from "../lib/command/with-error-handler";
import { createArtifactPresentation } from "./shared/artifact-return";

interface IntroVideoAgentCommandOptions {
  readonly prompt?: string;
  readonly promptFile?: string;
  readonly styleId?: string;
  readonly avatarId?: string;
  readonly avatarGroupId?: string;
  readonly voiceId?: string;
  readonly orientation?: "landscape" | "portrait";
  readonly fileUrl?: string[];
  readonly requestId?: string;
  readonly json?: boolean;
}

function parseRequestId(value: string): string {
  const parsed =
    introVideoAgentGenerateRequestSchema.shape.requestId.safeParse(value);
  if (!parsed.success) {
    throw new InvalidArgumentError("request or generation ID must be a UUID");
  }
  return parsed.data;
}

function collectFileUrl(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function resumeCommand(generationId: string): string {
  return `okou __intro-video-agent status ${generationId} --json`;
}

function printResult(result: IntroVideoAgentResponse, json?: boolean): void {
  const presentation =
    result.status === "completed" && result.url
      ? createArtifactPresentation(
          result.filename ?? "Intro video",
          result.url,
          undefined,
          result,
        )
      : undefined;
  const continuation =
    result.status === "queued" || result.status === "running"
      ? {
          resumeCommand: resumeCommand(result.generationId),
          continuationContext:
            "This job is still running. Check its status using resumeCommand; do not submit another video. Artifact presentation fields become available after completion.",
        }
      : undefined;
  if (json) {
    console.log(
      JSON.stringify({ ...result, ...presentation?.json, ...continuation }),
    );
    return;
  }
  console.log(`Intro Video Agent: ${result.status}`);
  console.log(chalk.dim(`  Generation ID: ${result.generationId}`));
  if (result.providerStatus) {
    console.log(chalk.dim(`  Provider status: ${result.providerStatus}`));
  }
  if (result.notice) {
    console.log(result.notice);
  }
  if (result.error) {
    console.log(chalk.red(`  ${result.error.message}`));
  }
  if (result.status === "completed" && result.url) {
    console.log(chalk.green(`✓ Intro Video generated: ${result.url}`));
    if (result.creditsCharged !== undefined) {
      console.log(chalk.dim(`  Credits charged: ${result.creditsCharged}`));
    }
  } else if (result.status === "queued" || result.status === "running") {
    console.log(
      chalk.dim(`  Check status: ${resumeCommand(result.generationId)}`),
    );
    console.log(
      chalk.dim("  Continue checking this job; do not submit another video."),
    );
  }
  if (presentation) {
    console.log(`\n${presentation.text}`);
  }
}

async function runIntroVideoAgentCommand(
  options: IntroVideoAgentCommandOptions,
): Promise<void> {
  if (options.prompt === undefined && options.promptFile === undefined) {
    throw new Error("Provide --prompt or --prompt-file.");
  }
  if (options.prompt !== undefined && options.promptFile !== undefined) {
    throw new Error("Use exactly one of --prompt or --prompt-file.");
  }
  if (!options.styleId) {
    throw new Error(
      "--style-id is required. Resolve a concrete style from the live Intro Video catalog first, including for Auto.",
    );
  }
  if (!options.orientation) {
    throw new Error("--orientation is required: landscape or portrait.");
  }
  const requestId = options.requestId ?? randomUUID();
  const parsed = introVideoAgentGenerateRequestSchema.safeParse({
    requestId,
    prompt: options.promptFile
      ? await readFile(options.promptFile, "utf8")
      : options.prompt,
    styleId: options.styleId,
    avatarId: options.avatarId,
    avatarGroupId: options.avatarGroupId,
    voiceId: options.voiceId,
    orientation: options.orientation,
    fileUrls: options.fileUrl,
  });
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues
        .map((issue) => {
          return `${issue.path.join(".")}: ${issue.message}`;
        })
        .join("; "),
    );
  }
  if (!options.json) {
    console.log(`Request ID: ${requestId}`);
    console.log(chalk.dim(`  Resume: ${resumeCommand(requestId)}`));
  } else {
    // Preserve the recovery key even if this process exits before a response.
    // Keep stdout reserved for the single JSON result.
    console.error(
      `Request ID: ${requestId}\nResume: ${resumeCommand(requestId)}`,
    );
  }
  let result: IntroVideoAgentResponse;
  try {
    result = await generateWebIntroVideoAgent(parsed.data);
  } catch (error) {
    const notice =
      "Submission was not confirmed. Check this generation ID before retrying. Reuse the same --request-id and input; do not submit a new request ID.";
    if (options.json) {
      console.log(
        JSON.stringify({
          requestId,
          generationId: requestId,
          error: {
            message:
              error instanceof Error ? error.message : "Submission failed",
          },
          resumeCommand: resumeCommand(requestId),
          notice,
        }),
      );
    } else {
      console.error(`${notice}\nResume: ${resumeCommand(requestId)}`);
    }
    throw error;
  }
  printResult(result, options.json);
}

const statusCommand = new Command("status")
  .description("Reconcile an existing job without submitting another video")
  .argument("<generationId>", "Durable generation/request UUID", parseRequestId)
  .option("--json", "Print the job as JSON")
  .action(
    withErrorHandler(
      async (generationId: string, _options: unknown, command: Command) => {
        const options = command.optsWithGlobals<{ readonly json?: boolean }>();
        printResult(await getWebIntroVideoAgent(generationId), options.json);
      },
    ),
  );

export const introVideoAgentCommand = new Command()
  .name("__intro-video-agent")
  .description("Internal managed HeyGen Video Agent submission and status")
  .option("--prompt <text>", "Video instructions (1 to 10,000 characters)")
  .option("--prompt-file <path>", "UTF-8 file containing video instructions")
  .option(
    "--style-id <id>",
    "Resolved live catalog style ID (required for submission)",
  )
  .option("--avatar-id <id>", "Exact public avatar look ID")
  .option(
    "--avatar-group-id <id>",
    "Public avatar group ID for catalog resolution",
  )
  .option(
    "--voice-id <id>",
    "Exact voice ID; omitted with an avatar uses its default voice",
  )
  .addOption(
    new Option(
      "--orientation <orientation>",
      "Output orientation (required for submission)",
    ).choices(["landscape", "portrait"]),
  )
  .option(
    "--file-url <url>",
    "Managed HTTPS reference URL (repeat up to 20 times)",
    collectFileUrl,
    [],
  )
  .option(
    "--request-id <uuid>",
    "Reuse the same UUID and input after an uncertain submission",
    parseRequestId,
  )
  .option("--json", "Print the job as JSON")
  .addCommand(statusCommand)
  .addHelpText(
    "after",
    `
Submission requires one of --prompt or --prompt-file, --style-id, and --orientation.
For Auto style, choose a suitable concrete ID from okou __intro-video-catalog styles.
References: PNG/JPEG, MP4/WebM, MP3/WAV, PDF, up to 32 MB each. Prepare other documents as text or PDF.
This command returns a durable generation ID immediately; it does not wait or retry.
Keep that ID and use status to resume. A slow job or timeout does not authorize a new submission.

Examples:
  okou __intro-video-agent --prompt-file ./intro.txt --style-id selected-style --orientation landscape --json
  okou __intro-video-agent status <generationId> --json`,
  )
  .action(withErrorHandler(runIntroVideoAgentCommand));
