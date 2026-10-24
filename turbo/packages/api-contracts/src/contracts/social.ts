import { z } from "zod";
export {
  socialToolRequestSchema,
  socialSummaryFieldsSchema,
  SOCIAL_MAX_INPUT_VALUE_CHARS,
  type SocialToolRequest,
  type SocialToolName,
} from "./social-tools";
export const socialDownloadPlatformSchema = z.enum([
  "youtube",
  "tiktok",
  "instagram",
  "facebook",
]);

export const socialDownloadQualitySchema = z.enum([
  "240p",
  "360p",
  "480p",
  "720p",
  "1080p",
]);

export const socialDownloadFormatSchema = z.enum(["mp4", "m4a", "mp3"]);

export const socialDownloadRequestSchema = z
  .object({
    platform: socialDownloadPlatformSchema,
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
    quality: socialDownloadQualitySchema.default("720p"),
    format: socialDownloadFormatSchema.default("mp4"),
  })
  .strict();

export const socialDownloadStatusSchema = z.enum([
  "queued",
  "processing",
  "link_failed",
  "provider_failed",
  "completed",
]);

export const socialDownloadListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().uuid().optional(),
  status: z.enum([...socialDownloadStatusSchema.options, "active"]).optional(),
});
