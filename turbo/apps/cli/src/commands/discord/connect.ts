import { Command, Option } from "commander";
import { discordSnowflakeSchema } from "@okouai/api-contracts/contracts/integrations-discord-read";
import { getPlatformOrigin } from "../../lib/platform-url";
import { withErrorHandler } from "../../lib/command/with-error-handler";

export const connectCommand = new Command()
  .name("connect")
  .description("Connect your Discord account in the App")
  .addOption(new Option("--install").hideHelp())
  .option(
    "--guild-id <id>",
    "Connect from a server that already has the Okou bot",
  )
  .option("--json", "Print the connection URL as JSON")
  .addHelpText(
    "after",
    `
Examples:
  Connect Discord:       okou discord connect
  Connect from a server: okou discord connect --guild-id <id>

Notes:
  - Open the link, sign in independently, and select the intended Okou workspace.
  - Choose Connect and complete official Discord browser consent.
  - Without a server ID, Discord lets you choose a server and add the bot.
  - With a server ID, the bot must already be there; no server picker is needed.
  - No manual token or user ID is needed. The API verifies identity and server membership.`,
  )
  .action(
    withErrorHandler(async (options: { guildId?: string; json?: boolean }) => {
      const guildId =
        options.guildId === undefined
          ? undefined
          : discordSnowflakeSchema.parse(options.guildId);
      const url = new URL("/settings/discord", await getPlatformOrigin());
      if (guildId) {
        url.searchParams.set("guild_id", guildId);
      }
      const result = {
        url: url.toString(),
        flow: "connect",
        ...(guildId ? { guildId } : {}),
      };
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log("Open the link, sign in, and select the intended workspace:");
      console.log(result.url);
      console.log(
        "Choose Connect and complete official Discord browser consent.",
      );
      console.log("Authorization has not started or completed in this CLI.");
    }),
  );
