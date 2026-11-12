import { object, string } from "zod";

export const CLOUDFLARE_ACCESS_TOKEN_MAX_LENGTH = 4_096;
// Preserve header bytes while rejecting controls, whitespace and non-ASCII.
const tokenValueSchema = string()
  .min(1)
  .max(CLOUDFLARE_ACCESS_TOKEN_MAX_LENGTH)
  .regex(/^[\x21-\x7e]+$/u);

export const cloudflareAccessCredentialsSchema = object({
  clientId: tokenValueSchema,
  clientSecret: tokenValueSchema,
}).strict();
