import {
  array,
  int,
  literal,
  object,
  string,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { vncNetworkHostReferenceSchema } from "./vnc-transport";

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
const revision = int().positive().max(2_147_483_647);
const name = string().trim().min(1).max(128);
export const createCloudflareAccessRequestSchema = object({
  name,
  credentials: cloudflareAccessCredentialsSchema,
}).strict();
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
const configResponseSchema = scopedCloudflareAccessConfigSchema;
const viewQuery = object({ view: literal("scoped").optional() }).strict();
const c = initContract();
const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  409: apiErrorSchema,
  500: apiErrorSchema,
};
const pathParams = object({ configId: uuid() }).strict();
const createBody = createCloudflareAccessRequestSchema.extend({
  id: uuid(),
  scope: zEnum(["personal", "organization"]).optional(),
});
const updateBody = object({
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
const impactSnapshot = string().regex(/^[a-f0-9]{64}$/u);
const deleteBody = object({
  expectedRevision: revision,
  impactSnapshot: impactSnapshot.optional(),
}).strict();
// Only aggregate host usage is exposed to the reviewing administrator.
const impactPreviewSchema = object({
  expectedRevision: revision,
  ownHostCount: int().nonnegative(),
  otherHostCount: int().nonnegative(),
  affectedOwners: array(
    object({
      userId: string().min(1),
      displayName: string().nullable(),
    }).strict(),
  ),
  impactSnapshot,
}).strict();
const conversionBody = object({
  expectedRevision: revision,
  impactSnapshot,
}).strict();
export const cloudflareAccessContract = c.router({
  list: {
    method: "GET",
    path: "/api/cloudflare-access/configs",
    headers: authHeadersSchema,
    query: viewQuery,
    responses: {
      200: object({ configs: array(configResponseSchema) }).strict(),
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
  convertToOrganization: {
    method: "POST",
    path: "/api/cloudflare-access/configs/:configId/convert-to-organization",
    headers: authHeadersSchema,
    pathParams,
    body: object({ expectedRevision: revision }).strict(),
    responses: { 200: configResponseSchema, ...errors },
  },
  impactPreview: {
    method: "GET",
    path: "/api/cloudflare-access/configs/:configId/impact-preview",
    headers: authHeadersSchema,
    pathParams,
    query: object({ operation: zEnum(["convert", "delete"]) }).strict(),
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
export type CloudflareAccessConfig = zInfer<
  typeof cloudflareAccessConfigSchema
>;
export type ScopedCloudflareAccessConfig = zInfer<
  typeof scopedCloudflareAccessConfigSchema
>;
export type CreateCloudflareAccessRequest = zInfer<
  typeof createCloudflareAccessRequestSchema
>;
export type CreateCloudflareAccessConfigRequest = zInfer<typeof createBody>;
export type UpdateCloudflareAccessRequest = zInfer<typeof updateBody>;
export type CloudflareAccessImpactPreview = zInfer<typeof impactPreviewSchema>;
export type ConvertCloudflareAccessRequest = zInfer<typeof conversionBody>;
export type DeleteCloudflareAccessRequest = zInfer<typeof deleteBody>;
