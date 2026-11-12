import {
  array,
  boolean,
  object,
  string,
  uuid,
  type infer as zInfer,
} from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import {
  hostAuthorizationSchema,
  hostAuthorizationPermissionsSchema,
} from "./host-authorization";

export const vncAuthorizationSchema = hostAuthorizationSchema.extend({
  requiredSshHosts: array(
    object({
      connectionId: uuid(),
      displayName: string(),
      enabled: boolean(),
    }).strict(),
  ),
});
export type VncAuthorization = zInfer<typeof vncAuthorizationSchema>;

const c = initContract();
const responses = {
  200: vncAuthorizationSchema,
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
export const vncAuthorizationContract = c.router({
  create: {
    method: "POST",
    path: "/api/vnc/authorizations",
    headers: authHeadersSchema,
    body: object({
      connectionId: uuid(),
      reason: string().trim().min(1).max(500),
      callbackPrompt: string().trim().min(1).max(200),
      requiredPermissions: hostAuthorizationPermissionsSchema.default([]),
    }).strict(),
    responses,
    summary: "Request access to one VNC host in the current Web Chat",
  },
  get: {
    method: "GET",
    path: "/api/vnc/authorizations/:id",
    headers: authHeadersSchema,
    pathParams: object({ id: uuid() }),
    responses,
    summary: "Review a VNC chat access request",
  },
  approve: {
    ...action,
    path: "/api/vnc/authorizations/:id/approve",
    summary: "Allow this chat to use the requested VNC host and continue",
  },
  deny: {
    ...action,
    path: "/api/vnc/authorizations/:id/deny",
    summary: "Deny a VNC chat access request",
  },
  revoke: {
    ...action,
    path: "/api/vnc/authorizations/:id/revoke",
    summary: "Disable the requested VNC host in this chat",
  },
});
