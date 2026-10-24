import { z } from "zod";
export {
  socialKitRequestSchema,
  socialKitSummaryFieldsSchema,
  SOCIALKIT_MAX_INPUT_VALUE_CHARS,
  type SocialKitRequest,
  type ManagedSocialKitToolName,
} from "./social-tools";
export const socialKitDownloadPlatformSchema = z.enum([
  "youtube",
  "tiktok",
  "instagram",
  "facebook",
]);

export const socialKitDownloadQualitySchema = z.enum([
  "240p",
  "360p",
  "480p",
  "720p",
  "1080p",
]);

export const socialKitDownloadFormatSchema = z.enum(["mp4", "m4a", "mp3"]);

export const socialKitDownloadRequestSchema = z
  .object({
    platform: socialKitDownloadPlatformSchema,
    url: z
      .url()
      .max(4096)
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          url.username === "" &&
          url.password === ""
        );
      }, "URL must use HTTPS without embedded credentials"),
    maxDuration: z.number().int().positive().max(86_400),
    quality: socialKitDownloadQualitySchema.default("720p"),
    format: socialKitDownloadFormatSchema.default("mp4"),
  })
  .strict();

export const socialKitDownloadStatusSchema = z.enum([
  "queued",
  "processing",
  "link_failed",
  "provider_failed",
  "completed",
]);

export const socialKitDownloadListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().uuid().optional(),
  status: z
    .enum([...socialKitDownloadStatusSchema.options, "active"])
    .optional(),
});
