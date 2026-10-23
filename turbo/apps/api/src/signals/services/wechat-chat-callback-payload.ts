import * as z from "zod";
export const wechatDeliveryTargetSchema = z.object({
  connectionId: z.uuid(),
  generation: z.uuid(),
  contextId: z.uuid(),
  senderId: z.string(),
  messageId: z.string(),
});
export type WechatDeliveryTarget = z.infer<typeof wechatDeliveryTargetSchema>;
