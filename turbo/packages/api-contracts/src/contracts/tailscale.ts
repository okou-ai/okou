import {
  array,
  int,
  iso,
  object,
  string,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { vncNetworkHostReferenceSchema } from "./vnc-transport";

import {
  createTailscaleConfigRequestSchema as createBody,
  createTailscaleRequestSchema,
  revision,
  tailscaleTagsSchema,
  updateTailscaleConfigRequestSchema as updateBody,
} from "../validators/tailscale";
export {
  tailscaleChangedPayloadSchema,
  TAILSCALE_CREDENTIAL_MAX_LENGTH,
  tailscaleCredentialsSchema,
  tailscaleTagsSchema,
  createTailscaleConfigRequestSchema,
  createTailscaleRequestSchema,
  updateTailscaleConfigRequestSchema,
} from "../validators/tailscale";
export const tailscaleConfigSchema = object({
  id: uuid(),
  name: string(),
  scope: zEnum(["personal", "organization"]),
  tags: tailscaleTagsSchema,
  revision,
  generation: revision,
  createdAt: iso.datetime(),
  updatedAt: iso.datetime(),
  sshHosts: array(object({ id: uuid(), displayName: string() }).strict()),
  vncHosts: array(vncNetworkHostReferenceSchema),
}).strict();
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
