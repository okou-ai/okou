import { Command } from "commander";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { createHtmlArtifactAuthoringPacket } from "../shared/html-artifact-authoring";
import {
  findDesignSystem,
  findWebsiteTemplateResource,
  findTemplate,
  listDesignSystems,
  listTemplates,
} from "@okouai/core/resource-registry";
import {
  canonicalizeRegistryId,
  formatRegistryListing,
} from "../shared/resource-listing";
import { dispatchGenerate } from "./lib/dispatch";
import { WEBSITE_IMAGE_BATCH_INSTRUCTION } from "@okouai/core/website-generation-instructions";

const WEBSITE_TARGET = "website";
const WEBSITE_USAGE_COMMAND = "okou generate website";

interface WebsiteOptions {
  readonly prompt?: string;
  readonly template?: string;
  readonly designSystem?: string;
  readonly siteSlug?: string;
  readonly title?: string;
}

function selectedTemplateDetails(
  template: ReturnType<typeof findTemplate> | undefined,
): readonly string[] {
  if (!template) {
    return ["Selected template: agent decides"];
  }
  const details = [`Selected template: ${template.id} (${template.name})`];
  if (template.source.archive) {
    details.push(
      `Selected template package: okou resource pull ${template.id} --dir ./generated/resources`,
      `Selected template archive SHA-256: ${template.source.archive.sha256}`,
    );
  }
  return details;
}

function unknownDesignSystemError(id: string): Error {
  const designSystems = listDesignSystems();
  const message = [
    `Unknown design system: ${id}`,
    "",
    "Available design systems:",
    formatRegistryListing(designSystems, "design systems"),
    "",
    `Example:`,
    `  ${WEBSITE_USAGE_COMMAND} --design-system ${
      designSystems[0]?.id ?? "<design-system-id>"
    } --prompt "..."`,
  ].join("\n");
  return new Error(message);
}

function unknownTemplateError(id: string): Error {
  const templates = listTemplates(WEBSITE_TARGET);
  const message = [
    `Unknown template for ${WEBSITE_TARGET}: ${id}`,
    "",
    `Available templates for ${WEBSITE_TARGET}:`,
    formatRegistryListing(templates, `${WEBSITE_TARGET} templates`),
    "",
    `Example:`,
    `  ${WEBSITE_USAGE_COMMAND} --template ${
      templates[0]?.id ?? "<template-id>"
    } --prompt "..."`,
  ].join("\n");
  return new Error(message);
}

export const websiteCommand = new Command()
  .name("website")
  .description("Prepare website authoring instructions from a prompt")
  .option("--prompt <text>", "Website prompt; can also be piped via stdin")
  .option("--site-slug <slug>", "Hosted site slug override")
  .option("--title <text>", "Requested site title or name")
  .option(
    "--design-system <id>",
    "Design system id from the registry (see Design Systems below). Accepts either 'apple' or 'design-system:apple'.",
  )
  .option(
    "--template <id>",
    "Template id scoped to website (see Templates below). Accepts either short id or full 'template:<id>'.",
  )
  .addHelpText("after", () => {
    const designSystems = listDesignSystems();
    const templates = listTemplates(WEBSITE_TARGET);
    return `
Examples:
  Generate site:         okou generate website --prompt "A launch site for a developer observability tool"
  Pick template:         okou generate website --template black-slabs --prompt "Launch site for a billing API"
  Pick design system:    okou generate website --design-system stripe --prompt "Pricing page for a SaaS"
  Custom site slug:      okou generate website --site-slug api-migration-demo --prompt "An internal migration microsite"
  Pipe prompt:           cat brief.txt | okou generate website
  Show choices:          okou generate website

Output:
  Prints a source-selection packet for the current agent.
  With no --prompt and no piped input, prints the generation choices instead.

Notes:
  - Authenticates via OKOU_TOKEN
  - The agent authors the HTML artifact and hosts it with okou host

Design Systems:
${formatRegistryListing(designSystems, "design systems")}

Templates (website):
${formatRegistryListing(templates, "website templates")}`;
  })
  .action(
    withErrorHandler(async (options: WebsiteOptions) => {
      const dispatch = await dispatchGenerate({
        generationType: "website",
        prompt: options.prompt,
      });
      if (dispatch.outcome === "handled") return;
      const prompt = dispatch.prompt;

      let resolvedDesignSystem;
      if (options.designSystem !== undefined) {
        const canonical = canonicalizeRegistryId(
          "design-system",
          options.designSystem,
        );
        const entry = findDesignSystem(canonical);
        if (!entry) {
          throw unknownDesignSystemError(options.designSystem);
        }
        resolvedDesignSystem = entry;
      }

      let resolvedTemplate;
      if (options.template !== undefined) {
        const canonical = canonicalizeRegistryId("template", options.template);
        const entry =
          findWebsiteTemplateResource(options.template) ??
          findTemplate(canonical);
        if (!entry || !entry.targets?.includes(WEBSITE_TARGET)) {
          throw unknownTemplateError(options.template);
        }
        resolvedTemplate = entry;
      }

      const templateSelectionRules = resolvedTemplate
        ? ["Use the explicitly selected template."]
        : [
            "For landing, marketing, official brand or product, and launch pages, select an Okou built-in website template.",
            "For other HTML or website requests, select an Open Design template based on intent; when ambiguous, prefer Open Design.",
            "Built-in website candidates have `source.archive`; candidates without it are Open Design templates.",
          ];

      const packet = createHtmlArtifactAuthoringPacket({
        kind: "website",
        prompt,
        slugSource: options.title,
        siteSlug: options.siteSlug,
        details: [
          `Requested title/site name: ${options.title ?? "not specified"}`,
          `Selected design system: ${
            resolvedDesignSystem
              ? `${resolvedDesignSystem.id} (${resolvedDesignSystem.name})`
              : "agent decides"
          }`,
          ...selectedTemplateDetails(resolvedTemplate),
        ],
        artifactRules: [
          "Build the usable website as the first screen; do not output a landing-page plan.",
          ...templateSelectionRules,
          "If it is a marketing site, make the product or offer visible in the first viewport.",
          "For app or tool surfaces, prioritize dense, scannable, task-focused UI over decorative sections.",
          WEBSITE_IMAGE_BATCH_INSTRUCTION,
          "Use responsive HTML/CSS and verify the page works at mobile and desktop widths.",
        ],
      });

      console.log(packet.instructions);
    }),
  );
