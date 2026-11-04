import { literal, object, string, type infer as Infer } from "zod";

export const iosUpgradeRequiredSchema = object({
  error: object({ code: literal("IOS_UPDATE_REQUIRED"), message: string() }),
  minimumSupportedVersion: string().regex(/^\d+\.\d+\.\d+$/u),
});

export type IosUpgradeRequired = Infer<typeof iosUpgradeRequiredSchema>;
