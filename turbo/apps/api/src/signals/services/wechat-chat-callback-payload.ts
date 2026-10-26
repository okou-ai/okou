import { object, string, uuid, type infer as zInfer } from "zod";

export const wechatDeliveryTargetSchema = object({
  connectionId: uuid(),
  generation: uuid(),
  contextId: uuid(),
  senderId: string(),
  messageId: string(),
});
export type WechatDeliveryTarget = zInfer<typeof wechatDeliveryTargetSchema>;
