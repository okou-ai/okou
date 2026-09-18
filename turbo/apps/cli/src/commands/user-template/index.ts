import {
  USER_TEMPLATE_KINDS,
  type UserTemplateKind,
} from "@okouai/api-contracts/contracts/user-templates";
import { Command, Option } from "commander";

import { ApiRequestError } from "../../lib/api/core/client-factory";
import {
  publishUserTemplate,
  replaceUserTemplatePackage,
  type PublishUserTemplateArgs,
} from "../../lib/api/domains/user-templates";
import { withErrorHandler } from "../../lib/command/with-error-handler";

interface PublishOptions {
  readonly title: string;
  readonly kind: UserTemplateKind;
  readonly source: string;
  readonly pages?: string;
  readonly package: string;
}

function requirePages(options: PublishOptions): string {
  if (options.pages === undefined) {
    throw new ApiRequestError(
      "--pages is required for a presentation template",
      "MISSING_PAGES",
      400,
    );
  }
  return options.pages;
}

/**
 * What each kind needs from the command line.
 *
 * Page images are a presentation's requirement, not a template's: a deck is
 * recognised by its first slide, a document by its styles, an illustration by
 * the picture it was reversed from. Every kind names its own needs here rather
 * than one of them being what the others fall through to, so a kind added to
 * `USER_TEMPLATE_KINDS` fails this switch until someone says what it takes —
 * instead of silently inheriting a demand for pages it has no use for.
 */
function publishArguments(options: PublishOptions): PublishUserTemplateArgs {
  const common = {
    title: options.title,
    sourcePath: options.source,
    packageDir: options.package,
  };
  switch (options.kind) {
    case "presentation": {
      return {
        ...common,
        kind: "presentation",
        pagesDir: requirePages(options),
      };
    }
    case "document": {
      return { ...common, kind: "document" };
    }
    case "illustration": {
      return { ...common, kind: "illustration" };
    }
  }
}

const publishCommand = new Command()
  .name("publish")
  .description(
    "Publish an analysed file as a reusable custom template. Uploads the source file, the ordered page images, and the guidance package, then commits them together.",
  )
  .requiredOption("--title <title>", "Template name shown to the user")
  .addOption(
    new Option("--kind <kind>", "What the template produces")
      .choices([...USER_TEMPLATE_KINDS])
      .default("presentation" satisfies UserTemplateKind),
  )
  .requiredOption(
    "--source <path>",
    "The original file: .ppt, .pptx or .pdf for a presentation; .doc, .docx or .pdf for a document; .png, .jpg, .bmp or .webp for an illustration",
  )
  .option(
    "--pages <dir>",
    "Directory of rendered page PNGs, in filename order. Presentations only",
  )
  .requiredOption(
    "--package <dir>",
    "Directory holding SKILL.md and whatever else its guidance names",
  )
  .addHelpText(
    "after",
    `
This is the publish step, not page rendering. First follow the authoritative reverse-template guide. A presentation also needs ordered page images rendered with okou presentation screenshot and passed as --pages; a document and an illustration have none. publish uploads the original file, any page PNGs, and the guidance package, then commits them together.

A published template appears under Custom in the template picker, private to you until you share it with your organization.`,
  )
  .action(
    withErrorHandler(async (options: PublishOptions) => {
      const template = await publishUserTemplate(publishArguments(options));
      console.log(
        template.pageCount === null
          ? `Published ${template.title} (${template.id})`
          : `Published ${template.title} (${template.id}) with ${template.pageCount.toString()} pages`,
      );
    }),
  );

/**
 * Rebuilding the package is not re-reversing the source, so this takes no
 * source and no pages: the file the template was compiled from has not
 * changed, and neither has what the catalog shows for it.
 */
const repackageCommand = new Command()
  .name("repackage")
  .description(
    "Replace a published custom template's guidance package. The template keeps its title, visibility, source and pages; only what a later run reads changes.",
  )
  .argument("<template-id>", "The template to rebuild the package for")
  .requiredOption(
    "--package <dir>",
    "Directory holding SKILL.md and whatever else its guidance names",
  )
  .action(
    withErrorHandler(
      async (templateId: string, options: { package: string }) => {
        const template = await replaceUserTemplatePackage({
          templateId,
          packageDir: options.package,
        });
        console.log(
          `Updated the package for ${template.title} (${template.id})`,
        );
      },
    ),
  );

export const userTemplateCommand = new Command()
  .name("user-template")
  .description("Publish custom templates compiled from a file you uploaded")
  .addCommand(publishCommand)
  .addCommand(repackageCommand);
