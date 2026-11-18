import { array, boolean, object, string } from "zod";

export const feishuHistoryMessageSchema = object({
  message_id: string(),
  root_id: string().optional(),
  parent_id: string().optional(),
  thread_id: string().optional(),
  msg_type: string(),
  create_time: string().optional(),
  deleted: boolean().optional(),
  chat_id: string().optional(),
  sender: object({
    id: string().optional(),
    id_type: string().optional(),
    sender_type: string().optional(),
    sender_name: string().optional(),
  }).optional(),
  body: object({ content: string().optional() }).optional(),
  mentions: array(
    object({
      key: string().optional(),
      id: string().optional(),
      name: string().optional(),
    }),
  ).optional(),
});
