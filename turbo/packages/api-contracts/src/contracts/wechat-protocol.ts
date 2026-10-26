import { array, number, object, string, type infer as zInfer } from "zod";

const wechatCdnMediaSchema = object({
  encrypt_query_param: string().optional(),
  aes_key: string().optional(),
  full_url: string().optional(),
  encrypt_type: number().optional(),
});
export const wechatItemSchema = object({
  type: number(),
  text_item: object({ text: string() }).optional(),
  image_item: object({
    media: wechatCdnMediaSchema.optional(),
    aeskey: string().optional(),
    mid_size: number().optional(),
  }).optional(),
  voice_item: object({
    media: wechatCdnMediaSchema.optional(),
    text: string().optional(),
  }).optional(),
  file_item: object({
    media: wechatCdnMediaSchema.optional(),
    file_name: string().optional(),
    len: string().optional(),
  }).optional(),
  video_item: object({
    media: wechatCdnMediaSchema.optional(),
    video_size: number().optional(),
  }).optional(),
  ref_msg: object({
    title: string().optional(),
    message_item: object({
      type: number(),
      text_item: object({ text: string() }).optional(),
    }).optional(),
  }).optional(),
});
export const wechatMessageSchema = object({
  message_id: string().min(1),
  from_user_id: string(),
  to_user_id: string().optional(),
  group_id: string().optional(),
  message_type: number(),
  create_time_ms: number().int().nonnegative().optional(),
  message_state: number().optional(),
  context_token: string().optional(),
  item_list: array(wechatItemSchema).optional(),
});
export const wechatUpdatesSchema = object({
  get_updates_buf: string().optional(),
  msgs: array(wechatMessageSchema).optional(),
});
export type WechatMessage = zInfer<typeof wechatMessageSchema>;
