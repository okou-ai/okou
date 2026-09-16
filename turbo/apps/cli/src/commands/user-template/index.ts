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
    "Publish an analysed deck as a custom template for the uploader's own catalog. Uploads the source deck, the ordered page images, and the guidance package, then commits them together.",
  )
  .requiredOption("--title <title>", "Template name shown to the user")
  .requiredOption("--source <path>", "The original .ppt or .pptx")
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
Use this when the deck came from the user's own upload. It files the template under Custom, visible to the uploader and shareable with their organization; okou presentation-template publish files it in the official catalog instead.

This is the publish step, not page rendering. First follow the authoritative reverse-template guide and render ordered page images with okou presentation screenshot.`,
  )
  .action(
    withErrorHandler(async (options: PublishOptions) => {
      const template = await publishUserTemplate({
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

export const userTemplateCommand = new Command()
  .name("user-template")
  .description("Publish custom templates extracted from an uploaded deck")
  .addCommand(publishCommand);
