import { Command } from "commander";

import { publishUserTemplate } from "../../lib/api/domains/user-templates";
import { withErrorHandler } from "../../lib/command/with-error-handler";

interface PublishOptions {
  readonly title: string;
  readonly source: string;
  readonly pages: string;
  readonly package: string;
}

const publishCommand = new Command()
  .name("publish")
  .description(
    "Publish an analysed file as a reusable custom template. Uploads the source file, the ordered page images, and the guidance package, then commits them together.",
  )
  .requiredOption("--title <title>", "Template name shown to the user")
  .requiredOption("--source <path>", "The original .ppt, .pptx, or .pdf")
  .requiredOption(
    "--pages <dir>",
    "Directory of rendered page PNGs, in filename order",
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
        // The only kind a reverse run compiles today. It travels explicitly so
        // a second kind does not silently inherit this one's meaning.
        kind: "presentation",
        sourcePath: options.source,
        pagesDir: options.pages,
        packageDir: options.package,
      });
      console.log(
        `Published ${template.title} (${template.id}) with ${template.pageCount.toString()} pages`,
      );
    }),
  );

export const userTemplateCommand = new Command()
  .name("user-template")
  .description("Publish custom templates compiled from a file you uploaded")
  .addCommand(publishCommand);
