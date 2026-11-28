import { Argument, Command } from "commander";
import chalk from "chalk";
import { hostedSitePublicSlugSchema } from "@okouai/api-contracts/contracts/host";
import {
  assertArtifactUserSharing,
  getHostedSiteVisibility,
  updateHostedSiteVisibility,
} from "../../lib/api/domains/hosted-site-sharing";
import {
  hostedSiteAudiences,
  hostedSiteCliVisibility,
  hostedSiteEmailRecipients,
  shareHostedSitePrivately,
  type HostedSiteCliVisibility,
} from "../../lib/host/visibility";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { createHostedSiteEmailOption } from "./visibility-options";

interface VisibilityOptions {
  readonly email?: string[];
  readonly json?: boolean;
  readonly visibility?: HostedSiteCliVisibility;
}

export function createHostedSiteVisibilityCommand(): Command {
  return new Command("visibility")
    .description("Read or change an owned site's audience without republishing")
    .argument("<site>", "Current site slug printed by okou host")
    .addArgument(
      new Argument("[visibility]", "Omit to read the general audience").choices(
        Object.keys(hostedSiteAudiences),
      ),
    )
    .addOption(createHostedSiteEmailOption())
    .option(
      "--json",
      "Output the saved audience and processed invitations as JSON",
    )
    .addHelpText(
      "after",
      `
Examples:
  Read the audience:   okou host visibility my-report --json
  Invite by email:     okou host visibility my-report email --email person@example.com
  Invite two people:   okou host visibility my-report email --email a@example.com --email b@example.com --json
  Workspace access:    okou host visibility my-report org
  Public access:       okou host visibility my-report public

Notes:
  - Requires OKOU_TOKEN with host:write; only the owner can change the audience
  - Email sharing uses the same server-side switch as the App
  - Email visibility keeps general access private and requires at least one full email
  - Recipients sign in with their invited, verified email; no workspace membership is added
  - Changing the general audience preserves existing email invitations and grants
  - A processed invitation does not confirm email delivery or account registration
  - Concurrent audience edits are rejected; read the setting before retrying`,
    )
    .action(
      withErrorHandler(
        async (
          site: string,
          requested: HostedSiteCliVisibility | undefined,
          options: VisibilityOptions,
          command: Command,
        ) => {
          const parent = command.parent?.opts<VisibilityOptions>();
          const visibility = requested ?? parent?.visibility;
          const emails = hostedSiteEmailRecipients(visibility, [
            ...(parent?.email ?? []),
            ...(options.email ?? []),
          ]);
          const publicSlug = hostedSitePublicSlugSchema.parse(site.trim());
          if (visibility === "email") {
            await assertArtifactUserSharing();
          }
          const sharing =
            visibility === "email"
              ? await shareHostedSitePrivately(publicSlug, emails)
              : undefined;
          const current =
            sharing?.status ?? (await getHostedSiteVisibility(publicSlug));
          const saved =
            visibility === undefined || visibility === "email"
              ? current
              : await updateHostedSiteVisibility(
                  current,
                  hostedSiteAudiences[visibility],
                );
          const result = {
            publicSlug,
            ...saved,
            visibility:
              visibility === "email"
                ? "email"
                : hostedSiteCliVisibility(saved.visibility),
            ...(sharing ? { shares: sharing.shares } : {}),
          };
          if (command.optsWithGlobals<VisibilityOptions>().json) {
            console.log(JSON.stringify(result));
            return;
          }
          console.log(chalk.green(`Website visibility: ${result.visibility}`));
          console.log(chalk.dim(`  Site: ${publicSlug}`));
          if (sharing) {
            console.log(
              chalk.green(
                `  Sharing invitations processed: ${sharing.shares.length}`,
              ),
            );
          }
        },
      ),
    );
}
