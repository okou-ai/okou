import { array, int, object, string, uuid, enum as zEnum } from "zod";

import { vncNetworkHostReferenceSchema } from "../contracts/vnc-transport";

export const CLOUDFLARE_ACCESS_TOKEN_MAX_LENGTH = 4_096;
// Service-token values become HTTP headers. Preserve bytes, but reject controls,
// whitespace and non-ASCII rather than silently changing the credential.
const tokenValueSchema = string()
  .min(1)
  .max(CLOUDFLARE_ACCESS_TOKEN_MAX_LENGTH)
  .regex(/^[\x21-\x7e]+$/u);
export const cloudflareAccessCredentialsSchema = object({
  clientId: tokenValueSchema,
  clientSecret: tokenValueSchema,
}).strict();
export const name = string().trim().min(1).max(128);
export const createCloudflareAccessRequestSchema = object({
  name,
  credentials: cloudflareAccessCredentialsSchema,
}).strict();
export const createCloudflareAccessConfigRequestSchema =
  createCloudflareAccessRequestSchema.extend({
    id: uuid(),
    scope: zEnum(["personal", "organization"]).optional(),
  });

export const revision = int().positive().max(2_147_483_647);
const cloudflareAccessConfigMetadataSchema = object({
  id: uuid(),
  name: string(),
  revision,
  generation: revision,
  createdAt: string().datetime(),
  updatedAt: string().datetime(),
}).strict();
const sshHostReferenceSchema = object({
  id: uuid(),
  displayName: string(),
}).strict();
export const cloudflareAccessConfigSchema = cloudflareAccessConfigMetadataSchema
  .extend({
    sshHosts: array(sshHostReferenceSchema),
    vncHosts: array(vncNetworkHostReferenceSchema),
  })
  .strict();
export const scopedCloudflareAccessConfigSchema =
  cloudflareAccessConfigSchema.extend({
    scope: zEnum(["personal", "organization"]),
  });
