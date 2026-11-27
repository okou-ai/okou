import { Command, InvalidArgumentError, Option } from "commander";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { dispatchGenerate } from "../generate/lib/dispatch";
import { isPaidToolEnabled } from "../../lib/command/paid-tools";
import {
  buildPresentationRunbookInstructionLines,
  findPresentationRunbookPackage,
  listPresentationRunbookPackages,
} from "@okouai/core/resource-registry";
import {
  PRESENTATION_OUTPUT_FORMATS,
  type PresentationOutputFormat,
} from "@okouai/core/presentation-output-format";
import {
  presentationImageInstructions,
  PRESENTATION_STATIC_HTML_INSTRUCTION,
  presentationDeliveryInstructions,
} from "@okouai/core/presentation-generation-instructions";
import { canonicalizeRegistryId } from "./resource-listing";
import { hostedSiteVisibilityInstructions } from "../../lib/host/visibility";
import { hostedSiteDeliveryInstructions } from "../../lib/host/delivery";
import {
  createArtifactVisibilityOption,
  type ArtifactVisibility,
} from "./artifact-visibility";

const FORMAT_PARAMETER_GUIDANCE =
  "The CLI output format is a package-selection parameter, not proof of an explicit user choice. Resolve the format from the current input before authoring; if it differs, select the matching package with --format. Do not query or update saved preferences.";

type PresentationRunbookPackage = ReturnType<
  typeof listPresentationRunbookPackages
>[number];

interface PresentationOptions {
  format: PresentationOutputFormat;
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

function unknownTemplateError(
  id: string,
  outputFormat: PresentationOutputFormat,
): Error {
  const templates = listPresentationRunbookPackages(outputFormat);
  const message = [
    `Unknown template for ${outputFormat.toUpperCase()} presentation: ${id}`,
    "",
    `Available templates for ${outputFormat.toUpperCase()} presentation:`,
    formatPresentationTemplateListing(templates),
    "",
    "Example:",
    `  okou generate presentation --format ${outputFormat} --template ${
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
      return `  ${template.templateId}\n    ${template.description}\n    Package: ${template.resourceId}`;
    })
    .join("\n\n");
}

export function createPresentationGenerateCommand(): Command {
  return new Command()
    .name("presentation")
    .description("Generate an HTML or native PPTX presentation from a prompt")
    .option(
      "--prompt <text>",
      "Presentation prompt; can also be piped via stdin",
    )
    .option("--site-slug <slug>", "Hosted HTML site slug override")
    .option("--title <text>", "Requested deck title")
    .addOption(
      new Option(
        "--format <format>",
        "Output format; selects the matching presentation template package",
      )
        .choices(PRESENTATION_OUTPUT_FORMATS)
        .default("html"),
    )
    .addOption(createArtifactVisibilityOption())
    .option(
      "--template <id>",
      "Presentation style id for the requested format (see Templates below). Accepts either 'html-ppt-playful-launch' or 'template:html-ppt-playful-launch'.",
    )
    .option("--slides <count>", "Slide count: 4-20", parseSlideCount, 8)
    .addHelpText("after", ({ command }) => {
      const { format } = command.opts<PresentationOptions>();
      const templates = listPresentationRunbookPackages(format);
      return `
Examples:
  Generate HTML:         okou generate presentation --prompt "A strategy deck for reducing support volume"
  Generate native PPTX:  okou generate presentation --format pptx --prompt "A strategy deck for reducing support volume"
  Pipe prompt:           cat brief.txt | okou generate presentation
  Pick slide count:      okou generate presentation --slides 10 --prompt "A product launch narrative"
  Custom site slug:      okou generate presentation --site-slug api-migration-plan --prompt "API migration plan"
  Show choices:          okou generate presentation

Output:
  Prints a source-selection packet for the current agent.

Notes:
  - Authenticates via OKOU_TOKEN
  - Without --template, the agent reads the source and selects a built-in template by tone, audience fit, and visual preferences
  - --format selects separate HTML or native PPTX template packages; HTML is the default
  - For --format html, author and check HTML, then deliver it with okou host
  - For --format pptx, follow the native PPTX workflow and upload the .pptx file; do not author HTML and convert it
  - Deliver one format unless the user requests multiple formats
  - Use --format pptx --help to see the native PPTX package catalog

Templates (presentation, ${format}):
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
        const outputFormat = options.format;
        const resourceDir =
          outputFormat === "pptx"
            ? "./generated/resources/pptx"
            : "./generated/resources";
        const visibilityFlag =
          options.visibility === undefined
            ? ""
            : ` --visibility ${options.visibility}`;
        const displayTitle = options.title
          ? `'${options.title.replaceAll("'", "'\\''")}'`
          : '"<presentation title>"';
        const hostCommand =
          outputFormat === "html"
            ? `okou host <output-dir> --site ${options.siteSlug ?? "<slug>"} --title ${displayTitle} --artifact-kind presentation-html${visibilityFlag} --preview ./generated/previews/cover.png --json`
            : undefined;
        const deliveryInstructions = [
          ...(outputFormat === "html"
            ? [`- For hosted HTML delivery: ${hostedSiteDeliveryInstructions}`]
            : []),
          options.visibility === undefined
            ? outputFormat === "html"
              ? `- Uploaded and generated files default to only-me. ${hostedSiteVisibilityInstructions}`
              : "- Uploaded and generated files default to only-me."
            : `- Deliver the final deck with ${options.visibility} visibility.`,
          "- Keep supporting generated media at its default visibility and bundle local copies. The selected visibility applies to the final deck; do not make supporting media public separately.",
          `- For file delivery, use \`okou web upload-file -f ${outputFormat === "pptx" ? "<deck.pptx>" : "<file>"}${visibilityFlag}\`.`,
        ];

        if (options.template !== undefined) {
          const canonical = canonicalizeRegistryId(
            "template",
            options.template,
          );
          const template = findPresentationRunbookPackage(
            canonical,
            outputFormat,
          );
          if (!template) {
            throw unknownTemplateError(options.template, outputFormat);
          }
          console.log(
            [
              "# Presentation Generation (template)",
              "",
              `Requested output format: ${outputFormat}`,
              FORMAT_PARAMETER_GUIDANCE,
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
            `- Requested output format: ${outputFormat}`,
            `- ${FORMAT_PARAMETER_GUIDANCE}`,
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
            ...listPresentationRunbookPackages(outputFormat).map((template) => {
              return [
                `### ${template.name} (${template.templateId})`,
                template.description,
                `Package: ${template.resourceId}; default color system: ${template.defaultColorSystem}`,
                "",
              ].join("\n");
            }),
            "## Use the Selected Template",
            `- Pull only the selected package once: \`okou resource pull <Package from the catalog> --dir ${resourceDir}\`.`,
            "- Read SKILL.md in the source directory printed by the pull command fully, then read the workflow instructions it references. Follow that package's authoring, worker startup, layout and verification workflow, using its listed default color system unless the request specifies another supported palette.",
            "- Use the source understanding above in the selected workflow; do not restart source preparation unnecessarily. Preserve the requested slide count and substantive content rather than copying the reference deck's sample story, wording, metrics, imagery or page count.",
            outputFormat === "html"
              ? PRESENTATION_STATIC_HTML_INSTRUCTION
              : "- Author the deck natively as PPTX using the selected package's workflow; keep slide content editable instead of authoring HTML and converting it. If the package is unavailable, report the failure instead of substituting an HTML package.",
            ...presentationImageInstructions(
              isPaidToolEnabled("image-generation"),
            ),
            "",
            "## Delivery",
            ...presentationDeliveryInstructions({
              outputFormat,
              hostCommand,
            }),
            ...deliveryInstructions,
          ].join("\n"),
        );
      }),
    );
}
