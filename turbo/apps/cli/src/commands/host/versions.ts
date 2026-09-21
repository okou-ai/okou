import { Command } from "commander";
import chalk from "chalk";

import { getHostedSiteDeployments } from "../../lib/api/domains/host";
import { withErrorHandler } from "../../lib/command/with-error-handler";

interface VersionsOptions {
  readonly json?: boolean;
}

function jsonOption(options: VersionsOptions, command: Command): boolean {
  const parentOptions = command.parent?.opts<VersionsOptions>();
  return Boolean(options.json || parentOptions?.json);
}

export const versionsHostedSiteCommand = new Command()
  .name("versions")
  .description("List immutable artifact versions for an owned hosted site")
  .argument("<site>", "Logical site slug")
  .option("--json", "Output only the result as JSON")
  .addHelpText(
    "after",
    `
Examples:
  List versions:     okou host versions my-product-demo
  Machine readable:  okou host versions my-product-demo --json

Notes:
  - Authenticates via OKOU_TOKEN and requires host:read
  - Requires hosted artifact versions to be enabled for the current user
  - The active marker identifies the version served by the site alias`,
  )
  .action(
    withErrorHandler(
      async (site: string, options: VersionsOptions, command: Command) => {
        const result = await getHostedSiteDeployments(site);
        if (jsonOption(options, command)) {
          console.log(JSON.stringify(result));
          return;
        }

        console.log(chalk.bold(`Hosted site versions: ${result.site}`));
        if (result.aliasUrl) {
          console.log(chalk.dim(`Alias: ${result.aliasUrl}`));
        }
        if (result.deployments.length === 0) {
          console.log(chalk.dim("No deployments found"));
          console.log(
            chalk.dim(`Deploy one with: okou host <dir> --site ${result.site}`),
          );
          return;
        }

        for (const deployment of result.deployments) {
          const marker = deployment.isActive ? chalk.green("* ") : "  ";
          const version =
            deployment.deploymentVersion === null
              ? "legacy"
              : `v${deployment.deploymentVersion}`;
          const url = deployment.artifactUrl ?? result.aliasUrl;
          if (!url) {
            throw new Error("Hosted deployment has no artifact or alias URL");
          }
          console.log(
            `${marker}${version}  ${deployment.status}  ${deployment.createdAt}  ${url}`,
          );
        }
      },
    ),
  );
