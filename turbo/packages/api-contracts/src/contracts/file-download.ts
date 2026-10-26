import { number, object, string, url as zUrl, type infer as zInfer } from "zod";

/** A single-file capability resolved after the API's normal access checks. */
export const fileDownloadUrlSchema = object({
  downloadUrl: zUrl().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  }, "Download URL must use HTTPS without account credentials"),
  filename: string(),
  contentType: string(),
  size: number().int().nonnegative().optional(),
});

export type FileDownloadUrl = zInfer<typeof fileDownloadUrlSchema>;
