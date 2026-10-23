import * as z from "zod";

import {
  connectorAuthMethodIdSchema,
  connectorSlugSchema,
} from "./connector-identity";

/**
 * Connector response schema
 */
export const connectorResponseConnectionStatusSchema = z.enum([
  "connected",
  "reconnect-required",
]);

export type ConnectorResponseConnectionStatus = z.infer<
  typeof connectorResponseConnectionStatusSchema
>;

export const connectorCredentialReconnectReasonSchema = z.enum([
  "provider_session_expired",
  "authorization_expired_or_revoked",
  "credential_expired",
]);

export type ConnectorCredentialReconnectReason = z.infer<
  typeof connectorCredentialReconnectReasonSchema
>;

export const connectorReconnectReasonSchema = z.enum([
  ...connectorCredentialReconnectReasonSchema.options,
  "configuration_incomplete",
  "configuration_invalid",
  "account_unavailable",
]);

export type ConnectorReconnectReason = z.infer<
  typeof connectorReconnectReasonSchema
>;

export const builtinConnectorResponseSchema = z.object({
  id: z.uuid(),
  slug: connectorSlugSchema,
  authMethod: connectorAuthMethodIdSchema,
  externalId: z.string().nullable(),
  externalUsername: z.string().nullable(),
  externalEmail: z.string().nullable(),
  oauthScopes: z.array(z.string()).nullable(),
  connectionStatus: connectorResponseConnectionStatusSchema,
  reconnectReason: connectorReconnectReasonSchema.nullable(),
  tokenExpiresAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type BuiltinConnectorResponse = z.infer<
  typeof builtinConnectorResponseSchema
>;

/**
 * List connectors response
 */
export const builtinConnectorListResponseSchema = z.object({
  connectors: z.array(builtinConnectorResponseSchema),
});

export type BuiltinConnectorListResponse = z.infer<
  typeof builtinConnectorListResponseSchema
>;

/**
 * Scope diff response schema
 */
export const scopeDiffResponseSchema = z.object({
  addedScopes: z.array(z.string()),
  removedScopes: z.array(z.string()),
  currentScopes: z.array(z.string()),
  storedScopes: z.array(z.string()),
});

export type ScopeDiffResponse = z.infer<typeof scopeDiffResponseSchema>;

export const connectorCompletedOperationResponseSchema = z.object({
  connectionId: z.uuid(),
});

export const builtinConnectorOauthStartResponseSchema = z.object({
  authorizationUrl: z.string(),
  connectionId: z.uuid().optional(),
  oauthAttemptId: z.uuid(),
});

export type BuiltinConnectorOauthStartResponse = z.infer<
  typeof builtinConnectorOauthStartResponseSchema
>;

export const builtinConnectorOauthDeviceAuthSessionStartResponseSchema =
  z.object({
    sessionId: z.uuid(),
    sessionToken: z.string(),
    connectorSlug: connectorSlugSchema,
    status: z.literal("pending"),
    userCode: z.string(),
    verificationUri: z.string(),
    verificationUriComplete: z.string().optional(),
    expiresIn: z.number(),
    interval: z.number(),
  });

export type BuiltinConnectorOauthDeviceAuthSessionStartResponse = z.infer<
  typeof builtinConnectorOauthDeviceAuthSessionStartResponseSchema
>;

export const builtinConnectorOauthDeviceAuthSessionPollRequestSchema = z.object(
  {
    sessionToken: z.string(),
  },
);

export type BuiltinConnectorOauthDeviceAuthSessionPollRequest = z.infer<
  typeof builtinConnectorOauthDeviceAuthSessionPollRequestSchema
>;

export const builtinConnectorOauthDeviceAuthSessionPollResponseSchema =
  z.discriminatedUnion("status", [
    z.object({
      status: z.literal("pending"),
      interval: z.number(),
    }),
    z.object({
      status: z.literal("complete"),
      connectionId: z.uuid(),
    }),
    z.object({
      status: z.literal("denied"),
      errorCode: z.string().optional(),
      errorMessage: z.string().optional(),
    }),
    z.object({
      status: z.literal("expired"),
      errorCode: z.string().optional(),
      errorMessage: z.string().optional(),
    }),
    z.object({
      status: z.literal("error"),
      errorCode: z.string().optional(),
      errorMessage: z.string().optional(),
    }),
  ]);

export type BuiltinConnectorOauthDeviceAuthSessionPollResponse = z.infer<
  typeof builtinConnectorOauthDeviceAuthSessionPollResponseSchema
>;

export const builtinConnectorExternalCodeSessionStartResponseSchema = z.object({
  sessionId: z.uuid(),
  sessionToken: z.string(),
  connectorSlug: connectorSlugSchema,
  status: z.literal("pending"),
  authorizationUrl: z.string(),
  expiresIn: z.number(),
});

export type BuiltinConnectorExternalCodeSessionStartResponse = z.infer<
  typeof builtinConnectorExternalCodeSessionStartResponseSchema
>;

export const builtinConnectorExternalCodeSessionCompleteRequestSchema =
  z.object({
    sessionToken: z.string(),
    code: z.string().trim().min(1).max(4096),
  });

export type BuiltinConnectorExternalCodeSessionCompleteRequest = z.infer<
  typeof builtinConnectorExternalCodeSessionCompleteRequestSchema
>;

export const builtinConnectorExternalCodeSessionCompleteResponseSchema =
  z.object({
    status: z.literal("complete"),
    connectionId: z.uuid(),
  });

export type BuiltinConnectorExternalCodeSessionCompleteResponse = z.infer<
  typeof builtinConnectorExternalCodeSessionCompleteResponseSchema
>;
