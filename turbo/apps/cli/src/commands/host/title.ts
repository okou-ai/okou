import { Command } from "commander";
import chalk from "chalk";
import {
  hostedSitePublicSlugSchema,
  hostedSiteTitleSchema,
} from "@okouai/api-contracts/contracts/host";
import { updateHostedSiteTitle } from "../../lib/api/domains/host";
import { withErrorHandler } from "../../lib/command/with-error-handler";

interface TitleOptions {
  readonly json?: boolean;
}

export const titleHostedSiteCommand = new Command()
  .name("title")
  .description("Change an owned site's display title without changing its URL")
  .argument("<site>", "Current site slug printed by okou host, or the site URL")
  .argument("<title>", "New display title (1-200 characters)")
  .option("--json", "Output the result as JSON")
  .addHelpText(
    "after",
    `
Examples:
  Rename a site:     okou host title my-product-demo "Product demo"
  Rename by URL:     okou host title https://my-product-demo.okou.app "Product demo"
  Machine readable:  okou host title my-product-demo "Product demo" --json

Notes:
  - Requires OKOU_TOKEN with host:write and website title editing enabled
  - Only the site's owner can rename it, from any chat in its organization
  - Updates the shared title shown in Chat and Artifacts; the URL stays the same
  - Redeployments keep the saved title; use this command to rename a site`,
  )
  .action(
    withErrorHandler(
      async (
        site: string,
        title: string,
        options: TitleOptions,
        cmd: Command,
      ) => {
        const input = site.trim();
        const slug = input.includes("://")
          ? new URL(input).hostname.split(".")[0]
          : input;
        const result = await updateHostedSiteTitle(
          hostedSitePublicSlugSchema.parse(slug),
          hostedSiteTitleSchema.parse(title),
        );
        if (options.json || cmd.parent?.opts<TitleOptions>().json) {
          console.log(JSON.stringify(result));
          return;
        }
        console.log(
          chalk.green(`✓ Hosted site title updated: ${result.title}`),
        );
        console.log(chalk.dim(`  Site: ${result.publicSlug}`));
      },
    ),
  );
