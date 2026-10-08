import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();
const protocolSchema = z.enum(["ssh", "vnc"]);
export const initialRemoteAccessOverrideSchema = z
  .object({
    protocol: protocolSchema,
    connectionId: z.uuid(),
    enabled: z.boolean(),
  })
  .strict();
export type InitialRemoteAccessOverride = z.infer<
  typeof initialRemoteAccessOverrideSchema
>;
const hostParamsSchema = z
  .object({ protocol: protocolSchema, connectionId: z.uuid() })
  .strict();
const threadParamsSchema = z.object({ threadId: z.uuid() }).strict();
const threadHostParamsSchema = threadParamsSchema.extend(
  hostParamsSchema.shape,
);
const enabledBodySchema = z.object({ enabled: z.boolean() }).strict();

export const remoteHostDefaultSchema = z
  .object({
    connectionId: z.uuid(),
    displayName: z.string(),
    defaultEnabled: z.boolean(),
  })
  .strict();

export const threadRemoteHostAccessSchema = remoteHostDefaultSchema
  .extend({
    overrideEnabled: z.boolean().nullable(),
    enabled: z.boolean(),
    source: z.enum(["default", "override"]),
  })
  .strict();

const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  500: apiErrorSchema,
};

export const chatRemoteAccessContract = c.router({
  listHostDefaults: {
    method: "GET",
    path: "/api/remote-access/hosts",
    headers: authHeadersSchema,
    responses: {
      200: z
        .object({
          ssh: z.array(remoteHostDefaultSchema),
          vnc: z.array(remoteHostDefaultSchema),
        })
        .strict(),
      ...errors,
    },
    summary: "List owned SSH and VNC host defaults",
  },
  updateHostDefault: {
    method: "PUT",
    path: "/api/remote-access/hosts/:protocol/:connectionId/default",
    headers: authHeadersSchema,
    pathParams: hostParamsSchema,
    body: enabledBodySchema,
    responses: { 200: remoteHostDefaultSchema, ...errors },
    summary: "Set an owned host's default chat access",
  },
  listThreadAccess: {
    method: "GET",
    path: "/api/chat-threads/:threadId/remote-access",
    headers: authHeadersSchema,
    pathParams: threadParamsSchema,
    responses: {
      200: z
        .object({
          ssh: z.array(threadRemoteHostAccessSchema),
          vnc: z.array(threadRemoteHostAccessSchema),
        })
        .strict(),
      ...errors,
    },
    summary: "List effective SSH and VNC access for a chat thread",
  },
  setThreadOverride: {
    method: "PUT",
    path: "/api/chat-threads/:threadId/remote-access/:protocol/:connectionId",
    headers: authHeadersSchema,
    pathParams: threadHostParamsSchema,
    body: enabledBodySchema,
    responses: { 200: threadRemoteHostAccessSchema, ...errors },
    summary: "Set explicit chat access to one host",
  },
  clearThreadOverride: {
    method: "DELETE",
    path: "/api/chat-threads/:threadId/remote-access/:protocol/:connectionId",
    headers: authHeadersSchema,
    pathParams: threadHostParamsSchema,
    responses: { 200: threadRemoteHostAccessSchema, ...errors },
    summary: "Clear explicit chat access and inherit the host default",
  },
});

export type RemoteAccessProtocol = z.infer<typeof protocolSchema>;
export type RemoteHostDefault = z.infer<typeof remoteHostDefaultSchema>;
export type ThreadRemoteHostAccess = z.infer<
  typeof threadRemoteHostAccessSchema
>;
