import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

export const CLOUDFLARE_ACCESS_TOKEN_MAX_LENGTH = 4_096;
// Service-token values become HTTP headers. Preserve bytes, but reject controls,
// whitespace and non-ASCII rather than silently changing the credential.
const tokenValueSchema = z
  .string()
  .min(1)
  .max(CLOUDFLARE_ACCESS_TOKEN_MAX_LENGTH)
  .regex(/^[\x21-\x7e]+$/u);
export const cloudflareAccessCredentialsSchema = z
  .object({
    clientId: tokenValueSchema,
    clientSecret: tokenValueSchema,
  })
  .strict();
const revision = z.int().positive().max(2_147_483_647);
const name = z.string().trim().min(1).max(128);
export const createCloudflareAccessRequestSchema = z
  .object({ name, credentials: cloudflareAccessCredentialsSchema })
  .strict();
const cloudflareAccessConfigMetadataSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    revision,
    generation: revision,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
const sshHostReferenceSchema = z
  .object({ id: z.uuid(), displayName: z.string() })
  .strict();
export const cloudflareAccessConfigSchema = cloudflareAccessConfigMetadataSchema
  .extend({ sshHosts: z.array(sshHostReferenceSchema) })
  .strict();
export const sshCloudflareAccessConfigSchema =
  cloudflareAccessConfigMetadataSchema
    .extend({ hosts: z.array(sshHostReferenceSchema) })
    .strict();
const c = initContract();
const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  409: apiErrorSchema,
  500: apiErrorSchema,
};
const pathParams = z.object({ configId: z.uuid() }).strict();
const createBody = createCloudflareAccessRequestSchema.extend({ id: z.uuid() });
const updateBody = z
  .object({
    expectedRevision: revision,
    name: name.optional(),
    credentials: cloudflareAccessCredentialsSchema.optional(),
  })
  .strict()
  .refine(
    (body) => {
      return body.name !== undefined || body.credentials !== undefined;
    },
    { message: "At least one Cloudflare Access field must be updated" },
  );
const deleteBody = z.object({ expectedRevision: revision }).strict();
export const cloudflareAccessContract = c.router({
  list: {
    method: "GET",
    path: "/api/cloudflare-access/configs",
    headers: authHeadersSchema,
    responses: {
      200: z
        .object({ configs: z.array(cloudflareAccessConfigSchema) })
        .strict(),
      ...errors,
    },
  },
  create: {
    method: "POST",
    path: "/api/cloudflare-access/configs",
    headers: authHeadersSchema,
    body: createBody,
    responses: {
      201: cloudflareAccessConfigSchema,
      204: c.noBody(),
      ...errors,
    },
  },
  update: {
    method: "PATCH",
    path: "/api/cloudflare-access/configs/:configId",
    headers: authHeadersSchema,
    pathParams,
    body: updateBody,
    responses: { 200: cloudflareAccessConfigSchema, ...errors },
  },
  delete: {
    method: "DELETE",
    path: "/api/cloudflare-access/configs/:configId",
    headers: authHeadersSchema,
    pathParams,
    body: deleteBody,
    responses: { 204: c.noBody(), ...errors },
  },
});
// The deployed SSH settings page temporarily needs this projection. #36038
// moves it to the neutral contract before #36068 removes this rollout bridge.
export const sshCloudflareAccessContract = c.router({
  list: {
    method: "GET",
    path: "/api/ssh/cloudflare-access/configs",
    headers: authHeadersSchema,
    responses: {
      200: z
        .object({ configs: z.array(sshCloudflareAccessConfigSchema) })
        .strict(),
      ...errors,
    },
  },
  create: {
    method: "POST",
    path: "/api/ssh/cloudflare-access/configs",
    headers: authHeadersSchema,
    body: createBody,
    responses: {
      201: sshCloudflareAccessConfigSchema,
      204: c.noBody(),
      ...errors,
    },
  },
  update: {
    method: "PATCH",
    path: "/api/ssh/cloudflare-access/configs/:configId",
    headers: authHeadersSchema,
    pathParams,
    body: updateBody,
    responses: { 200: sshCloudflareAccessConfigSchema, ...errors },
  },
  delete: {
    method: "DELETE",
    path: "/api/ssh/cloudflare-access/configs/:configId",
    headers: authHeadersSchema,
    pathParams,
    body: deleteBody,
    responses: { 204: c.noBody(), ...errors },
  },
});
export type CloudflareAccessConfig = z.infer<
  typeof cloudflareAccessConfigSchema
>;
export type SshCloudflareAccessConfig = z.infer<
  typeof sshCloudflareAccessConfigSchema
>;
export type CreateCloudflareAccessRequest = z.infer<
  typeof createCloudflareAccessRequestSchema
>;
export type UpdateCloudflareAccessRequest = z.infer<typeof updateBody>;
