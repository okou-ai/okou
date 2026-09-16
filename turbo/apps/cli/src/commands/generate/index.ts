import { Command } from "commander";
import { imageCommand } from "./image";
import { imageBatchCommand } from "./image-batch";
import {
  dashboardDesignCommand,
  docsDesignCommand,
  mobileAppDesignCommand,
  posterCommand,
  reportCommand,
} from "./artifacts";
import { presentationCommand } from "./presentation";
import { spriteCommand } from "./sprite";
import { videoCommand } from "./video";
import { avatarVideoCommand } from "./avatar-video";
import { websiteCommand } from "./website";
import { voiceCommand } from "./voice";
import { createListerOnlyCommand } from "./lister-only";

const musicCommand = createListerOnlyCommand({
  name: "music",
  generationType: "music",
  description: "List connectors that provide music generation",
});

const textCommand = createListerOnlyCommand({
  name: "text",
  generationType: "text",
  description: "List connectors that provide text generation",
});

const codeCommand = createListerOnlyCommand({
  name: "code",
  generationType: "code",
  description: "List connectors that provide code generation",
});

const documentCommand = createListerOnlyCommand({
  name: "document",
  generationType: "document",
  description: "List connectors that provide document generation",
});

function buildGenerateHelpText(): string {
  const examples = [
    '  Generate image:        okou generate image --raw-prompt "A watercolor fox"',
    "  Batch artifact images: okou generate image-batch start images.tsv .image-batch",
    '  Generate deck:         okou generate presentation --prompt "A product roadmap"',
    '  Generate report:       okou generate report --prompt "A Q2 usage report"',
    '  Generate docs:         okou generate docs-design --prompt "A setup guide"',
    '  Generate video:        okou generate video --prompt "A cinematic city shot"',
    '  Generate avatar video: okou generate avatar-video --avatar-id 81 --voice-id en-US-ChristopherNeural --script "Hello"',
    '  Generate site:         okou generate website --prompt "A launch site"',
    '  Generate sprite:       okou generate sprite --prompt "A slime monster idle loop"',
    '  Generate speech:       okou generate voice --prompt "Hello"',
    "  Show music choices:    okou generate music",
    "",
    "  Show image choices:    okou generate image",
    "  Show report choices:   okou generate report",
    "  Use a connector:       okou generate video --provider heygen",
    "  Force built-in:        okou generate image --provider built-in --model gpt-image-2 --raw-prompt ...",
  ];

  return `
Examples:
${examples.join("\n")}

Routing:
  - If the task includes an attached generation template, follow that template's exact commands and resources. Do not run generic provider discovery unless the template names it as a fallback.
  - Otherwise, run this help to choose a supported type, then run "okou generate <type>" with no generation input to list every available provider for that type. Run the type's --help before execution; flags differ (for example, avatar-video uses --script or --audio-url, not --prompt).
  - Supported generation surfaces are image, video, avatar-video, presentation, voice/audio, website, and connector-backed text, code, or document plus the listed HTML artifact types. Do not infer unsupported types.

Execution:
  - Use --provider built-in for Okou execution or --provider <connector> for connector skill-invocation guidance where offered.
  - After starting an Okou generation, wait for it to finish and use the returned artifact. Do not launch a duplicate or recreate the result because generation is taking time.
  - Media and connector-backed generation types may expose --provider for Okou or connector execution guidance.
  - HTML artifact types use registry-backed --design-system and --template selection.`;
}

export const generateCommand = new Command()
  .name("generate")
  .description(
    "Generate assets via Okou's built-in pipelines or get connector skill-invocation guidance",
  )
  .addCommand(imageCommand)
  .addCommand(imageBatchCommand)
  .addCommand(presentationCommand)
  .addCommand(reportCommand)
  .addCommand(docsDesignCommand)
  .addCommand(posterCommand)
  .addCommand(dashboardDesignCommand)
  .addCommand(mobileAppDesignCommand)
  .addCommand(videoCommand)
  .addCommand(avatarVideoCommand)
  .addCommand(websiteCommand)
  .addCommand(spriteCommand)
  .addCommand(voiceCommand)
  .addCommand(musicCommand)
  .addCommand(textCommand)
  .addCommand(codeCommand)
  .addCommand(documentCommand)
  .addHelpText("after", buildGenerateHelpText);
