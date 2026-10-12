import { Command } from "commander";
import { discordSnowflakeSchema } from "@okouai/api-contracts/contracts/integrations-discord-read";
import { getPlatformOrigin } from "../../lib/platform-url";
import { withErrorHandler } from "../../lib/command/with-error-handler";

export const connectCommand = new Command()
  .name("connect")
  .description("Open App Works to install Okou or connect your Discord account")
  .option("--install", "Show server-install guidance for an organization admin")
  .option(
    "--guild-id <id>",
    "Server to select during browser consent (guidance only)",
  )
  .option("--json", "Print the App Works URL and requested flow as JSON")
  .addHelpText(
    "after",
    `
Examples:
  Connect your account:  okou discord connect
  Install to a server:   okou discord connect --install --guild-id <id>

Notes:
  - Open App Works, sign in independently, and select the intended Okou organization.
  - Choose Install to Discord as an organization admin, or Connect after installation.
  - The App starts authorization in your browser; complete official Discord consent there.
  - --install and --guild-id provide guidance only. They do not create an OAuth attempt, install Okou, or bind an account.
  - No manual token or user ID is needed. The API verifies identity and server membership.`,
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
        const result = {
          url: new URL("/works", await getPlatformOrigin()).toString(),
          flow: options.install ? "install" : "connect",
          ...(guildId ? { guildId } : {}),
        };
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(
          "Open App Works, sign in, and select the intended organization:",
        );
        console.log(result.url);
        console.log(
          options.install
            ? "Choose Install to Discord as an organization admin."
            : "Choose Connect on the Discord card after your admin installs Okou.",
        );
        if (guildId) {
          console.log(
            `Select Discord server ${guildId} during consent. This is guidance, not a verified binding.`,
          );
        }
        console.log(
          "Complete official Discord browser consent. Authorization has not started or completed in this CLI.",
        );
      },
    ),
  );
