import { Argument, Command } from "commander";
import chalk from "chalk";
import { hostedSitePublicSlugSchema } from "@okouai/api-contracts/contracts/host";
import {
  getHostedSiteBanner,
  updateHostedSiteBanner,
} from "../../lib/api/domains/hosted-site-banner";
import { withErrorHandler } from "../../lib/command/with-error-handler";

interface BannerOptions {
  readonly json?: boolean;
}

export function createHostedSiteBannerCommand(): Command {
  return new Command("banner")
    .description("Read or change an owned site's Okou banner setting")
    .argument(
      "<site>",
      "Current site slug printed by okou host, or the site URL",
    )
    .addArgument(
      new Argument(
        "[state]",
        "Show or hide the banner; omit to read its setting",
      ).choices(["on", "off"]),
    )
    .option("--json", "Output the saved setting as JSON")
    .addHelpText(
      "after",
      `
Examples:
  Read the setting:  okou host banner my-product-demo
  Hide the banner:   okou host banner my-product-demo off
  Show the banner:   okou host banner https://my-product-demo.okou.app on --json

Notes:
  - Requires OKOU_TOKEN with host:write and hosted-site settings enabled
  - Only the site's owner can change this setting
  - New Sites show the banner by default; redeployments keep the saved setting
  - Changes apply on the next page load without publishing a new version
  - A concurrent edit is rejected; read the setting again before retrying`,
    )
    .action(
      withErrorHandler(
        async (
          site: string,
          state: "on" | "off" | undefined,
          _options: BannerOptions,
          command: Command,
        ) => {
          const input = site.trim();
          const publicSlug = hostedSitePublicSlugSchema.parse(
            input.includes("://")
              ? new URL(input).hostname.split(".")[0]
              : input,
          );
          const current = await getHostedSiteBanner(publicSlug);
          const result =
            state === undefined || current.showBanner === (state === "on")
              ? current
              : await updateHostedSiteBanner(current, state === "on");
          const { json } = command.optsWithGlobals<BannerOptions>();
          if (json) {
            console.log(JSON.stringify({ publicSlug, ...result }));
            return;
          }
          console.log(
            chalk.green(
              `Okou banner: ${result.showBanner ? "shown" : "hidden"}`,
            ),
          );
          console.log(chalk.dim(`  Site: ${publicSlug}`));
          console.log(
            chalk.dim(
              `  ${result.showBanner ? "Hide" : "Show"}: okou host banner ${publicSlug} ${result.showBanner ? "off" : "on"}`,
            ),
          );
        },
      ),
    );
}
