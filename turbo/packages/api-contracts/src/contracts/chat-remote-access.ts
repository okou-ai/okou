import {
  array,
  boolean,
  object,
  string,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();
const protocolSchema = zEnum(["ssh", "vnc"]);
export const initialRemoteAccessOverrideSchema = object({
  protocol: protocolSchema,
  connectionId: uuid(),
  enabled: boolean(),
}).strict();
export type InitialRemoteAccessOverride = zInfer<
  typeof initialRemoteAccessOverrideSchema
>;
const hostParamsSchema = object({
  protocol: protocolSchema,
  connectionId: uuid(),
}).strict();
const threadParamsSchema = object({ threadId: uuid() }).strict();
const threadHostParamsSchema = threadParamsSchema.extend(
  hostParamsSchema.shape,
);
const enabledBodySchema = object({ enabled: boolean() }).strict();

export const remoteHostDefaultSchema = object({
  connectionId: uuid(),
  displayName: string(),
  defaultEnabled: boolean(),
}).strict();

export const threadRemoteHostAccessSchema = remoteHostDefaultSchema
  .extend({
    overrideEnabled: boolean().nullable(),
    enabled: boolean(),
    source: zEnum(["default", "override"]),
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
      200: object({
        ssh: array(remoteHostDefaultSchema),
        vnc: array(remoteHostDefaultSchema),
      }).strict(),
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
      200: object({
        ssh: array(threadRemoteHostAccessSchema),
        vnc: array(threadRemoteHostAccessSchema),
      }).strict(),
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

export type RemoteAccessProtocol = zInfer<typeof protocolSchema>;
export type RemoteHostDefault = zInfer<typeof remoteHostDefaultSchema>;
export type ThreadRemoteHostAccess = zInfer<
  typeof threadRemoteHostAccessSchema
>;
