import { Command, InvalidArgumentError } from "commander";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { dispatchGenerate } from "../generate/lib/dispatch";
import { isPaidToolEnabled } from "../../lib/command/paid-tools";
import {
  buildPresentationRunbookInstructionLines,
  findPresentationRunbookPackage,
  listPresentationRunbookPackages,
} from "@okouai/core/resource-registry";
import {
  presentationImageInstructions,
  PRESENTATION_STATIC_HTML_INSTRUCTION,
  presentationDeliveryInstructions,
} from "@okouai/core/presentation-generation-instructions";
import { canonicalizeRegistryId } from "./resource-listing";
import { hostedSiteVisibilityInstructions } from "../../lib/host/visibility";
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

function unknownTemplateError(id: string): Error {
  const templates = listPresentationRunbookPackages();
  const message = [
    `Unknown template for presentation: ${id}`,
    "",
    "Available templates for presentation:",
    formatPresentationTemplateListing(templates),
    "",
    "Example:",
    `  okou generate presentation --template ${
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

export function createPresentationGenerateCommand(): Command {
  return new Command()
    .name("presentation")
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
      const templates = listPresentationRunbookPackages();
      return `
Examples:
  Generate deck:         okou generate presentation --prompt "A strategy deck for reducing support volume"
  Pipe prompt:           cat brief.txt | okou generate presentation
  Pick slide count:      okou generate presentation --slides 10 --prompt "A product launch narrative"
  Custom site slug:      okou generate presentation --site-slug api-migration-plan --prompt "API migration plan"
  Show choices:          okou generate presentation

Output:
  Prints a source-selection packet for the current agent.

Notes:
  - Authenticates via OKOU_TOKEN
  - Without --template, the agent reads the source and selects a built-in template by tone, audience fit, and visual preferences
  - The agent authors HTML first, then chooses delivery from the request, remembered preferences, and intended use
  - Use okou host for HTML; follow the platform's conversion instructions only when the agent selects PPTX
  - Deliver one format unless the user requests multiple formats

Templates (presentation):
${formatPresentationTemplateListing(templates)}`;
    })
    .action(
      withErrorHandler(async (options: PresentationOptions) => {
        const dispatch = await dispatchGenerate({
          generationType: "presentation",
          prompt: options.prompt,
        });
        if (dispatch.outcome === "handled") return;
        const prompt = dispatch.prompt;
        const visibilityFlag =
          options.visibility === undefined
            ? ""
            : ` --visibility ${options.visibility}`;
        const displayTitle = options.title
          ? `'${options.title.replaceAll("'", "'\\''")}'`
          : '"<presentation title>"';
        const hostCommand = `okou host <output-dir> --site ${options.siteSlug ?? "<slug>"} --title ${displayTitle} --artifact-kind presentation-html${visibilityFlag} --preview ./generated/previews/cover.png --json`;
        const deliveryInstructions = [
          options.visibility === undefined
            ? `- Uploaded and generated files default to only-me. ${hostedSiteVisibilityInstructions}`
            : `- Deliver the final deck with ${options.visibility} visibility.`,
          "- Keep supporting generated media at its default visibility and bundle local copies. The selected visibility applies to the final deck; do not make supporting media public separately.",
          `- For file delivery, use \`okou web upload-file -f <file>${visibilityFlag}\`.`,
        ];

        if (options.template !== undefined) {
          const canonical = canonicalizeRegistryId(
            "template",
            options.template,
          );
          const template = findPresentationRunbookPackage(canonical);
          if (!template) {
            throw unknownTemplateError(options.template);
          }
          console.log(
            [
              "# Presentation Generation (template)",
              "",
              ...buildPresentationRunbookInstructionLines({
                runbookPackage: template,
                colorSystemToken: template.defaultColorSystem,
                imageGenerationEnabled: isPaidToolEnabled("image-generation"),
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
            "Select a built-in presentation template from the catalog below, then use its authoring workflow.",
            "",
            "## User Prompt",
            prompt,
            "",
            "## Requested Parameters",
            `- Slide count: ${options.slides}`,
            `- Requested deck title: ${options.title ?? "not specified"}`,
            "",
            "## Understand the Task and Source",
            "- Before choosing a template, planning slides, or launching workers, read the user's request and supplied source text and inspect important charts and images. Reuse source understanding already available in this conversation.",
            "- Identify the audience, intended outcome, essential evidence, desired tone and visual preferences. Preserve the requested page count, language, brand requirements and output format.",
            "- Distinguish content sources from visual references and explicitly required templates. An uploaded PDF is not automatically a style reference; its file type or topic alone does not determine the template.",
            "",
            "## Select a Template",
            "- Honor an explicitly selected or named template. When revising an existing deck, retain its established style unless the user asks to change it.",
            "- Otherwise choose one template from the catalog based only on tone, audience fit, and visual preferences. All templates support the same content capabilities; do not rank them by charts, tables, diagrams, images, language, fonts, or content capacity.",
            "- The scenarios in each description are examples, not subject restrictions. The same source may suit different templates for different audiences or purposes; do not select by template name alone.",
            "- When visual preferences are unspecified, choose a broadly suitable, understated style consistent with the audience and context.",
            "- Keep the choice internal: do not announce the selected template or ask the user to choose or confirm one. Proceed with generation.",
            "",
            "## Built-in Template Catalog",
            ...listPresentationRunbookPackages().map((template) => {
              return [
                `### ${template.name} (${template.templateId})`,
                template.description,
                `Package: ${template.resourceId}; default color system: ${template.defaultColorSystem}`,
                "",
              ].join("\n");
            }),
            "## Use the Selected Template",
            "- Pull only the selected package once: `okou resource pull <Package from the catalog> --dir ./generated/resources`.",
            "- Read SKILL.md in the source directory printed by the pull command fully, then read the workflow instructions it references. Follow that package's authoring, worker startup, layout and verification workflow, using its listed default color system unless the request specifies another supported palette.",
            "- Use the source understanding above in the selected workflow; do not restart source preparation unnecessarily. Preserve the requested slide count and substantive content rather than copying the reference deck's sample story, wording, metrics, imagery or page count.",
            PRESENTATION_STATIC_HTML_INSTRUCTION,
            ...presentationImageInstructions(
              isPaidToolEnabled("image-generation"),
            ),
            "",
            "## Delivery",
            ...presentationDeliveryInstructions({
              hostCommand,
            }),
            ...deliveryInstructions,
          ].join("\n"),
        );
      }),
    );
}
