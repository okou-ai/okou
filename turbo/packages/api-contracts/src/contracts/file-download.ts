import { z } from "zod";

/** A single-file capability resolved after the API's normal access checks. */
export const fileDownloadUrlSchema = z.object({
  downloadUrl: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  }, "Download URL must use HTTPS without account credentials"),
  filename: z.string(),
  contentType: z.string(),
  size: z.number().int().nonnegative().optional(),
});

export type FileDownloadUrl = z.infer<typeof fileDownloadUrlSchema>;
