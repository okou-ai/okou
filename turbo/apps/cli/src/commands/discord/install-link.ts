import { Command } from "commander";
import { createDiscordInstallLink } from "../../lib/api/domains/integrations-discord";
import { withErrorHandler } from "../../lib/command/with-error-handler";

export const installLinkCommand = new Command()
  .name("install-link")
  .description("Turn a Discord server invite into an Okou installation link")
  .requiredOption("--invite <url>", "Discord server invitation URL")
  .option("--json", "Print the installation URL and server as JSON")
  .addHelpText(
    "after",
    `
Example:
  okou discord install-link --invite "https://discord.gg/example" --json

Notes:
  - Return the exact URL to the user. Open it, sign in, and select the intended Okou workspace.
  - A user with Manage Server permission must authorize the installation in Discord.
  - Generating the link does not accept the invitation or add Okou to the server.
  - OAuth starts only when the user chooses Add new server in the browser.`,
  )
  .action(
    withErrorHandler(async (options: { invite: string; json?: boolean }) => {
      const result = await createDiscordInstallLink(options.invite);
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`Add Okou to ${result.guildName}:`);
      console.log(result.url);
      console.log(
        "Open the link, sign in, and select the intended Okou workspace. A user with Manage Server permission must authorize in Discord.",
      );
      console.log("Generating this link does not add Okou to the server.");
    }),
  );
