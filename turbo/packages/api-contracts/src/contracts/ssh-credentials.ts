import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

export const SSH_DISPLAY_NAME_MAX_LENGTH = 128;
export const SSH_USERNAME_MAX_LENGTH = 255;
export const SSH_PRIVATE_KEY_MAX_LENGTH = 65_536;
export const SSH_PASSPHRASE_MAX_LENGTH = 4_096;
export const SSH_PASSWORD_MAX_LENGTH = 4_096;

export const sshAuthenticationSchema = z.discriminatedUnion("method", [
  z
    .object({
      method: z.literal("private_key"),
      privateKey: z.string().min(1).max(SSH_PRIVATE_KEY_MAX_LENGTH),
      passphrase: z
        .string()
        .min(1)
        .max(SSH_PASSPHRASE_MAX_LENGTH)
        .nullable()
        .default(null),
    })
    .strict(),
  z
    .object({
      method: z.literal("password"),
      password: z.string().min(1).max(SSH_PASSWORD_MAX_LENGTH),
    })
    .strict(),
]);
const nameSchema = z.string().trim().min(1).max(SSH_DISPLAY_NAME_MAX_LENGTH);
const usernameSchema = z.string().trim().min(1).max(SSH_USERNAME_MAX_LENGTH);
const revisionSchema = z.int().positive().max(2_147_483_647);

export const createSshCredentialRequestSchema = z
  .object({
    name: nameSchema,
    username: usernameSchema,
    authentication: sshAuthenticationSchema,
  })
  .strict();
export const updateSshCredentialRequestSchema = z
  .object({
    expectedRevision: revisionSchema,
    name: nameSchema.optional(),
    username: usernameSchema.optional(),
    authentication: sshAuthenticationSchema.optional(),
  })
  .strict()
  .refine(
    (value) => {
      return (
        value.name !== undefined ||
        value.username !== undefined ||
        value.authentication !== undefined
      );
    },
    { message: "At least one SSH credential field must be updated" },
  );

export const sshCredentialSelectionSchema = z.union([
  z.object({ id: z.uuid() }).strict(),
  z.object({ create: createSshCredentialRequestSchema }).strict(),
]);
export const sshCredentialResponseSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    username: z.string(),
    authMethod: z.enum(["private_key", "password"]),
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
export const sshCredentialsContract = c.router({
  list: {
    method: "GET",
    path: "/api/ssh/credentials",
    headers: authHeadersSchema,
    responses: {
      200: z
        .object({ credentials: z.array(sshCredentialResponseSchema) })
        .strict(),
      ...errors,
    },
    summary: "List owned SSH credentials without secrets",
  },
  create: {
    method: "POST",
    path: "/api/ssh/credentials",
    headers: authHeadersSchema,
    body: createSshCredentialRequestSchema,
    responses: { 201: sshCredentialResponseSchema, ...errors },
    summary: "Create a reusable SSH credential",
  },
  update: {
    method: "PATCH",
    path: "/api/ssh/credentials/:credentialId",
    headers: authHeadersSchema,
    pathParams,
    body: updateSshCredentialRequestSchema,
    responses: { 200: sshCredentialResponseSchema, ...errors },
    summary: "Update a shared SSH credential",
  },
  delete: {
    method: "DELETE",
    path: "/api/ssh/credentials/:credentialId",
    headers: authHeadersSchema,
    pathParams,
    body: z.object({ expectedRevision: revisionSchema }).strict(),
    responses: { 204: c.noBody(), ...errors },
    summary: "Delete an unused SSH credential",
  },
});
export type SshAuthentication = z.infer<typeof sshAuthenticationSchema>;
export type CreateSshCredentialRequest = z.infer<
  typeof createSshCredentialRequestSchema
>;
export type UpdateSshCredentialRequest = z.infer<
  typeof updateSshCredentialRequestSchema
>;
export type SshCredentialSelection = z.infer<
  typeof sshCredentialSelectionSchema
>;
export type SshCredentialResponse = z.infer<typeof sshCredentialResponseSchema>;
