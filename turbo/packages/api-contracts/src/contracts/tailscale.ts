import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

export const tailscaleChangedPayloadSchema = z
  .object({ orgId: z.string().min(1) })
  .strict();
export const TAILSCALE_CREDENTIAL_MAX_LENGTH = 4_096;
const credentialValue = z
  .string()
  .min(1)
  .max(TAILSCALE_CREDENTIAL_MAX_LENGTH)
  .regex(/^[\x21-\x7e]+$/u);
export const tailscaleCredentialsSchema = z
  .object({ clientId: credentialValue, clientSecret: credentialValue })
  .strict();
export const tailscaleTagsSchema = z
  .array(z.string().regex(/^tag:[a-z][a-z0-9-]{0,62}$/u))
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
const revision = z.int().positive().max(2_147_483_647);
const name = z.string().trim().min(1).max(128);
export const createTailscaleRequestSchema = z
  .object({
    id: z.uuid(),
    name,
    credentials: tailscaleCredentialsSchema,
    tags: tailscaleTagsSchema,
  })
  .strict();
const createBody = createTailscaleRequestSchema.extend({
  scope: z.enum(["personal", "organization"]).optional(),
});
export const tailscaleConfigSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    scope: z.enum(["personal", "organization"]),
    tags: tailscaleTagsSchema,
    enabled: z.boolean(),
    revision,
    generation: revision,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    sshHosts: z.array(
      z.object({ id: z.uuid(), displayName: z.string() }).strict(),
    ),
  })
  .strict();
const updateBody = z
  .object({
    expectedRevision: revision,
    name: name.optional(),
    credentials: tailscaleCredentialsSchema.optional(),
    tags: tailscaleTagsSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine(
    (body) => {
      return (
        body.name !== undefined ||
        body.credentials !== undefined ||
        body.tags !== undefined ||
        body.enabled !== undefined
      );
    },
    { message: "At least one Tailscale field must be updated" },
  );
const c = initContract();
const pathParams = z.object({ configId: z.uuid() }).strict();
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
      200: z.object({ configs: z.array(tailscaleConfigSchema) }).strict(),
      ...errors,
    },
  },
  get: {
    method: "GET",
    path: "/api/tailscale/configs/:configId",
    headers: authHeadersSchema,
    pathParams,
    responses: { 200: tailscaleConfigSchema, ...errors },
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
    body: z.object({ expectedRevision: revision }).strict(),
    responses: { 204: c.noBody(), ...errors },
  },
});
export type TailscaleConfig = z.infer<typeof tailscaleConfigSchema>;
export type CreateTailscaleRequest = z.infer<
  typeof createTailscaleRequestSchema
>;
export type CreateTailscaleConfigRequest = z.infer<typeof createBody>;
export type UpdateTailscaleRequest = z.infer<typeof updateBody>;
