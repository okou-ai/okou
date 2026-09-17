import { Command } from "commander";
import chalk from "chalk";
import {
  hostedArtifactKindSchema,
  type HostedArtifactKind,
} from "@okouai/api-contracts/contracts/host";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { publishStaticSite } from "../../lib/host/publish-static-site";
import { createArtifactPresentation } from "../shared/artifact-return";
import {
  applyArtifactVisibility,
  createArtifactVisibilityOption,
  prepareArtifactVisibility,
  type ArtifactVisibility,
} from "../shared/artifact-visibility";
import { cloneHostedSiteCommand } from "./clone";
import { versionsHostedSiteCommand } from "./versions";

interface HostOptions {
  readonly site?: string;
  readonly slugSuffix?: string;
  readonly artifactKind?: HostedArtifactKind;
  readonly spa?: boolean;
  readonly json?: boolean;
  readonly visibility?: ArtifactVisibility;
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
  .description("Deploy and inspect owned static hosted sites")
  .argument("<dir>", "Static build directory, for example ./dist")
  .option("--site <slug>", "Logical site slug, e.g. my-product-demo")
  .option("--slug-suffix <suffix>", "Reuse a legacy generated site URL suffix")
  .option(
    "--artifact-kind <kind>",
    "Artifact kind to record for this hosted deployment",
    parseArtifactKind,
  )
  .option("--spa", "Serve unknown HTML navigation paths from index.html")
  .option("--json", "Output the result and Markdown return forms as JSON")
  .addOption(createArtifactVisibilityOption())
  .addCommand(cloneHostedSiteCommand)
  .addCommand(versionsHostedSiteCommand)
  .addHelpText(
    "after",
    `
Examples:
  Publish a Vite build:  okou host ./dist --site my-product-demo --spa
  Publish next version:  okou host ./dist --site my-product-demo --spa
  Reuse a legacy URL:    okou host ./dist --site my-product-demo --slug-suffix release-01 --spa
  List site versions:    okou host versions my-product-demo
  Clone a hosted site:   okou host clone my-product-demo ./site
  Machine readable:     okou host ./dist --site my-product-demo --spa --json
  Share publicly:       okou host ./dist --site my-product-demo --visibility public

Notes:
  - Publishes a static directory containing index.html. It does not deploy a long-running backend, database, worker, or framework runtime; use the project's deployment workflow for those
  - For an HTML presentation, add --artifact-kind presentation-html
  - The returned hosted URL is the user-facing artifact view; a local index.html or localhost server is not
  - Return the exact hosted URL printed by the command
  - Authenticates via OKOU_TOKEN (publish requires host:write; clone requires host:read)
  - With private artifacts enabled, the result is an authenticated preview URL
  - With privateArtifacts enabled, new versions default to only-me; --visibility org or public explicitly shares the new version
  - --visibility requires privateArtifacts and is checked before uploading; without the option, flag-off behavior is unchanged
  - only-me leaves any older version's existing share unchanged
  - Private deployments never update an existing public alias
  - For public versioned deployments, reusing --site updates the same alias
  - Otherwise, reuse both --site and --slug-suffix to keep a legacy URL
  - The directory must include index.html
  - Local HTML/CSS asset references must point at files inside the directory`,
  )
  .action(
    withErrorHandler(async (dir: string, options: HostOptions) => {
      if (!options.site) {
        throw new Error("--site is required when publishing a hosted site");
      }
      const requirePrivateArtifact = await prepareArtifactVisibility(
        options.visibility,
      );
      const deployed = await publishStaticSite({
        dir,
        site: options.site,
        slugSuffix: options.slugSuffix,
        artifactKind: options.artifactKind,
        spaFallback: Boolean(options.spa),
        requirePrivateArtifact,
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

      const result = await applyArtifactVisibility(
        deployed,
        { kind: "html", id: deployed.deploymentId },
        options.visibility,
      );

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
