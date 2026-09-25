import { Command } from "commander";
import { discordChannelListQuerySchema } from "@okouai/api-contracts/contracts/integrations-discord-read";
import { listDiscordChannels } from "../../../lib/api/domains/integrations-discord";
import { withErrorHandler } from "../../../lib/command/with-error-handler";

export const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description(
    "List guild channels visible to both your Discord account and Okou",
  )
  .option(
    "--guild-id <id>",
    "Optional; must match your organization's bound guild",
  )
  .option("--json", "Print the response as JSON")
  .addHelpText(
    "after",
    `
Examples:
  okou discord channel list --json
  okou discord channel list --guild-id <guild-id>

Notes:
  - Requires discord:read and an existing verified Discord binding.
  - Your binding is resolved from the current organization. --guild-id is optional; when given, it must match that binding's guild.
  - Lists text and announcement channels. Forum and media posts are threads; read one with its thread ID.
  - This command does not list DMs or create or join channels.
  - Read a returned channel with okou discord message history --channel-id <id>.`,
  )
  .action(
    withErrorHandler(async (options: { guildId?: string; json?: boolean }) => {
      const parsed = discordChannelListQuerySchema.safeParse(options);
      if (!parsed.success) {
        throw new Error(
          parsed.error.issues
            .map((issue) => {
              return `${issue.path.join(".")}: ${issue.message}`;
            })
            .join("\n"),
        );
      }
      const result = await listDiscordChannels(parsed.data);
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      if (result.channels.length === 0) {
        console.log(
          "No shared channels. Check your guild binding and both your and Okou's channel permissions in Discord.",
        );
      }
      for (const channel of result.channels) {
        console.log(`${channel.id}  #${channel.name}`);
        console.log(
          `https://discord.com/channels/${channel.guildId}/${channel.id}`,
        );
      }
      console.log(
        "Read history: okou discord message history --channel-id <id>",
      );
    }),
  );
