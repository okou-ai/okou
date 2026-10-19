import { createHash } from "node:crypto";
import type { WechatMessage } from "@okouai/api-contracts/contracts/wechat-protocol";

export function isWechatOwnerMessage(
  connection: { readonly senderId: string; readonly botId: string },
  message: WechatMessage,
): message is WechatMessage & { context_token: string } {
  return (
    message.message_type === 1 &&
    message.from_user_id === connection.senderId &&
    !message.group_id &&
    (!message.to_user_id || message.to_user_id === connection.botId) &&
    !!message.context_token
  );
}

export function wechatEventId(
  connectionId: string,
  generation: string,
  messageId: string,
) {
  const hex = createHash("sha256")
    .update(JSON.stringify(["wechat", connectionId, generation, messageId]))
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
