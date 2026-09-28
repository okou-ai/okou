import { Command } from "commander";
import chalk from "chalk";
import { listTelegramBots } from "../../../lib/api/domains/integrations-telegram";
import { withErrorHandler } from "../../../lib/command/with-error-handler";
import type { TelegramBotListItem } from "@okouai/api-contracts/contracts/integrations";

function usernameLabel(bot: TelegramBotListItem): string {
  if (!bot.username) return "-";
  return bot.username.startsWith("@") ? bot.username : `@${bot.username}`;
}

function statusLabel(bot: TelegramBotListItem): string {
  if (bot.tokenStatus === "valid") return chalk.green("valid");
  if (bot.tokenStatus === "invalid") return chalk.red("invalid");
  return chalk.yellow("unknown");
}

export const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List Telegram bots available in the active organization")
  .addHelpText(
    "after",
    `
Examples:
  okou telegram bot list

Notes:
  - Use this to find the bot ID for --as before sending Telegram messages.`,
  )
  .action(
    withErrorHandler(async () => {
      const result = await listTelegramBots();
      const { bots } = result;

      if (bots.length === 0) {
        console.log(chalk.dim("No Telegram bots found"));
        console.log(
          chalk.dim("  Add one from Settings > Integrations > Telegram"),
        );
        return;
      }

      const botIdWidth = Math.max(
        6,
        ...bots.map((bot) => {
          return bot.id.length;
        }),
      );
      const usernameWidth = Math.max(
        8,
        ...bots.map((bot) => {
          return usernameLabel(bot).length;
        }),
      );
      const agentWidth = Math.max(
        5,
        ...bots.map((bot) => {
          return (bot.agent?.name ?? "-").length;
        }),
      );

      const header = [
        "BOT ID".padEnd(botIdWidth),
        "USERNAME".padEnd(usernameWidth),
        "AGENT".padEnd(agentWidth),
        "CONNECTED",
        "TOKEN",
      ].join("  ");
      console.log(chalk.dim(header));

      for (const bot of bots) {
        const row = [
          bot.id.padEnd(botIdWidth),
          usernameLabel(bot).padEnd(usernameWidth),
          (bot.agent?.name ?? "-").padEnd(agentWidth),
          (bot.isConnected ? "yes" : "no").padEnd(9),
          statusLabel(bot),
        ].join("  ");
        console.log(row);
      }
    }),
  );
