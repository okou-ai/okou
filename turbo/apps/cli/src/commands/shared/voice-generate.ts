import { Command, Option } from "commander";
import chalk from "chalk";
import { generateWebVoice } from "../../lib/api/domains/web";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { assertPaidToolEnabled } from "../../lib/command/paid-tools";
import { createArtifactPresentation } from "./artifact-return";
import {
  applyArtifactVisibility,
  createArtifactVisibilityOption,
  prepareArtifactVisibility,
  type ArtifactVisibility,
} from "./artifact-visibility";
import { dispatchGenerate } from "../generate/lib/dispatch";
import type { GenerationType } from "../generate/lib/lister";

interface VoiceOptions {
  prompt?: string;
  text?: string;
  provider?: string;
  voice: string;
  instructions?: string;
  all?: boolean;
  json?: boolean;
  visibility?: ArtifactVisibility;
}

interface VoiceGenerateCommandConfig {
  name: string;
  generationType: GenerationType;
  usageCommand: string;
  examples: string;
}

export function createVoiceGenerateCommand(
  config: VoiceGenerateCommandConfig,
): Command {
  return new Command()
    .name(config.name)
    .description("Generate a billed speech audio file from text")
    .option("--prompt <text>", "Text to speak; can also be piped via stdin")
    .addOption(new Option("--text <text>", "Alias for --prompt").hideHelp())
    .option(
      "--provider <name>",
      "Provider: 'built-in' to run Okou's pipeline, or a connector name (heygen, elevenlabs, ...) to get its skill-invocation guidance",
    )
    .option(
      "--all",
      "When listing providers (no --prompt given), include unavailable or not-yet-authorized connectors",
    )
    .option("--json", "Print the complete generation result as JSON")
    .addOption(createArtifactVisibilityOption())
    .option("--voice <voice>", "OpenAI voice to use", "marin")
    .option("--instructions <text>", "Voice style instructions")
    .addHelpText(
      "after",
      `
Examples:
${config.examples}

Output:
  Prints the generated /f/ audio file URL and metadata. Use --json for the
  complete result object. With no --prompt and no piped input, prints the
  provider menu instead.

  Successful results include inline-link and rich-preview Markdown guidance.
  --json includes inlineMarkdownLink, previewMarkdownBlock, and artifactPresentationContext.

Notes:
  - Authenticates via OKOU_TOKEN (requires file:write capability)
  - Charges org credits after successful audio generation
  - Uses gpt-4o-mini-tts with WAV output`,
    )
    .action(
      withErrorHandler(async (options: VoiceOptions) => {
        const dispatch = await dispatchGenerate({
          generationType: config.generationType,
          provider: options.provider,
          prompt: options.prompt ?? options.text,
          all: options.all,
          requireExecutionFor: options.visibility
            ? "--visibility"
            : options.json
              ? "--json"
              : undefined,
        });
        if (dispatch.outcome === "handled") return;
        await assertPaidToolEnabled("voice-generation");
        const text = dispatch.prompt;

        const requirePrivateArtifact = await prepareArtifactVisibility(
          options.visibility,
        );
        const generated = await generateWebVoice({
          text,
          voice: options.voice,
          instructions: options.instructions,
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

        console.log(chalk.green(`✓ Voice generated: ${result.url}`));
        console.log(chalk.dim(`  File: ${result.filename}`));
        console.log(chalk.dim(`  Duration: ${result.durationSeconds}s`));
        console.log(chalk.dim(`  Credits charged: ${result.creditsCharged}`));
        console.log(chalk.dim(`  Model: ${result.model}`));
        console.log(chalk.dim(`  Voice: ${result.voice}`));
        console.log(`\n${presentation.text}`);
      }),
    );
}
