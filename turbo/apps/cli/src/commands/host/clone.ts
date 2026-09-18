import { Command, InvalidArgumentError } from "commander";
import chalk from "chalk";

import { withErrorHandler } from "../../lib/command/with-error-handler";
import { cloneHostedSite } from "../../lib/host/clone-hosted-site";
import { formatBytes } from "../../lib/utils/file-utils";

interface CloneOptions {
  readonly json?: boolean;
  readonly version?: number;
}

function parseVersion(value: string): number {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new InvalidArgumentError("version must be a positive integer");
  }
  return version;
}

function jsonOption(options: CloneOptions, command: Command): boolean {
  const parentOptions = command.parent?.opts<CloneOptions>();
  return Boolean(options.json || parentOptions?.json);
}

export const cloneHostedSiteCommand = new Command()
  .name("clone")
  .description("Clone a visible hosted-site version to a local directory")
  .argument(
    "<site>",
    "Hosted site slug, public URL, or authorized artifact reference",
  )
  .argument("[destination]", "Destination directory (default: public slug)")
  .option(
    "--version <number>",
    "Clone a specific artifact version",
    parseVersion,
  )
  .option("--json", "Output only the final result as JSON")
  .addHelpText(
    "after",
    `
Examples:
  Clone by public slug:  okou host clone my-site
  Clone by hosted URL:   okou host clone https://my-site.sites.example.com ./site
  Clone an artifact URL: okou host clone https://dpl-<deployment-id>.sites.example.com ./site
  Clone a shared site:  okou host clone /artifacts/abc123def4.html ./site
  Clone version 2:       okou host clone my-site --version 2
  Machine readable:      okou host clone my-site --json

Notes:
  - Authenticates via OKOU_TOKEN (requires host:read capability)
  - Uses the site's current only-me, organization, or public visibility
  - Shared sites download only the selected shared version, including its snapshot assets
  - Downloads files directly from R2 and verifies size/hash
  - The destination directory must be empty or not exist`,
  )
  .action(
    withErrorHandler(
      async (
        site: string,
        destination: string | undefined,
        options: CloneOptions,
        command: Command,
      ) => {
        const json = jsonOption(options, command);
        const result = await cloneHostedSite({
          site,
          destination,
          ...(options.version === undefined
            ? {}
            : { version: options.version }),
          onProgress: json
            ? undefined
            : (progress) => {
                if (progress.phase === "checking") {
                  console.log(chalk.dim("Checking hosted site..."));
                  return;
                }
                if (progress.phase === "creating") {
                  console.log(
                    chalk.dim(
                      `Preparing ${progress.fileCount?.toLocaleString() ?? 0} files...`,
                    ),
                  );
                  return;
                }
                console.log(chalk.dim(`Downloading ${progress.path}`));
              },
        });

        if (json) {
          console.log(JSON.stringify(result));
          return;
        }

        console.log(chalk.green("✓ Hosted site cloned"));
        console.log(chalk.dim(`  Site: ${result.publicSlug}`));
        if (result.deploymentVersion !== undefined) {
          console.log(chalk.dim(`  Version: v${result.deploymentVersion}`));
        }
        console.log(chalk.dim(`  Deployment: ${result.deploymentId}`));
        console.log(chalk.dim(`  Files: ${result.fileCount.toLocaleString()}`));
        console.log(chalk.dim(`  Size: ${formatBytes(result.size)}`));
        console.log(chalk.dim(`  Location: ${result.destination}/`));
        console.log(`  URL: ${result.artifactUrl ?? result.url}`);
      },
    ),
  );
