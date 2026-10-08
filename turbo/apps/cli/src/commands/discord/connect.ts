import { Command } from "commander";
import { discordSnowflakeSchema } from "@okouai/api-contracts/contracts/integrations-discord-read";
import { startDiscordAuthorization } from "../../lib/api/domains/integrations-discord";
import { withErrorHandler } from "../../lib/command/with-error-handler";

export const connectCommand = new Command()
  .name("connect")
  .description("Start Discord browser consent for your current organization")
  .option("--install", "Install Okou to a server as an organization admin")
  .option("--guild-id <id>", "Discord server to install or connect to")
  .option("--json", "Print the authorization URL as JSON")
  .addHelpText(
    "after",
    `
Examples:
  Connect your account:  okou discord connect
  Install to a server:   okou discord connect --install --guild-id <id>

Notes:
  - Open the returned URL and complete official Discord browser consent.
  - This command starts authorization; it does not complete installation or account binding.
  - Installation requires an Okou organization admin and permission to manage the selected Discord server.
  - Identity, membership, and server access are verified by the API. No manual token or user ID is needed.`,
  )
  .action(
    withErrorHandler(
      async (options: {
        install?: boolean;
        guildId?: string;
        json?: boolean;
      }) => {
        const guildId =
          options.guildId === undefined
            ? undefined
            : discordSnowflakeSchema.parse(options.guildId);
        const result = await startDiscordAuthorization({
          flow: options.install ? "install" : "connect",
          ...(guildId ? { guildId } : {}),
        });
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(
          "Open this URL and complete official Discord browser consent:",
        );
        console.log(result.authorizationUrl);
        console.log(
          "Authorization has not completed. Check Discord in App Works after consent.",
        );
      },
    ),
  );
