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
    "Publish an analysed deck as a reusable custom presentation template. Uploads the source deck, the ordered page images, and the guidance package, then commits them together.",
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
This is the publish step, not page rendering. First follow the authoritative reverse-template guide and render ordered page images with okou presentation screenshot. publish uploads the original deck, ordered page PNGs, and guidance package, then commits them together.

The published deck appears under Custom in the template picker, private to you until you share it with your organization. This command uses the same catalog as okou user-template publish --kind presentation.`,
  )
  .action(
    withErrorHandler(async (options: PublishOptions) => {
      const template = await publishUserTemplate({
        kind: "presentation",
        title: options.title,
        sourcePath: options.source,
        pagesDir: options.pages,
        packageDir: options.package,
      });
      console.log(
        template.pageCount === null
          ? `Published ${template.title} (${template.id})`
          : `Published ${template.title} (${template.id}) with ${template.pageCount.toString()} pages`,
      );
    }),
  );

export const presentationTemplateCommand = new Command()
  .name("presentation-template")
  .description("Publish presentation templates extracted from a deck")
  .addCommand(publishCommand);
