import {
  literal,
  object,
  strictObject,
  string,
  type infer as Infer,
} from "zod";

const version = string()
  .regex(/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){2}$/u)
  .refine((value) => {
    return value.split(".").every((part) => {
      return Number.isSafeInteger(Number(part));
    });
  }, "Expected a stable iOS marketing version");

export const iosBuildIdentitySchema = strictObject({
  version,
  build: string().regex(/^[1-9]\d{0,3}$/u),
  commit: string().regex(/^[a-f0-9]{40}$/u),
});

export const iosCompatibilityPolicySchema = strictObject({
  appStoreMinimumSupportedVersion: version.nullable(),
  testFlightMinimumSupportedVersion: version.nullable(),
});

export type IosCompatibilityPolicy = Infer<typeof iosCompatibilityPolicySchema>;

export const iosUpgradeRequiredSchema = object({
  error: object({ code: literal("IOS_UPDATE_REQUIRED"), message: string() }),
  minimumSupportedVersion: string().regex(/^\d+\.\d+\.\d+$/u),
});

export type IosUpgradeRequired = Infer<typeof iosUpgradeRequiredSchema>;
