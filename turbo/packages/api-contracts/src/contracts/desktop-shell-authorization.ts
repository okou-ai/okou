import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

export const desktopShellAuthorizationStatusSchema = z.enum([
  "pending",
  "approved",
  "denied",
  "revoked",
  "expired",
]);

export type DesktopShellAuthorizationStatus = z.infer<
  typeof desktopShellAuthorizationStatusSchema
>;

export const desktopShellAuthorizationSchema = z.object({
  id: z.uuid(),
  chatThreadId: z.uuid(),
  computerUseHostId: z.uuid(),
  computerName: z.string(),
  requestedByRunId: z.uuid(),
  reason: z.string(),
  status: desktopShellAuthorizationStatusSchema,
  requestExpiresAt: z.iso.datetime(),
  approvedAt: z.iso.datetime().nullable(),
  grantExpiresAt: z.iso.datetime().nullable(),
  approvalBlockedReason: z
    .enum(["run_active", "run_unavailable", "chat_busy", "computer_changed"])
    .nullable(),
  authorizationUrl: z.url(),
});

export type DesktopShellAuthorization = z.infer<
  typeof desktopShellAuthorizationSchema
>;

const c = initContract();
const params = z.object({ id: z.uuid() });
const responses = {
  200: desktopShellAuthorizationSchema,
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  409: apiErrorSchema,
  410: apiErrorSchema,
};
const action = {
  method: "POST" as const,
  headers: authHeadersSchema,
  pathParams: params,
  body: z.object({}).strict(),
  responses,
};

export const desktopShellAuthorizationContract = c.router({
  create: {
    method: "POST",
    path: "/api/computer-use/shell/authorizations",
    headers: authHeadersSchema,
    body: z.object({ reason: z.string().trim().min(1).max(500) }).strict(),
    responses,
    summary: "Request one-hour Shell access for the current chat and computer",
  },
  get: {
    method: "GET",
    path: "/api/computer-use/shell/authorizations/:id",
    headers: authHeadersSchema,
    pathParams: params,
    responses,
    summary: "Read the current user's Shell authorization application",
  },
  approve: {
    ...action,
    path: "/api/computer-use/shell/authorizations/:id/approve",
    summary: "Approve one hour and enqueue the next chat round atomically",
  },
  deny: {
    ...action,
    path: "/api/computer-use/shell/authorizations/:id/deny",
    summary: "Deny a pending Shell authorization application",
  },
  revoke: {
    ...action,
    path: "/api/computer-use/shell/authorizations/:id/revoke",
    summary: "Revoke Shell dispatch access without closing native PTYs",
  },
});
