import { Command, InvalidArgumentError } from "commander";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { dispatchGenerate } from "../generate/lib/dispatch";
import type { GenerationType } from "../generate/lib/lister";
import {
  buildPresentationRunbookInstructionLines,
  findPresentationRunbookPackage,
  listPresentationRunbookPackages,
  resolvePresentationRunbookColorToken,
} from "@okouai/core/resource-registry";
import {
  PRESENTATION_IMAGE_BATCH_INSTRUCTION,
  PRESENTATION_STATIC_HTML_INSTRUCTION,
} from "@okouai/core/presentation-generation-instructions";
import { canonicalizeRegistryId } from "./resource-listing";
import {
  createArtifactVisibilityOption,
  type ArtifactVisibility,
} from "./artifact-visibility";

type PresentationRunbookPackage = ReturnType<
  typeof listPresentationRunbookPackages
>[number];

interface PresentationOptions {
  prompt?: string;
  slides: number;
  title?: string;
  siteSlug?: string;
  template?: string;
  visibility?: ArtifactVisibility;
}

interface PresentationGenerateCommandConfig {
  name: string;
  generationType: GenerationType;
  usageCommand: string;
  examples: string;
}

function parseSlideCount(value: string): number {
  const slideCount = Number(value);
  if (!Number.isInteger(slideCount)) {
    throw new InvalidArgumentError("slides must be an integer");
  }
  if (slideCount < 4 || slideCount > 20) {
    throw new InvalidArgumentError("slides must be between 4 and 20");
  }
  return slideCount;
}

function listPresentationTemplates(): readonly PresentationRunbookPackage[] {
  return listPresentationRunbookPackages();
}

function unknownTemplateError(id: string, usageCommand: string): Error {
  const templates = listPresentationTemplates();
  const message = [
    `Unknown template for presentation: ${id}`,
    "",
    "Available templates for presentation:",
    formatPresentationTemplateListing(templates),
    "",
    "Example:",
    `  ${usageCommand} --template ${
      templates[0]?.templateId ?? "<template-id>"
    } --prompt "..."`,
  ].join("\n");
  return new Error(message);
}

function formatPresentationTemplateListing(
  templates: readonly PresentationRunbookPackage[],
): string {
  if (templates.length === 0) {
    return "  (no presentation templates registered)";
  }
  return templates
    .map((template) => {
      return `  ${template.templateId}\n    ${template.description}`;
    })
    .join("\n\n");
}

export function createPresentationGenerateCommand(
  config: PresentationGenerateCommandConfig,
): Command {
  return new Command()
    .name(config.name)
    .description("Generate an HTML presentation from a prompt")
    .option(
      "--prompt <text>",
      "Presentation prompt; can also be piped via stdin",
    )
    .option("--site-slug <slug>", "Hosted site slug override")
    .option("--title <text>", "Requested deck title")
    .addOption(createArtifactVisibilityOption())
    .option(
      "--template <id>",
      "Presentation template id (see Templates below). Accepts either 'html-ppt-playful-launch' or 'template:html-ppt-playful-launch'.",
    )
    .option("--slides <count>", "Slide count: 4-20", parseSlideCount, 8)
    .addHelpText("after", () => {
      const templates = listPresentationTemplates();
      return `
Examples:
${config.examples}

Output:
  Prints a source-selection packet for the current agent.

Notes:
  - Authenticates via OKOU_TOKEN
  - The agent authors the HTML presentation artifact and hosts it with okou host

Templates (presentation):
${formatPresentationTemplateListing(templates)}`;
    })
    .action(
      withErrorHandler(async (options: PresentationOptions) => {
        const dispatch = await dispatchGenerate({
          generationType: config.generationType,
          prompt: options.prompt,
        });
        if (dispatch.outcome === "handled") return;
        const prompt = dispatch.prompt;
        const visibilityFlag =
          options.visibility === undefined
            ? ""
            : ` --visibility ${options.visibility}`;
        const hostCommand = `okou host <output-dir> --site ${options.siteSlug ?? "<slug>"} --artifact-kind presentation-html${visibilityFlag}`;
        const deliveryInstructions = [
          options.visibility === undefined
            ? "- With privateArtifacts enabled, new artifacts default to only-me. Otherwise, hosting and upload keep their existing behavior."
            : `- Publish the final deck with ${options.visibility} visibility. Explicit visibility requires privateArtifacts to be enabled.`,
          "- Keep supporting generated media at its default visibility and bundle local copies. The selected visibility applies to the final deck; do not make supporting media public separately.",
          `- For a requested file copy, use \`okou web upload-file -f <file>${visibilityFlag}\`.`,
          "- Return the exact URL printed by the delivery command.",
        ];

        if (options.template !== undefined) {
          const canonical = canonicalizeRegistryId(
            "template",
            options.template,
          );
          const template = findPresentationRunbookPackage(canonical);
          if (!template) {
            throw unknownTemplateError(options.template, config.usageCommand);
          }
          const color = resolvePresentationRunbookColorToken(
            template,
            undefined,
          );
          const colorSystemToken =
            "error" in color ? template.defaultColorSystem : color.token;
          console.log(
            [
              "# Presentation Generation (template)",
              "",
              ...buildPresentationRunbookInstructionLines({
                runbookPackage: template,
                colorSystemToken,
                hostCommand,
              }),
              ...deliveryInstructions,
              "",
              `User request: ${prompt}`,
            ].join("\n"),
          );
          return;
        }

        console.log(
          [
            "# Okou generate presentation",
            "",
            "This is a direct HTML presentation authoring packet for the current agent.",
            "Author the deck directly from the user's request and any supplied source material.",
            "",
            "## User Prompt",
            prompt,
            "",
            "## Requested Parameters",
            `- Slide count: ${options.slides}`,
            `- Requested deck title: ${options.title ?? "not specified"}`,
            "- Selected template: agent decides",
            "",
            "## Authoring Rules",
            "- Think like a presentation designer, not a web page designer.",
            "- Use a fixed 1920x1080 slide canvas and scale it uniformly for smaller viewports.",
            "- Use one section per slide and keep repeated elements in consistent positions.",
            PRESENTATION_STATIC_HTML_INSTRUCTION,
            PRESENTATION_IMAGE_BATCH_INSTRUCTION,
            "- Make keyboard navigation work with ArrowLeft, ArrowRight, Home, and End.",
            "- Keep slide text readable from across a room; avoid memo-like walls of text.",
            "- Produce exactly the requested slide count. Do not let a template's reference example or preview slide count override the requested count.",
            "- Before authoring, make an internal slide plan with exactly the requested count and map each slide to a narrative role plus a selected template layout or device.",
            "- Adapt the selected template to the requested slide count: for shorter decks, merge or omit lower-priority content roles; for longer decks, split dense sections into multiple focused slides or reuse layout patterns with different substantive content. Do not add decorative, duplicate, or empty filler slides.",
            "- Use selected template references only for structure, layout devices, spacing, and visual language. Do not inherit or continue any reference deck's sample subject, sample story, sample copy, sample metrics, preview imagery, or media seed names.",
            "- Derive every presentation image/media choice from the user's requested topic, story, source material, or cited facts.",
            "- Before laying out slides, establish the deck's arc: the opening problem or question, how it develops, and what conclusion lands; every slide should serve a clear narrative role in that arc.",
            "- Vary slide forms across the deck — full-bleed statement, evidence with data, pull quote, section break, summary — and avoid defaulting every slide to title-plus-bullets.",
            "- Each slide carries one idea; prefer a single strong statement over a list, and never exceed three bullets on any slide.",
            "",
            "## Verification",
            "- Use `agent-browser` for browser verification when available. Start with `agent-browser skills get core` if you need command guidance.",
            "- Prefer `agent-browser` over Playwright, Puppeteer, or installing browser automation dependencies.",
            "- Open the HTML locally and verify it is nonblank.",
            "- Check that keyboard/click interactions work when present.",
            "- Check that text does not overflow or overlap at desktop and mobile viewport sizes.",
            "- Check that shapes, charts, images, or decorative graphics do not cover readable text at desktop and mobile viewport sizes.",
            "",
            "## Publish",
            `- Host the finished deck: ${hostCommand}`,
            ...deliveryInstructions,
          ].join("\n"),
        );
      }),
    );
}
