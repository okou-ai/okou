import { Command } from "commander";
import { larkChatListQuerySchema } from "@okouai/api-contracts/contracts/lark-official-read";
import { listOfficialLarkChats } from "../../../lib/api/domains/lark-official-read";
import { withErrorHandler } from "../../../lib/command/with-error-handler";

export const chatCommand = new Command()
  .name("chat")
  .description("Discover group chats shared with Okou Official")
  .addCommand(
    new Command()
      .name("list")
      .description("List group chats shared by you and the Official Lark bot")
      .option("--limit <count>", "Chats in one provider page (1-50)", "20")
      .option("--cursor <cursor>", "Continue from nextCursor")
      .option("--json", "Print the response as JSON")
      .addHelpText(
        "after",
        "\nConnect to Okou Official in Settings > Lark first. Both you and the bot must be in the group.\nAn empty page can still have nextCursor; continue with that cursor.\nRead messages with: okou lark message history --chat <chat-id>",
      )
      .action(
        withErrorHandler(
          async (options: {
            limit: string;
            cursor?: string;
            json?: boolean;
          }) => {
            const result = await listOfficialLarkChats(
              larkChatListQuerySchema.parse(options),
            );
            if (options.json) {
              console.log(JSON.stringify(result, null, 2));
              return;
            }
            console.log(
              `Bot installation: ${result.installationId}. Use --as ${result.installationId} for message send/upload-file and --installation ${result.installationId} for download-file.`,
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
