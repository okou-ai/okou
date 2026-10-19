import { z } from "zod";
const wechatCdnMediaSchema = z.object({
  encrypt_query_param: z.string().optional(),
  aes_key: z.string().optional(),
  full_url: z.string().optional(),
  encrypt_type: z.number().optional(),
});
export const wechatItemSchema = z.object({
  type: z.number(),
  text_item: z.object({ text: z.string() }).optional(),
  image_item: z
    .object({
      media: wechatCdnMediaSchema.optional(),
      aeskey: z.string().optional(),
      mid_size: z.number().optional(),
    })
    .optional(),
  voice_item: z
    .object({
      media: wechatCdnMediaSchema.optional(),
      text: z.string().optional(),
    })
    .optional(),
  file_item: z
    .object({
      media: wechatCdnMediaSchema.optional(),
      file_name: z.string().optional(),
      len: z.string().optional(),
    })
    .optional(),
  video_item: z
    .object({
      media: wechatCdnMediaSchema.optional(),
      video_size: z.number().optional(),
    })
    .optional(),
  ref_msg: z
    .object({
      title: z.string().optional(),
      message_item: z
        .object({
          type: z.number(),
          text_item: z.object({ text: z.string() }).optional(),
        })
        .optional(),
    })
    .optional(),
});
export const wechatMessageSchema = z.object({
  message_id: z.string().min(1),
  from_user_id: z.string(),
  to_user_id: z.string().optional(),
  group_id: z.string().optional(),
  message_type: z.number(),
  create_time_ms: z.number().int().nonnegative().optional(),
  message_state: z.number().optional(),
  context_token: z.string().optional(),
  item_list: z.array(wechatItemSchema).optional(),
});
export const wechatUpdatesSchema = z.object({
  get_updates_buf: z.string().optional(),
  msgs: z.array(wechatMessageSchema).optional(),
});
export type WechatMessage = z.infer<typeof wechatMessageSchema>;
