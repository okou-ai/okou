import {
  array,
  boolean,
  object,
  string,
  uuid,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import {
  connectorAccountTargetQuerySchema,
  connectorAccountTargetSchema,
} from "./connector-accounts";
import { apiErrorSchema } from "./errors";
import {
  applyUserPermissionGrantSchema,
  userPermissionGrantActionSchema,
  userPermissionGrantApplyModeSchema,
} from "./user-permission-grants";
import { permissionSchema } from "../validators/user-permission-grants";

const c = initContract();
const targetBody = object({ target: connectorAccountTargetSchema }).strict();
const threadParams = object({ threadId: uuid() });
const accountDefaultsSchema = object({
  connectionId: uuid(),
  displayName: string().nullable(),
  defaultEnabled: boolean(),
  isDefault: boolean(),
}).strict();
const chatConnectorAccessSchema = object({
  target: connectorAccountTargetSchema,
  accounts: array(
    accountDefaultsSchema
      .extend({
        overrideEnabled: boolean().nullable(),
        enabled: boolean(),
      })
      .strict(),
  ),
  currentConnectionId: uuid().nullable(),
  available: boolean(),
}).strict();

const chatConnectorPermissionsSchema = object({
  target: connectorAccountTargetSchema,
  permissionNames: array(permissionSchema),
  grants: array(
    object({
      permission: permissionSchema,
      action: userPermissionGrantActionSchema,
      expiresAt: string().nullable(),
    }).strict(),
  ),
}).strict();

const applyChatConnectorPermissionsSchema = object({
  target: connectorAccountTargetSchema,
  mode: userPermissionGrantApplyModeSchema,
  permissionNames: array(permissionSchema).optional(),
  grants: array(applyUserPermissionGrantSchema).max(1000),
})
  .strict()
  .superRefine((body, ctx) => {
    const names = body.grants.map((grant) => {
      return grant.permission;
    });
    if (
      new Set(names).size !== names.length ||
      (body.permissionNames &&
        new Set(body.permissionNames).size !== body.permissionNames.length)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Duplicate connector permission",
      });
    }
  });

const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
} as const;

/** New owner configuration contracts leave strict existing account shapes intact. */
export const chatConnectorAccessContract = c.router({
  accountDefaults: {
    method: "GET",
    path: "/api/connector-account-access/defaults",
    headers: authHeadersSchema,
    query: connectorAccountTargetQuerySchema,
    responses: { 200: array(accountDefaultsSchema), ...errors },
    summary: "Read account defaults for an owned connector target",
  },
  updateAccountDefault: {
    method: "PUT",
    path: "/api/connector-account-access/:connectionId/default-enabled",
    headers: authHeadersSchema,
    pathParams: object({ connectionId: uuid() }),
    body: targetBody.extend({ enabled: boolean() }).strict(),
    responses: { 200: accountDefaultsSchema, ...errors },
    summary: "Set an account's inherited Chat allowance",
  },
  getThread: {
    method: "GET",
    path: "/api/chat-threads/:threadId/connector-access",
    headers: authHeadersSchema,
    pathParams: threadParams,
    query: connectorAccountTargetQuerySchema,
    responses: { 200: chatConnectorAccessSchema, ...errors },
    summary: "Read effective Chat accounts and current selection",
  },
  setThreadOverride: {
    method: "PUT",
    path: "/api/chat-threads/:threadId/connector-access/:connectionId",
    headers: authHeadersSchema,
    pathParams: threadParams.extend({ connectionId: uuid() }),
    body: targetBody.extend({ enabled: boolean().nullable() }).strict(),
    responses: { 200: chatConnectorAccessSchema, ...errors },
    summary: "Allow, deny or inherit one account in a Chat",
  },
  setThreadCurrent: {
    method: "PUT",
    path: "/api/chat-threads/:threadId/connector-current",
    headers: authHeadersSchema,
    pathParams: threadParams,
    body: targetBody.extend({ connectionId: uuid() }).strict(),
    responses: { 200: chatConnectorAccessSchema, ...errors },
    summary: "Save an allowed current account for a Chat",
  },
  getPermissions: {
    method: "GET",
    path: "/api/chat-threads/:threadId/connector-permissions",
    headers: authHeadersSchema,
    pathParams: threadParams,
    query: connectorAccountTargetQuerySchema,
    responses: { 200: chatConnectorPermissionsSchema, ...errors },
    summary: "Read shared Chat permissions when any account is saved",
  },
  setPermissions: {
    method: "PUT",
    path: "/api/chat-threads/:threadId/connector-permissions",
    headers: authHeadersSchema,
    pathParams: threadParams,
    body: applyChatConnectorPermissionsSchema,
    responses: { 200: chatConnectorPermissionsSchema, ...errors },
    summary:
      "Configure shared Chat permissions independently of account allowance",
  },
});

export type ChatConnectorAccess = zInfer<typeof chatConnectorAccessSchema>;
export type ChatConnectorPermissions = zInfer<
  typeof chatConnectorPermissionsSchema
>;
export type ApplyChatConnectorPermissions = zInfer<
  typeof applyChatConnectorPermissionsSchema
>;
