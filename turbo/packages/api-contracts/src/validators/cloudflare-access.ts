import { array, int, iso, object, string, uuid, enum as zEnum } from "zod";

import { vncNetworkHostReferenceSchema } from "../contracts/vnc-transport";
import { cloudflareCustomConnectorReferenceSchema } from "./custom-connector-network";
import { cloudflareAccessCredentialsSchema } from "./cloudflare-access-credentials";
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
  createdAt: iso.datetime(),
  updatedAt: iso.datetime(),
}).strict();
const sshHostReferenceSchema = object({
  id: uuid(),
  displayName: string(),
}).strict();
export const cloudflareAccessConfigSchema = cloudflareAccessConfigMetadataSchema
  .extend({
    customConnectors: array(
      cloudflareCustomConnectorReferenceSchema,
    ).optional(),
    sshHosts: array(sshHostReferenceSchema),
    vncHosts: array(vncNetworkHostReferenceSchema),
  })
  .strict();
export const scopedCloudflareAccessConfigSchema =
  cloudflareAccessConfigSchema.extend({
    scope: zEnum(["personal", "organization"]),
  });
