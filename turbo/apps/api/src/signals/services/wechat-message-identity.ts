import { createHash } from "node:crypto";

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
