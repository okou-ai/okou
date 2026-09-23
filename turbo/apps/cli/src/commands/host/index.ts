import { Command } from "commander";
import chalk from "chalk";
import {
  hostedArtifactKindSchema,
  type HostedArtifactKind,
} from "@okouai/api-contracts/contracts/host";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { publishStaticSite } from "../../lib/host/publish-static-site";
import { createArtifactPresentation } from "../shared/artifact-return";
import { cloneHostedSiteCommand } from "./clone";
import { versionsHostedSiteCommand } from "./versions";

interface HostOptions {
  readonly site?: string;
  readonly slugSuffix?: string;
  readonly artifactKind?: HostedArtifactKind;
  readonly spa?: boolean;
  readonly json?: boolean;
}

function parseArtifactKind(value: string): HostedArtifactKind {
  return hostedArtifactKindSchema.parse(value);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const hostCommand = new Command()
  .name("host")
  .description("Publish, redeploy, inspect, and clone static hosted sites")
  .argument("<dir>", "Static build directory, for example ./dist")
  .option(
    "--site <slug>",
    "Preferred site slug; collisions get an automatic suffix",
  )
  .option("--slug-suffix <suffix>", "Site URL suffix for legacy API servers")
  .option(
    "--artifact-kind <kind>",
    "Artifact kind to record for this hosted deployment",
    parseArtifactKind,
  )
  .option("--spa", "Serve unknown HTML navigation paths from index.html")
  .option("--json", "Output the result and Markdown return forms as JSON")
  .addCommand(cloneHostedSiteCommand)
  .addCommand(versionsHostedSiteCommand)
  .addHelpText(
    "after",
    `
Examples:
  Publish a Vite build:  okou host ./dist --site my-product-demo --spa
  Redeploy the same URL: okou host ./dist --site my-product-demo --spa
  List site versions:    okou host versions my-product-demo
  Clone a hosted site:   okou host clone my-product-demo ./site
  Machine readable:      okou host ./dist --site my-product-demo --spa --json

Notes:
  - Publishes a static directory containing index.html. It does not deploy a long-running backend, database, worker, or framework runtime; use the project's deployment workflow for those
  - For an HTML presentation, add --artifact-kind presentation-html
  - The returned hosted URL is the user-facing artifact view; a local index.html or localhost server is not
  - Return the exact hosted URL printed by the command
  - Authenticates via OKOU_TOKEN (publish requires host:write; clone requires host:read)
  - Hosted sites are public: anyone with the returned URL can open them
  - Reusing --site redeploys that site when you created it: the hosted URL stays the same and serves the new version
  - A name owned by another chat or another user is rejected; choose a different --site value
  - HTML files may change on every redeploy; every other file must carry a content hash in its name, such as /assets/app-4f3a9c12.js
  - A published non-HTML path keeps its bytes forever. Rename a changed asset with its new content hash instead of republishing the same name
  - Use the returned Site slug with versions or clone to inspect a publication
  - The directory must include index.html
  - Local HTML/CSS asset references must point at files inside the directory`,
  )
  .action(
    withErrorHandler(async (dir: string, options: HostOptions) => {
      if (!options.site) {
        throw new Error("--site is required when publishing a hosted site");
      }
      const result = await publishStaticSite({
        dir,
        site: options.site,
        slugSuffix: options.slugSuffix,
        artifactKind: options.artifactKind,
        spaFallback: Boolean(options.spa),
        onProgress: options.json
          ? undefined
          : (progress) => {
              if (progress.phase === "preparing") {
                console.log(
                  chalk.dim(`Preparing ${progress.fileCount} files...`),
                );
                return;
              }
              console.log(chalk.dim(`Uploading ${progress.path}`));
            },
      });

      const presentation = createArtifactPresentation(
        options.site,
        result.aliasUrl ?? result.url,
      );
      if (options.json) {
        console.log(JSON.stringify({ ...result, ...presentation.json }));
        return;
      }

      console.log(chalk.green("✓ Hosted site deployed"));
      console.log(chalk.dim(`  Site: ${result.publicSlug}`));
      if (result.deploymentVersion !== undefined) {
        console.log(chalk.dim(`  Version: v${result.deploymentVersion}`));
      }
      if (result.artifactUrl) {
        console.log(`  Artifact: ${result.artifactUrl}`);
      }
      if (result.aliasUrl) {
        const target =
          result.isActive === false &&
          result.activeDeploymentVersion !== undefined
            ? `remains on v${result.activeDeploymentVersion}`
            : `v${result.deploymentVersion ?? "?"}`;
        console.log(`  Alias: ${result.aliasUrl} → ${target}`);
      }
      console.log(chalk.dim(`  Deployment: ${result.deploymentId}`));
      console.log(chalk.dim(`  Files: ${result.fileCount.toLocaleString()}`));
      console.log(chalk.dim(`  Size: ${formatBytes(result.size)}`));
      if (!result.aliasUrl) {
        console.log(`  URL: ${result.url}`);
      }
      console.log("");
      console.log(presentation.text);
    }),
  );
