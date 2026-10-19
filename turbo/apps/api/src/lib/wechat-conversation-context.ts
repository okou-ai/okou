import type { WechatAttachments } from "@okouai/db/jsonb-contracts/wechat";
import { formatConversationContext } from "./integration-conversation-context";

export function wechatConversationContext(args: {
  readonly connectionId: string;
  readonly senderId: string;
  readonly botId: string;
  readonly messages: readonly {
    readonly id: string;
    readonly direction: string;
    readonly status: string;
    readonly content: string;
    readonly attachments: WechatAttachments;
  }[];
}): string {
  return formatConversationContext({
    integration: "WeChat",
    contextType: "thread",
    messages: args.messages.map((message) => {
      const text = message.content;
      return {
        sender:
          message.direction === "inbound"
            ? { id: args.senderId }
            : { id: args.botId, name: "Okou" },
        text:
          message.direction === "outbound" && message.status !== "sent"
            ? `[Delivery status: ${message.status}; not confirmed sent]\n${text}`
            : text,
        files: text.includes("[Web file]")
          ? []
          : message.attachments.map((file) => {
              return [
                `[WeChat file] ${file.filename} (${file.kind})`,
                `   [ID] ${file.id}`,
                `   [Channel ID] ${args.connectionId}`,
                `   [Message ID] ${message.id}`,
              ].join("\n");
            }),
      };
    }),
  });
}
