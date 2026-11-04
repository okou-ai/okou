import {
  array,
  boolean,
  coerce,
  discriminatedUnion,
  literal,
  number,
  object,
  string,
  uuid,
  type infer as zInfer,
} from "zod";

import {
  connectorAccountConnectionSchema,
  connectorAccountFieldMetadataSchema,
  connectorAccountSelectionSchema,
  connectorAccountTargetSchema,
} from "../validators/connector-accounts";
import { authHeadersSchema, initContract } from "./base";
import {
  connectorAuthMethodIdSchema,
  connectorSlugSchema,
} from "./connector-identity";
import {
  connectorReconnectReasonSchema,
  connectorResponseConnectionStatusSchema,
  scopeDiffResponseSchema,
} from "./connector-schemas";
import { apiErrorSchema } from "./errors";

export {
  builtinConnectorAccountFacts,
  connectorAccountConnectionSchema,
  connectorAccountEffectiveLabel,
  connectorAccountExternalIdentity,
  connectorAccountFieldMetadataSchema,
  connectorAccountSelectionSchema,
  connectorAccountTargetKey,
  connectorAccountTargetSchema,
  type ConnectorAccountConnection,
  type ConnectorAccountIdentityFields,
  type ConnectorAccountTarget,
} from "../validators/connector-accounts";

const c = initContract();

export const connectorAccountDisplayNameSchema = string()
  .trim()
  .min(1)
  .max(255);

export const CONNECTOR_ACCOUNT_INSPECTION_MAX_SELECTIONS = 256;
export const CONNECTOR_ACCOUNT_LIST_MAX_LIMIT = 100;

const connectorAccountInspectionAvailableSchema = object({
  ...connectorAccountFieldMetadataSchema.shape,
  kind: literal("available"),
  connectionId: uuid(),
  target: connectorAccountTargetSchema,
  authMethod: connectorAuthMethodIdSchema,
  displayName: string().min(1).max(255).nullable(),
  externalId: string().nullable(),
  externalUsername: string().nullable(),
  externalEmail: string().nullable(),
  connectionStatus: connectorResponseConnectionStatusSchema,
  reconnectReason: connectorReconnectReasonSchema.nullable(),
}).strict();

const connectorAccountInspectionUnavailableSchema = object({
  kind: literal("unavailable"),
  connectionId: uuid(),
  target: connectorAccountTargetSchema,
}).strict();

export const connectorAccountInspectionResultSchema = discriminatedUnion(
  "kind",
  [
    connectorAccountInspectionAvailableSchema,
    connectorAccountInspectionUnavailableSchema,
  ],
);

export const connectorAccountMutationIntentSchema = discriminatedUnion(
  "intent",
  [
    object({
      intent: literal("add"),
      displayName: connectorAccountDisplayNameSchema.optional(),
    }).strict(),
    object({
      intent: literal("reconnect"),
      connectionId: uuid(),
    }).strict(),
  ],
);

export const connectorAccountTargetQuerySchema = discriminatedUnion("kind", [
  object({
    kind: literal("builtin"),
    connectorSlug: connectorSlugSchema,
  }).strict(),
  object({
    kind: literal("custom"),
    customConnectorId: uuid(),
  }).strict(),
]);

const connectorAccountListQueryFields = {
  cursor: string().min(1).optional(),
  limit: coerce
    .number()
    .int()
    .min(1)
    .max(CONNECTOR_ACCOUNT_LIST_MAX_LIMIT)
    .default(50),
  search: string().trim().min(1).max(255).optional(),
} as const;

export const connectorAccountListQuerySchema = discriminatedUnion("kind", [
  object({
    kind: literal("builtin"),
    connectorSlug: connectorSlugSchema,
    includeScopeMismatch: literal("true").optional(),
    ...connectorAccountListQueryFields,
  }).strict(),
  object({
    kind: literal("custom"),
    customConnectorId: uuid(),
    ...connectorAccountListQueryFields,
  }).strict(),
]);

const connectorAccountPathParamsSchema = object({
  connectionId: uuid(),
});

const connectorAccountExactTargetBodySchema = object({
  target: connectorAccountTargetSchema,
}).strict();

export const connectorAccountsContract = c.router({
  oauthCompletion: {
    method: "GET",
    path: "/api/connector-accounts/oauth-completions/:attemptId",
    headers: authHeadersSchema,
    pathParams: object({ attemptId: uuid() }),
    query: connectorAccountTargetQuerySchema,
    responses: {
      200: object({ connectionId: uuid() }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Read an owned OAuth attempt's completed account",
  },
  inspect: {
    method: "POST",
    path: "/api/connector-accounts/inspect",
    headers: authHeadersSchema,
    body: object({
      selections: array(connectorAccountSelectionSchema).max(
        CONNECTOR_ACCOUNT_INSPECTION_MAX_SELECTIONS,
      ),
    }).strict(),
    responses: {
      200: object({
        results: array(connectorAccountInspectionResultSchema),
      }).strict(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Inspect exact connector accounts",
  },
  connections: {
    method: "GET",
    path: "/api/connector-accounts/connections",
    headers: authHeadersSchema,
    query: connectorAccountListQuerySchema,
    responses: {
      200: object({
        connections: array(connectorAccountConnectionSchema),
        nextCursor: string().nullable(),
        defaultConnection: connectorAccountConnectionSchema.nullable(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "List one target's connector accounts",
  },
  connection: {
    method: "GET",
    path: "/api/connector-accounts/:connectionId",
    headers: authHeadersSchema,
    pathParams: connectorAccountPathParamsSchema,
    query: connectorAccountTargetQuerySchema,
    responses: {
      200: connectorAccountConnectionSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get one exact connector account",
  },
  scopeDiff: {
    method: "GET",
    path: "/api/connector-accounts/:connectionId/scope-diff",
    headers: authHeadersSchema,
    pathParams: connectorAccountPathParamsSchema,
    query: object({ connectorSlug: connectorSlugSchema }).strict(),
    responses: {
      200: scopeDiffResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get requested scope diff for one exact connector account",
  },
  rename: {
    method: "PATCH",
    path: "/api/connector-accounts/:connectionId",
    headers: authHeadersSchema,
    pathParams: connectorAccountPathParamsSchema,
    body: object({
      target: connectorAccountTargetSchema,
      displayName: connectorAccountDisplayNameSchema.nullable(),
    }).strict(),
    responses: {
      200: connectorAccountConnectionSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Rename an exact connector account",
  },
  setDefault: {
    method: "POST",
    path: "/api/connector-accounts/:connectionId/default",
    headers: authHeadersSchema,
    pathParams: connectorAccountPathParamsSchema,
    body: connectorAccountExactTargetBodySchema,
    responses: {
      200: connectorAccountConnectionSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Set the default connector account",
  },
  deletionImpact: {
    method: "GET",
    path: "/api/connector-accounts/:connectionId/deletion-impact",
    headers: authHeadersSchema,
    pathParams: connectorAccountPathParamsSchema,
    query: connectorAccountTargetQuerySchema,
    responses: {
      200: object({
        connectionId: uuid(),
        explicitSelectionCount: number().int().nonnegative(),
        hasSibling: boolean(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Plan deletion of an exact connector account",
  },
  delete: {
    method: "DELETE",
    path: "/api/connector-accounts/:connectionId",
    headers: authHeadersSchema,
    pathParams: connectorAccountPathParamsSchema,
    body: connectorAccountExactTargetBodySchema,
    responses: {
      200: object({
        deletedConnectionId: uuid(),
        resolvedSelectionCount: number().int().nonnegative(),
        promotedDefaultConnectionId: uuid().nullable(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Delete an exact connector account",
  },
});

export type ConnectorAccountSelection = zInfer<
  typeof connectorAccountSelectionSchema
>;
export type ConnectorAccountInspectionResult = zInfer<
  typeof connectorAccountInspectionResultSchema
>;
export type ConnectorAccountMutationIntent = zInfer<
  typeof connectorAccountMutationIntentSchema
>;
