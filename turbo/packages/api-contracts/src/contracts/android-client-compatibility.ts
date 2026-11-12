import { literal, object, string, type infer as Infer } from "zod";

export const androidUpgradeRequiredSchema = object({
  error: object({
    code: literal("ANDROID_UPDATE_REQUIRED"),
    message: string(),
  }),
  minimumSupportedVersion: string().regex(/^\d+\.\d+\.\d+$/u),
});

export type AndroidUpgradeRequired = Infer<typeof androidUpgradeRequiredSchema>;
