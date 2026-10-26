import {
  array,
  discriminatedUnion,
  literal,
  number,
  object,
  string,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import {
  connectorAuthMethodIdSchema,
  connectorSlugSchema,
} from "./connector-identity";

/**
 * Connector response schema
 */
export const connectorResponseConnectionStatusSchema = zEnum([
  "connected",
  "reconnect-required",
]);

export type ConnectorResponseConnectionStatus = zInfer<
  typeof connectorResponseConnectionStatusSchema
>;

export const connectorCredentialReconnectReasonSchema = zEnum([
  "provider_session_expired",
  "authorization_expired_or_revoked",
  "credential_expired",
]);

export type ConnectorCredentialReconnectReason = zInfer<
  typeof connectorCredentialReconnectReasonSchema
>;

export const connectorReconnectReasonSchema = zEnum([
  ...connectorCredentialReconnectReasonSchema.options,
  "configuration_incomplete",
  "configuration_invalid",
  "account_unavailable",
]);

export type ConnectorReconnectReason = zInfer<
  typeof connectorReconnectReasonSchema
>;

export const builtinConnectorResponseSchema = object({
  id: uuid(),
  slug: connectorSlugSchema,
  authMethod: connectorAuthMethodIdSchema,
  externalId: string().nullable(),
  externalUsername: string().nullable(),
  externalEmail: string().nullable(),
  oauthScopes: array(string()).nullable(),
  connectionStatus: connectorResponseConnectionStatusSchema,
  reconnectReason: connectorReconnectReasonSchema.nullable(),
  tokenExpiresAt: string().nullable(),
  createdAt: string(),
  updatedAt: string(),
});

export type BuiltinConnectorResponse = zInfer<
  typeof builtinConnectorResponseSchema
>;

/**
 * List connectors response
 */
export const builtinConnectorListResponseSchema = object({
  connectors: array(builtinConnectorResponseSchema),
});

export type BuiltinConnectorListResponse = zInfer<
  typeof builtinConnectorListResponseSchema
>;

/**
 * Scope diff response schema
 */
export const scopeDiffResponseSchema = object({
  addedScopes: array(string()),
  removedScopes: array(string()),
  currentScopes: array(string()),
  storedScopes: array(string()),
});

export type ScopeDiffResponse = zInfer<typeof scopeDiffResponseSchema>;

export const connectorCompletedOperationResponseSchema = object({
  connectionId: uuid(),
});

export const builtinConnectorOauthStartResponseSchema = object({
  authorizationUrl: string(),
  connectionId: uuid().optional(),
  oauthAttemptId: uuid(),
});

export type BuiltinConnectorOauthStartResponse = zInfer<
  typeof builtinConnectorOauthStartResponseSchema
>;

export const builtinConnectorOauthDeviceAuthSessionStartResponseSchema = object(
  {
    sessionId: uuid(),
    sessionToken: string(),
    connectorSlug: connectorSlugSchema,
    status: literal("pending"),
    userCode: string(),
    verificationUri: string(),
    verificationUriComplete: string().optional(),
    expiresIn: number(),
    interval: number(),
  },
);

export type BuiltinConnectorOauthDeviceAuthSessionStartResponse = zInfer<
  typeof builtinConnectorOauthDeviceAuthSessionStartResponseSchema
>;

export const builtinConnectorOauthDeviceAuthSessionPollRequestSchema = object({
  sessionToken: string(),
});

export type BuiltinConnectorOauthDeviceAuthSessionPollRequest = zInfer<
  typeof builtinConnectorOauthDeviceAuthSessionPollRequestSchema
>;

export const builtinConnectorOauthDeviceAuthSessionPollResponseSchema =
  discriminatedUnion("status", [
    object({
      status: literal("pending"),
      interval: number(),
    }),
    object({
      status: literal("complete"),
      connectionId: uuid(),
    }),
    object({
      status: literal("denied"),
      errorCode: string().optional(),
      errorMessage: string().optional(),
    }),
    object({
      status: literal("expired"),
      errorCode: string().optional(),
      errorMessage: string().optional(),
    }),
    object({
      status: literal("error"),
      errorCode: string().optional(),
      errorMessage: string().optional(),
    }),
  ]);

export type BuiltinConnectorOauthDeviceAuthSessionPollResponse = zInfer<
  typeof builtinConnectorOauthDeviceAuthSessionPollResponseSchema
>;

export const builtinConnectorExternalCodeSessionStartResponseSchema = object({
  sessionId: uuid(),
  sessionToken: string(),
  connectorSlug: connectorSlugSchema,
  status: literal("pending"),
  authorizationUrl: string(),
  expiresIn: number(),
});

export type BuiltinConnectorExternalCodeSessionStartResponse = zInfer<
  typeof builtinConnectorExternalCodeSessionStartResponseSchema
>;

export const builtinConnectorExternalCodeSessionCompleteRequestSchema = object({
  sessionToken: string(),
  code: string().trim().min(1).max(4096),
});

export type BuiltinConnectorExternalCodeSessionCompleteRequest = zInfer<
  typeof builtinConnectorExternalCodeSessionCompleteRequestSchema
>;

export const builtinConnectorExternalCodeSessionCompleteResponseSchema = object(
  {
    status: literal("complete"),
    connectionId: uuid(),
  },
);

export type BuiltinConnectorExternalCodeSessionCompleteResponse = zInfer<
  typeof builtinConnectorExternalCodeSessionCompleteResponseSchema
>;
