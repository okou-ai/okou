import { Command } from "commander";

import { publishPresentationTemplate } from "../../lib/api/domains/presentation-templates";
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
    "Publish an analysed deck as a reusable presentation template. Uploads the source deck, the ordered page images, and the guidance package, then commits them together.",
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
This is the publish step, not page rendering. First follow the authoritative reverse-template guide and render ordered page images with okou presentation screenshot. publish uploads the original deck, ordered page PNGs, and guidance package, then commits them together.`,
  )
  .action(
    withErrorHandler(async (options: PublishOptions) => {
      const template = await publishPresentationTemplate({
        title: options.title,
        sourcePath: options.source,
        pagesDir: options.pages,
        packageDir: options.package,
      });
      console.log(
        `Published ${template.title} (${template.id}) with ${template.pageCount.toString()} pages`,
      );
    }),
  );

export const presentationTemplateCommand = new Command()
  .name("presentation-template")
  .description("Publish presentation templates extracted from a deck")
  .addCommand(publishCommand);
