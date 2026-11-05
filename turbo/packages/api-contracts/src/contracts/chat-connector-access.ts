import {
  array,
  boolean,
  discriminatedUnion,
  literal,
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
  connectorAuthMethodIdSchema,
  connectorSlugSchema,
} from "./connector-identity";
import { publicConnectorCatalogIconSchema } from "./connector-catalog";

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

const chatConnectorOverviewEntrySchema = object({
  target: connectorAccountTargetSchema,
  label: string(),
  icon: publicConnectorCatalogIconSchema.nullable(),
  hasPermissions: boolean(),
  accounts: array(
    accountDefaultsSchema
      .extend({
        authMethod: connectorAuthMethodIdSchema,
        externalId: string().nullable(),
        externalUsername: string().nullable(),
        externalEmail: string().nullable(),
        overrideEnabled: boolean().nullable(),
        enabled: boolean(),
      })
      .strict(),
  ),
  currentConnectionId: uuid().nullable(),
}).strict();

export type ChatConnectorOverviewEntry = zInfer<
  typeof chatConnectorOverviewEntrySchema
>;
const overviewQuery = object({ threadId: uuid().optional() });

const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
} as const;

/** New owner configuration contracts leave strict existing account shapes intact. */
export const chatConnectorAccessContract = c.router({
  overview: {
    method: "GET",
    path: "/api/chat-connector-overview",
    headers: authHeadersSchema,
    query: overviewQuery.strict(),
    responses: {
      200: array(chatConnectorOverviewEntrySchema),
      ...errors,
      503: apiErrorSchema,
    },
    summary:
      "Read connector identities and effective Chat preferences together",
  },
  overviewTarget: {
    method: "GET",
    path: "/api/chat-connector-overview/target",
    headers: authHeadersSchema,
    query: discriminatedUnion("kind", [
      object({
        ...overviewQuery.shape,
        kind: literal("builtin"),
        connectorSlug: connectorSlugSchema,
      }).strict(),
      object({
        ...overviewQuery.shape,
        kind: literal("custom"),
        customConnectorId: uuid(),
      }).strict(),
    ]),
    responses: {
      200: object({
        connector: chatConnectorOverviewEntrySchema.nullable(),
      }).strict(),
      ...errors,
      503: apiErrorSchema,
    },
    summary: "Refresh one connector's Chat overview, or null after its removal",
  },
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
});

export type ChatConnectorAccess = zInfer<typeof chatConnectorAccessSchema>;
