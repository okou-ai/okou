import type { DiscordHistoryResponse } from "@okouai/api-contracts/contracts/integrations-discord-read";

export function printDiscordMessages(result: DiscordHistoryResponse): void {
  if (result.contextMode === "mentions_only") {
    console.log(
      "Limited content visibility (mentions_only): Discord may withhold ordinary message text and attachments. Missing content does not mean the conversation was empty.",
    );
  }
  if (result.messages.length === 0) {
    console.log("No messages returned on this page.");
  }
  for (const message of result.messages) {
    console.log(
      `${message.id}  ${message.timestamp}  ${message.author.username}`,
    );
    console.log(
      message.content ||
        (result.contextMode === "mentions_only"
          ? "[Text may be withheld by Discord; use --json to inspect available metadata]"
          : "[No text content; use --json to inspect attachments]"),
    );
    console.log(message.url);
    if (message.attachments.length > 0) {
      console.log(
        `Attachments: ${message.attachments
          .map((attachment) => {
            return attachment.filename;
          })
          .join(", ")} (use --json for metadata)`,
      );
    }
  }
  if (result.nextBefore) {
    console.log(`Next before: ${result.nextBefore}`);
    console.log(
      "Continue with --before and the same guild, channel, and message selection.",
    );
  }
}
