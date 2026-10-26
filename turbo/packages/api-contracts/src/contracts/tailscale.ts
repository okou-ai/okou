import {
  array,
  int,
  object,
  string,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { vncNetworkHostReferenceSchema } from "./vnc-transport";

export const tailscaleChangedPayloadSchema = object({
  orgId: string().min(1),
}).strict();
export const TAILSCALE_CREDENTIAL_MAX_LENGTH = 4_096;
const credentialValue = string()
  .min(1)
  .max(TAILSCALE_CREDENTIAL_MAX_LENGTH)
  .regex(/^[\x21-\x7e]+$/u);
export const tailscaleCredentialsSchema = object({
  clientId: credentialValue,
  clientSecret: credentialValue,
}).strict();
export const tailscaleTagsSchema = array(
  string().regex(/^tag:[a-z][a-z0-9-]{0,62}$/u),
)
  .min(1)
  .max(16)
  .refine(
    (tags) => {
      return new Set(tags).size === tags.length;
    },
    {
      message: "Tags must be unique",
    },
  );
const revision = int().positive().max(2_147_483_647);
const name = string().trim().min(1).max(128);
export const createTailscaleRequestSchema = object({
  name,
  credentials: tailscaleCredentialsSchema,
  tags: tailscaleTagsSchema,
}).strict();
const createBody = createTailscaleRequestSchema.extend({
  id: uuid(),
  scope: zEnum(["personal", "organization"]).optional(),
});
export const tailscaleConfigSchema = object({
  id: uuid(),
  name: string(),
  scope: zEnum(["personal", "organization"]),
  tags: tailscaleTagsSchema,
  revision,
  generation: revision,
  createdAt: string().datetime(),
  updatedAt: string().datetime(),
  sshHosts: array(object({ id: uuid(), displayName: string() }).strict()),
  vncHosts: array(vncNetworkHostReferenceSchema),
}).strict();
const updateBody = object({
  expectedRevision: revision,
  name: name.optional(),
  credentials: tailscaleCredentialsSchema.optional(),
  tags: tailscaleTagsSchema.optional(),
})
  .strict()
  .refine(
    (body) => {
      return (
        body.name !== undefined ||
        body.credentials !== undefined ||
        body.tags !== undefined
      );
    },
    { message: "At least one Tailscale field must be updated" },
  );
const impactSnapshot = string().regex(/^[a-f0-9]{64}$/u);
const deleteBody = object({
  expectedRevision: revision,
  impactSnapshot: impactSnapshot.optional(),
}).strict();
const conversionBody = object({
  expectedRevision: revision,
  impactSnapshot,
}).strict();
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
const c = initContract();
const pathParams = object({ configId: uuid() }).strict();
const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  409: apiErrorSchema,
  500: apiErrorSchema,
};
export const tailscaleContract = c.router({
  list: {
    method: "GET",
    path: "/api/tailscale/configs",
    headers: authHeadersSchema,
    responses: {
      200: object({ configs: array(tailscaleConfigSchema) }).strict(),
      ...errors,
    },
  },
  create: {
    method: "POST",
    path: "/api/tailscale/configs",
    headers: authHeadersSchema,
    body: createBody,
    responses: { 201: tailscaleConfigSchema, 204: c.noBody(), ...errors },
  },
  update: {
    method: "PATCH",
    path: "/api/tailscale/configs/:configId",
    headers: authHeadersSchema,
    pathParams,
    body: updateBody,
    responses: { 200: tailscaleConfigSchema, ...errors },
  },
  delete: {
    method: "DELETE",
    path: "/api/tailscale/configs/:configId",
    headers: authHeadersSchema,
    pathParams,
    body: deleteBody,
    responses: { 204: c.noBody(), ...errors },
  },
  convertToOrganization: {
    method: "POST",
    path: "/api/tailscale/configs/:configId/convert-to-organization",
    headers: authHeadersSchema,
    pathParams,
    body: object({ expectedRevision: revision }).strict(),
    responses: { 200: tailscaleConfigSchema, ...errors },
  },
  impactPreview: {
    method: "GET",
    path: "/api/tailscale/configs/:configId/impact-preview",
    headers: authHeadersSchema,
    pathParams,
    query: object({ operation: zEnum(["convert", "delete"]) }).strict(),
    responses: { 200: impactPreviewSchema, ...errors },
  },
  convertToPersonal: {
    method: "POST",
    path: "/api/tailscale/configs/:configId/convert-to-personal",
    headers: authHeadersSchema,
    pathParams,
    body: conversionBody,
    responses: { 200: tailscaleConfigSchema, ...errors },
  },
});
export type TailscaleConfig = zInfer<typeof tailscaleConfigSchema>;
export type TailscaleImpactPreview = zInfer<typeof impactPreviewSchema>;
export type CreateTailscaleRequest = zInfer<
  typeof createTailscaleRequestSchema
>;
export type CreateTailscaleConfigRequest = zInfer<typeof createBody>;
export type UpdateTailscaleRequest = zInfer<typeof updateBody>;
export type DeleteTailscaleRequest = zInfer<typeof deleteBody>;
export type ConvertTailscaleRequest = zInfer<typeof conversionBody>;
