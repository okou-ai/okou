import { object, string, uuid, type infer as zInfer } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import {
  hostAuthorizationSchema,
  hostAuthorizationPermissionsSchema,
} from "./host-authorization";
export const sshAuthorizationSchema = hostAuthorizationSchema.extend({
  username: string(),
});
export type SshAuthorization = zInfer<typeof sshAuthorizationSchema>;

const c = initContract();
const responses = {
  200: sshAuthorizationSchema,
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  409: apiErrorSchema,
  410: apiErrorSchema,
  503: apiErrorSchema,
};
const action = {
  method: "POST" as const,
  headers: authHeadersSchema,
  pathParams: object({ id: uuid() }),
  body: object({}).strict(),
  responses,
};
export const sshAuthorizationContract = c.router({
  create: {
    method: "POST",
    path: "/api/ssh/authorizations",
    headers: authHeadersSchema,
    body: object({
      connectionId: uuid(),
      reason: string().trim().min(1).max(500),
      callbackPrompt: string().trim().min(1).max(200),
      requiredPermissions: hostAuthorizationPermissionsSchema.default([]),
    }).strict(),
    responses,
    summary: "Request access to one SSH host in the current Web Chat",
  },
  get: {
    method: "GET",
    path: "/api/ssh/authorizations/:id",
    headers: authHeadersSchema,
    pathParams: object({ id: uuid() }),
    responses,
    summary: "Review an SSH chat access request",
  },
  approve: {
    ...action,
    path: "/api/ssh/authorizations/:id/approve",
    summary: "Allow this chat to use the requested SSH host and continue",
  },
  deny: {
    ...action,
    path: "/api/ssh/authorizations/:id/deny",
    summary: "Deny an SSH chat access request",
  },
  revoke: {
    ...action,
    path: "/api/ssh/authorizations/:id/revoke",
    summary: "Disable the requested SSH host in this chat",
  },
});
