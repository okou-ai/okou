import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

export const VNC_DISPLAY_NAME_MAX_LENGTH = 128;
export const VNC_PASSWORD_MAX_LENGTH = 8;

const nameSchema = z.string().trim().min(1).max(VNC_DISPLAY_NAME_MAX_LENGTH);
export const vncAuthenticationSchema = z.discriminatedUnion("method", [
  z
    .object({
      method: z.literal("vnc_password"),
      password: z
        .string()
        .min(1)
        .max(VNC_PASSWORD_MAX_LENGTH)
        .refine((value) => {
          return !/[^\x20-\x7e]/u.test(value);
        }, "VNC passwords require printable ASCII bytes"),
    })
    .strict(),
]);
const revisionSchema = z.int().positive().max(2_147_483_647);

export const createVncCredentialRequestSchema = z
  .object({ name: nameSchema, authentication: vncAuthenticationSchema })
  .strict();

export const updateVncCredentialRequestSchema = z
  .object({
    expectedRevision: revisionSchema,
    name: nameSchema.optional(),
    authentication: vncAuthenticationSchema.optional(),
  })
  .strict()
  .refine(
    (value) => {
      return value.name !== undefined || value.authentication !== undefined;
    },
    { message: "At least one VNC credential field must be updated" },
  );

export const vncCredentialSelectionSchema = z.union([
  z.object({ id: z.uuid() }).strict(),
  z.object({ create: createVncCredentialRequestSchema }).strict(),
]);

export const vncCredentialResponseSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    authMethod: z.literal("vnc_password"),
    revision: revisionSchema,
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
const pathParams = z.object({ credentialId: z.uuid() }).strict();

export const vncCredentialsContract = c.router({
  list: {
    method: "GET",
    path: "/api/vnc/credentials",
    headers: authHeadersSchema,
    responses: {
      200: z
        .object({ credentials: z.array(vncCredentialResponseSchema) })
        .strict(),
      ...errors,
    },
    summary: "List owned VNC credentials without secrets",
  },
  create: {
    method: "POST",
    path: "/api/vnc/credentials",
    headers: authHeadersSchema,
    body: createVncCredentialRequestSchema.extend({ id: z.uuid() }),
    responses: { 201: vncCredentialResponseSchema, 204: c.noBody(), ...errors },
    summary: "Create a reusable VNC credential",
  },
  update: {
    method: "PATCH",
    path: "/api/vnc/credentials/:credentialId",
    headers: authHeadersSchema,
    pathParams,
    body: updateVncCredentialRequestSchema,
    responses: { 200: vncCredentialResponseSchema, ...errors },
    summary: "Update an owned VNC credential",
  },
  delete: {
    method: "DELETE",
    path: "/api/vnc/credentials/:credentialId",
    headers: authHeadersSchema,
    pathParams,
    body: z.object({ expectedRevision: revisionSchema }).strict(),
    responses: { 204: c.noBody(), ...errors },
    summary: "Delete an unused VNC credential",
  },
});

export type VncAuthentication = z.infer<typeof vncAuthenticationSchema>;
export type CreateVncCredentialRequest = z.infer<
  typeof createVncCredentialRequestSchema
>;
export type UpdateVncCredentialRequest = z.infer<
  typeof updateVncCredentialRequestSchema
>;
export type VncCredentialSelection = z.infer<
  typeof vncCredentialSelectionSchema
>;
export type VncCredentialResponse = z.infer<typeof vncCredentialResponseSchema>;
