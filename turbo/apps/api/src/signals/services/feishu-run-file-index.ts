import {
  array,
  object,
  string,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

export const FEISHU_RUN_FILE_INDEX_KIND = "feishu:org";

export const feishuRunFileSchema = object({
  fileId: string().min(1),
  messageId: string().min(1),
  fileKey: string().min(1),
  type: zEnum(["file", "image"]),
});

export const feishuRunFileIndexSchema = object({
  installationId: uuid(),
  chatId: string(),
  messageId: string(),
  connectionId: string(),
  files: array(feishuRunFileSchema).optional(),
});

export type FeishuRunFileIndex = zInfer<typeof feishuRunFileIndexSchema>;
