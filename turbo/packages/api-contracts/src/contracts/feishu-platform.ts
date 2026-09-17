import { z } from "zod";

export const feishuPlatformSchema = z.enum(["feishu", "lark"]);
export type FeishuPlatform = z.infer<typeof feishuPlatformSchema>;
