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
export const scopedCloudflareAccessConfigSchema =
  cloudflareAccessConfigSchema.extend({
    scope: z.enum(["personal", "organization"]),
  });
const configResponseSchema = scopedCloudflareAccessConfigSchema;
const viewQuery = z.object({ view: z.literal("scoped").optional() }).strict();
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
const createBody = createCloudflareAccessRequestSchema.extend({
  id: z.uuid(),
  scope: z.enum(["personal", "organization"]).optional(),
});
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
const impactSnapshot = z.string().regex(/^[a-f0-9]{64}$/u);
const deleteBody = z
  .object({
    expectedRevision: revision,
    impactSnapshot: impactSnapshot.optional(),
  })
  .strict();
const deletionPreviewSchema = z
  .object({
    expectedRevision: revision,
    ownHostCount: z.int().nonnegative(),
    affectedOwners: z.array(
      z
        .object({
          userId: z.string().min(1),
          displayName: z.string().nullable(),
          hostCount: z.int().positive(),
        })
        .strict(),
    ),
    impactSnapshot,
  })
  .strict();
const conversionPreviewSchema = z
  .object({
    expectedRevision: revision,
    otherHostCount: z.int().nonnegative(),
    impactSnapshot,
  })
  .strict();
// A separate endpoint leaves the older previews intact for already-loaded Apps.
// Unlike the legacy deletion projection, this exposes no per-owner host usage.
const impactPreviewSchema = z
  .object({
    expectedRevision: revision,
    ownHostCount: z.int().nonnegative(),
    otherHostCount: z.int().nonnegative(),
    affectedOwners: z.array(
      z
        .object({
          userId: z.string().min(1),
          displayName: z.string().nullable(),
        })
        .strict(),
    ),
    impactSnapshot,
  })
  .strict();
const conversionBody = z
  .object({ expectedRevision: revision, impactSnapshot })
  .strict();
export const cloudflareAccessContract = c.router({
  list: {
    method: "GET",
    path: "/api/cloudflare-access/configs",
    headers: authHeadersSchema,
    query: viewQuery,
    responses: {
      200: z.object({ configs: z.array(configResponseSchema) }).strict(),
      ...errors,
    },
  },
  create: {
    method: "POST",
    path: "/api/cloudflare-access/configs",
    headers: authHeadersSchema,
    query: viewQuery,
    body: createBody,
    responses: {
      201: configResponseSchema,
      204: c.noBody(),
      ...errors,
    },
  },
  update: {
    method: "PATCH",
    path: "/api/cloudflare-access/configs/:configId",
    headers: authHeadersSchema,
    query: viewQuery,
    pathParams,
    body: updateBody,
    responses: { 200: configResponseSchema, ...errors },
  },
  delete: {
    method: "DELETE",
    path: "/api/cloudflare-access/configs/:configId",
    headers: authHeadersSchema,
    query: viewQuery,
    pathParams,
    body: deleteBody,
    responses: { 204: c.noBody(), ...errors },
  },
  deletionPreview: {
    method: "GET",
    path: "/api/cloudflare-access/configs/:configId/deletion-preview",
    headers: authHeadersSchema,
    pathParams,
    responses: { 200: deletionPreviewSchema, ...errors },
  },
  convertToOrganization: {
    method: "POST",
    path: "/api/cloudflare-access/configs/:configId/convert-to-organization",
    headers: authHeadersSchema,
    pathParams,
    body: z.object({ expectedRevision: revision }).strict(),
    responses: { 200: configResponseSchema, ...errors },
  },
  conversionPreview: {
    method: "GET",
    path: "/api/cloudflare-access/configs/:configId/conversion-preview",
    headers: authHeadersSchema,
    pathParams,
    responses: { 200: conversionPreviewSchema, ...errors },
  },
  impactPreview: {
    method: "GET",
    path: "/api/cloudflare-access/configs/:configId/impact-preview",
    headers: authHeadersSchema,
    pathParams,
    query: z.object({ operation: z.enum(["convert", "delete"]) }).strict(),
    responses: { 200: impactPreviewSchema, ...errors },
  },
  convertToPersonal: {
    method: "POST",
    path: "/api/cloudflare-access/configs/:configId/convert-to-personal",
    headers: authHeadersSchema,
    pathParams,
    body: conversionBody,
    responses: { 200: configResponseSchema, ...errors },
  },
});
export type CloudflareAccessConfig = z.infer<
  typeof cloudflareAccessConfigSchema
>;
export type ScopedCloudflareAccessConfig = z.infer<
  typeof scopedCloudflareAccessConfigSchema
>;
export type CreateCloudflareAccessRequest = z.infer<
  typeof createCloudflareAccessRequestSchema
>;
export type CreateCloudflareAccessConfigRequest = z.infer<typeof createBody>;
export type UpdateCloudflareAccessRequest = z.infer<typeof updateBody>;
export type CloudflareAccessConversionPreview = z.infer<
  typeof conversionPreviewSchema
>;
export type CloudflareAccessImpactPreview = z.infer<typeof impactPreviewSchema>;
export type ConvertCloudflareAccessRequest = z.infer<typeof conversionBody>;
export type CloudflareAccessDeletionPreview = z.infer<
  typeof deletionPreviewSchema
>;
export type DeleteCloudflareAccessRequest = z.infer<typeof deleteBody>;
