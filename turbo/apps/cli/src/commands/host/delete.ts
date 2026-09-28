import { Command } from "commander";
import chalk from "chalk";

import { deleteHostedSite } from "../../lib/api/domains/host";
import { withErrorHandler } from "../../lib/command/with-error-handler";

interface DeleteOptions {
  readonly json?: boolean;
}

function jsonOption(options: DeleteOptions, command: Command): boolean {
  const parentOptions = command.parent?.opts<DeleteOptions>();
  return Boolean(options.json || parentOptions?.json);
}

/** Accept the printed site slug or its hosted URL; the first label names the site. */
function siteSlugFromInput(value: string): string {
  const trimmed = value.trim();
  const host = trimmed.includes("://") ? new URL(trimmed).hostname : trimmed;
  return (host.split(".")[0] ?? host).toLowerCase();
}

export const deleteHostedSiteCommand = new Command()
  .name("delete")
  .description("Take an owned hosted site and all of its versions offline")
  .argument("<site>", "Site slug printed by okou host, or the site URL")
  .option("--json", "Output only the result as JSON")
  .addHelpText(
    "after",
    `
Examples:
  Delete a site:     okou host delete my-product-demo
  Delete by URL:     okou host delete https://my-product-demo.okou.app
  Machine readable:  okou host delete my-product-demo --json

Notes:
  - Authenticates via OKOU_TOKEN and requires host:write
  - Only the site's owner can delete it, from any chat in the organization that published it
  - The site URL and every version URL stop serving immediately
  - Files are kept: redeploy with okou host <dir> --site <slug> from the chat that published the site to put it back online as a new version
  - Deleted versions stay offline after a redeploy`,
  )
  .action(
    withErrorHandler(
      async (site: string, options: DeleteOptions, command: Command) => {
        if (site.trim().startsWith("dpl-") || site.includes("://dpl-")) {
          throw new Error(
            "Use the site slug or site URL, not a version URL; deleting a site takes every version offline",
          );
        }
        const result = await deleteHostedSite(siteSlugFromInput(site));
        if (jsonOption(options, command)) {
          console.log(JSON.stringify(result));
          return;
        }

        console.log(chalk.green(`✓ Hosted site deleted: ${result.publicSlug}`));
        for (const url of result.offlineUrls) {
          console.log(`  Offline: ${url}`);
        }
        console.log(
          chalk.dim(
            `Restore it from the chat that published it: okou host <dir> --site ${result.site}`,
          ),
        );
      },
    ),
  );
