import {
  array,
  object,
  string,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

import {
  createSshCredentialRequestSchema,
  updateSshCredentialRequestSchema,
  revisionSchema,
  type sshAuthenticationSchema,
  type sshCredentialSelectionSchema,
} from "../validators/ssh-credentials";
export {
  SSH_DISPLAY_NAME_MAX_LENGTH,
  SSH_USERNAME_MAX_LENGTH,
  SSH_PRIVATE_KEY_MAX_LENGTH,
  SSH_PASSPHRASE_MAX_LENGTH,
  SSH_PASSWORD_MAX_LENGTH,
  sshAuthenticationSchema,
  createSshCredentialRequestSchema,
  updateSshCredentialRequestSchema,
  sshCredentialSelectionSchema,
} from "../validators/ssh-credentials";

export const sshCredentialResponseSchema = object({
  id: uuid(),
  name: string(),
  username: string(),
  authMethod: zEnum(["private_key", "password"]),
  revision: revisionSchema,
  createdAt: string().datetime(),
  updatedAt: string().datetime(),
  hosts: array(object({ id: uuid(), displayName: string() }).strict()),
}).strict();
const c = initContract();
const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  409: apiErrorSchema,
  500: apiErrorSchema,
};
const pathParams = object({ credentialId: uuid() }).strict();
export const sshCredentialsContract = c.router({
  list: {
    method: "GET",
    path: "/api/ssh/credentials",
    headers: authHeadersSchema,
    responses: {
      200: object({ credentials: array(sshCredentialResponseSchema) }).strict(),
      ...errors,
    },
    summary: "List owned SSH credentials without secrets",
  },
  create: {
    method: "POST",
    path: "/api/ssh/credentials",
    headers: authHeadersSchema,
    body: createSshCredentialRequestSchema.extend({ id: uuid() }),
    responses: { 201: sshCredentialResponseSchema, 204: c.noBody(), ...errors },
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
    body: object({ expectedRevision: revisionSchema }).strict(),
    responses: { 204: c.noBody(), ...errors },
    summary: "Delete an unused SSH credential",
  },
});
export type SshAuthentication = zInfer<typeof sshAuthenticationSchema>;
export type CreateSshCredentialRequest = zInfer<
  typeof createSshCredentialRequestSchema
>;
export type UpdateSshCredentialRequest = zInfer<
  typeof updateSshCredentialRequestSchema
>;
export type SshCredentialSelection = zInfer<
  typeof sshCredentialSelectionSchema
>;
export type SshCredentialResponse = zInfer<typeof sshCredentialResponseSchema>;
