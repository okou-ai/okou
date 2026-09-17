import {
  USER_TEMPLATE_KINDS,
  type UserTemplateKind,
} from "@okouai/api-contracts/contracts/user-templates";
import { Command, Option } from "commander";

import { ApiRequestError } from "../../lib/api/core/client-factory";
import { publishUserTemplate } from "../../lib/api/domains/user-templates";
import { withErrorHandler } from "../../lib/command/with-error-handler";

interface PublishOptions {
  readonly title: string;
  readonly kind: UserTemplateKind;
  readonly source: string;
  readonly pages?: string;
  readonly package: string;
}

type PublishArguments =
  | { readonly kind: "presentation"; readonly pagesDir: string }
  | { readonly kind: "document"; readonly pagesDir: undefined };

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
 * recognised by its first slide, a document by its styles. Every kind names
 * its own needs here rather than one of them being what the others fall
 * through to, so a kind added to `USER_TEMPLATE_KINDS` fails this switch until
 * someone says what it takes — instead of silently inheriting a demand for
 * pages it has no use for.
 */
function publishArguments(options: PublishOptions): PublishArguments {
  switch (options.kind) {
    case "presentation": {
      return { kind: "presentation", pagesDir: requirePages(options) };
    }
    case "document": {
      return { kind: "document", pagesDir: undefined };
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
    "The original .ppt, .pptx, .pdf, .doc, or .docx",
  )
  .option(
    "--pages <dir>",
    "Directory of rendered page PNGs, in filename order. Presentations only",
  )
  .requiredOption(
    "--package <dir>",
    "Directory holding SKILL.md, design-system.md and any assets",
  )
  .addHelpText(
    "after",
    `
This is the publish step, not page rendering. First follow the authoritative reverse-template guide and render ordered page images with okou presentation screenshot. publish uploads the original file, ordered page PNGs, and guidance package, then commits them together.

A published template appears under Custom in the template picker, private to you until you share it with your organization.`,
  )
  .action(
    withErrorHandler(async (options: PublishOptions) => {
      const template = await publishUserTemplate({
        title: options.title,
        ...publishArguments(options),
        sourcePath: options.source,
        packageDir: options.package,
      });
      console.log(
        template.pageCount === null
          ? `Published ${template.title} (${template.id})`
          : `Published ${template.title} (${template.id}) with ${template.pageCount.toString()} pages`,
      );
    }),
  );

export const userTemplateCommand = new Command()
  .name("user-template")
  .description("Publish custom templates compiled from a file you uploaded")
  .addCommand(publishCommand);
