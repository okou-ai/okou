import { literal, object, string, type infer as Infer } from "zod";
import { androidVersionSchema } from "../validators/android-version";

export const androidUpgradeRequiredSchema = object({
  error: object({
    code: literal("ANDROID_UPDATE_REQUIRED"),
    message: string(),
  }),
  minimumSupportedVersion: androidVersionSchema,
});

export type AndroidUpgradeRequired = Infer<typeof androidUpgradeRequiredSchema>;
