import { enum as zEnum, type infer as zInfer } from "zod";

export const feishuPlatformSchema = zEnum(["feishu", "lark"]);
export type FeishuPlatform = zInfer<typeof feishuPlatformSchema>;
