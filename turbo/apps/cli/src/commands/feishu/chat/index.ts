import { Command } from "commander";
import { feishuChatListQuerySchema } from "@okouai/api-contracts/contracts/feishu-official-read";
import { listOfficialFeishuChats } from "../../../lib/api/domains/feishu-official-read";
import { withErrorHandler } from "../../../lib/command/with-error-handler";

export const chatCommand = new Command()
  .name("chat")
  .description("Discover group chats shared with Okou Official")
  .addCommand(
    new Command()
      .name("list")
      .description("List group chats shared by you and the Official Feishu bot")
      .option("--limit <count>", "Chats in one provider page (1-50)", "20")
      .option("--cursor <cursor>", "Continue from nextCursor")
      .option("--json", "Print the response as JSON")
      .addHelpText(
        "after",
        "\nConnect to Okou Official in Settings > Feishu first. Both you and the bot must be in the group.\nAn empty page can still have nextCursor; continue with that cursor.\nRead messages with: okou feishu message history --chat <chat-id>",
      )
      .action(
        withErrorHandler(
          async (options: {
            limit: string;
            cursor?: string;
            json?: boolean;
          }) => {
            const result = await listOfficialFeishuChats(
              feishuChatListQuerySchema.parse(options),
            );
            if (options.json) {
              console.log(JSON.stringify(result, null, 2));
              return;
            }
            console.log(
              `Bot installation: ${result.installationId}. Use --as ${result.installationId} for messages and files.`,
            );
            for (const chat of result.chats) {
              console.log(`${chat.id}  ${chat.name}\n${chat.chatUrl}`);
            }
            if (!result.chats.length) {
              console.log(
                "No shared group chats on this page. Connect your account and add Okou Official to the group.",
              );
            }
            if (result.nextCursor) {
              console.log(`Next cursor: ${result.nextCursor}`);
            }
          },
        ),
      ),
  );
