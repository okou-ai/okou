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
export const cloudflareAccessConfigSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    revision,
    generation: revision,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    hosts: z.array(
      z.object({ id: z.uuid(), displayName: z.string() }).strict(),
    ),
  })
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
export const cloudflareAccessContract = c.router({
  list: {
    method: "GET",
    path: "/api/ssh/cloudflare-access/configs",
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
    path: "/api/ssh/cloudflare-access/configs",
    headers: authHeadersSchema,
    body: createCloudflareAccessRequestSchema.extend({
      saveAttemptId: z.uuid(),
    }),
    responses: { 201: cloudflareAccessConfigSchema, ...errors },
  },
  update: {
    method: "PATCH",
    path: "/api/ssh/cloudflare-access/configs/:configId",
    headers: authHeadersSchema,
    pathParams,
    body: z
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
      ),
    responses: { 200: cloudflareAccessConfigSchema, ...errors },
  },
  delete: {
    method: "DELETE",
    path: "/api/ssh/cloudflare-access/configs/:configId",
    headers: authHeadersSchema,
    pathParams,
    body: z.object({ expectedRevision: revision }).strict(),
    responses: { 204: c.noBody(), ...errors },
  },
});
export type CloudflareAccessConfig = z.infer<
  typeof cloudflareAccessConfigSchema
>;
export type CreateCloudflareAccessRequest = z.infer<
  typeof createCloudflareAccessRequestSchema
>;
export type UpdateCloudflareAccessRequest = z.infer<
  typeof cloudflareAccessContract.update.body
>;
