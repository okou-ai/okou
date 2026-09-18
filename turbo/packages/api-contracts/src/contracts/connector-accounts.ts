import { z } from "zod";

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

const c = initContract();

export const connectorAccountDisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255);

export const connectorAccountTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("builtin"),
      connectorSlug: connectorSlugSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("custom"),
      customConnectorId: z.uuid(),
    })
    .strict(),
]);

export const connectorAccountConnectionSchema = z
  .object({
    id: z.uuid(),
    target: connectorAccountTargetSchema,
    authMethod: connectorAuthMethodIdSchema,
    displayName: z.string().min(1).max(255).nullable(),
    isDefault: z.boolean(),
    externalId: z.string().nullable(),
    externalUsername: z.string().nullable(),
    externalEmail: z.string().nullable(),
    oauthScopes: z.array(z.string()).nullable(),
    scopeMismatch: z.boolean().optional(),
    connectionStatus: connectorResponseConnectionStatusSchema,
    reconnectReason: connectorReconnectReasonSchema.nullable(),
    tokenExpiresAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export const connectorAccountSelectionSchema = z
  .object({
    connectionId: z.uuid(),
    target: connectorAccountTargetSchema,
  })
  .strict();

export const CONNECTOR_ACCOUNT_INSPECTION_MAX_SELECTIONS = 256;
export const CONNECTOR_ACCOUNT_LIST_MAX_LIMIT = 100;

const connectorAccountInspectionAvailableSchema = z
  .object({
    kind: z.literal("available"),
    connectionId: z.uuid(),
    target: connectorAccountTargetSchema,
    authMethod: connectorAuthMethodIdSchema,
    displayName: z.string().min(1).max(255).nullable(),
    externalId: z.string().nullable(),
    externalUsername: z.string().nullable(),
    externalEmail: z.string().nullable(),
    connectionStatus: connectorResponseConnectionStatusSchema,
    reconnectReason: connectorReconnectReasonSchema.nullable(),
  })
  .strict();

const connectorAccountInspectionUnavailableSchema = z
  .object({
    kind: z.literal("unavailable"),
    connectionId: z.uuid(),
    target: connectorAccountTargetSchema,
  })
  .strict();

export const connectorAccountInspectionResultSchema = z.discriminatedUnion(
  "kind",
  [
    connectorAccountInspectionAvailableSchema,
    connectorAccountInspectionUnavailableSchema,
  ],
);

export const connectorAccountMutationIntentSchema = z.discriminatedUnion(
  "intent",
  [
    z
      .object({
        intent: z.literal("add"),
        displayName: connectorAccountDisplayNameSchema.optional(),
      })
      .strict(),
    z
      .object({
        intent: z.literal("reconnect"),
        connectionId: z.uuid(),
      })
      .strict(),
  ],
);

export const connectorAccountTargetQuerySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("builtin"),
      connectorSlug: connectorSlugSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("custom"),
      customConnectorId: z.uuid(),
    })
    .strict(),
]);

const connectorAccountListQueryFields = {
  cursor: z.string().min(1).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(CONNECTOR_ACCOUNT_LIST_MAX_LIMIT)
    .default(50),
  search: z.string().trim().min(1).max(255).optional(),
} as const;

export const connectorAccountListQuerySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("builtin"),
      connectorSlug: connectorSlugSchema,
      includeScopeMismatch: z.literal("true").optional(),
      ...connectorAccountListQueryFields,
    })
    .strict(),
  z
    .object({
      kind: z.literal("custom"),
      customConnectorId: z.uuid(),
      ...connectorAccountListQueryFields,
    })
    .strict(),
]);

export const connectorAccountSummarySchema = z
  .object({
    target: connectorAccountTargetSchema,
    accountCount: z.number().int().nonnegative(),
    attentionCount: z.number().int().nonnegative(),
    defaultConnection: connectorAccountConnectionSchema.nullable(),
  })
  .strict();

const connectorAccountPathParamsSchema = z.object({
  connectionId: z.uuid(),
});

const connectorAccountExactTargetBodySchema = z
  .object({ target: connectorAccountTargetSchema })
  .strict();

export const connectorAccountsContract = c.router({
  oauthCompletion: {
    method: "GET",
    path: "/api/connector-accounts/oauth-completions/:attemptId",
    headers: authHeadersSchema,
    pathParams: z.object({ attemptId: z.uuid() }),
    query: connectorAccountTargetQuerySchema,
    responses: {
      200: z.object({ connectionId: z.uuid() }),
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
    body: z
      .object({
        selections: z
          .array(connectorAccountSelectionSchema)
          .max(CONNECTOR_ACCOUNT_INSPECTION_MAX_SELECTIONS),
      })
      .strict(),
    responses: {
      200: z
        .object({
          results: z.array(connectorAccountInspectionResultSchema),
        })
        .strict(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Inspect exact connector accounts",
  },
  summaries: {
    method: "GET",
    path: "/api/connector-accounts",
    headers: authHeadersSchema,
    responses: {
      200: z.object({ summaries: z.array(connectorAccountSummarySchema) }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "List connector account summaries",
  },
  connections: {
    method: "GET",
    path: "/api/connector-accounts/connections",
    headers: authHeadersSchema,
    query: connectorAccountListQuerySchema,
    responses: {
      200: z.object({
        connections: z.array(connectorAccountConnectionSchema),
        nextCursor: z.string().nullable(),
        defaultConnection: connectorAccountConnectionSchema
          .nullable()
          .optional(),
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
    query: z.object({ connectorSlug: connectorSlugSchema }).strict(),
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
    body: z
      .object({
        target: connectorAccountTargetSchema,
        displayName: connectorAccountDisplayNameSchema.nullable(),
      })
      .strict(),
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
      200: z.object({
        connectionId: z.uuid(),
        explicitSelectionCount: z.number().int().nonnegative(),
        hasSibling: z.boolean(),
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
      200: z.object({
        deletedConnectionId: z.uuid(),
        resolvedSelectionCount: z.number().int().nonnegative(),
        promotedDefaultConnectionId: z.uuid().nullable(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Delete an exact connector account",
  },
});

export type ConnectorAccountTarget = z.infer<
  typeof connectorAccountTargetSchema
>;
export function connectorAccountTargetKey(
  target: ConnectorAccountTarget,
): string {
  return target.kind === "builtin"
    ? `builtin:${target.connectorSlug}`
    : `custom:${target.customConnectorId}`;
}
export type ConnectorAccountConnection = z.infer<
  typeof connectorAccountConnectionSchema
>;
export type ConnectorAccountIdentityFields = Pick<
  ConnectorAccountConnection,
  "displayName" | "externalEmail" | "externalId" | "externalUsername"
>;
export function connectorAccountExternalIdentity(
  account: Omit<ConnectorAccountIdentityFields, "displayName">,
): string | null {
  return (
    account.externalEmail ||
    account.externalUsername ||
    account.externalId ||
    null
  );
}
export function connectorAccountEffectiveLabel(
  account: ConnectorAccountIdentityFields,
  fallbackLabel: string,
): string {
  return (
    account.displayName ??
    connectorAccountExternalIdentity(account) ??
    fallbackLabel
  );
}
export type ConnectorAccountSelection = z.infer<
  typeof connectorAccountSelectionSchema
>;
export type ConnectorAccountInspectionResult = z.infer<
  typeof connectorAccountInspectionResultSchema
>;
export type ConnectorAccountMutationIntent = z.infer<
  typeof connectorAccountMutationIntentSchema
>;
export type ConnectorAccountSummary = z.infer<
  typeof connectorAccountSummarySchema
>;
