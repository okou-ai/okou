import { z } from "zod";

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

export const connectorReconnectReasonSchema = z.enum([
  "provider_session_expired",
  "authorization_expired_or_revoked",
  "credential_expired",
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
  reconnectReason: connectorReconnectReasonSchema.nullable().default(null),
  tokenExpiresAt: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type BuiltinConnectorResponse = z.infer<
  typeof builtinConnectorResponseSchema
>;

export const connectorProvidedBindingNamespaceSchema = z.enum([
  "secrets",
  "vars",
]);

export const connectorProvidedBindingSourceSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("connector-secret"),
      name: z.string(),
    }),
    z.object({
      kind: z.literal("connector-variable"),
      name: z.string(),
    }),
  ],
);

export const connectorProvidedBindingSchema = z.object({
  connectorSlug: connectorSlugSchema,
  authMethod: connectorAuthMethodIdSchema,
  namespace: connectorProvidedBindingNamespaceSchema,
  name: z.string(),
  optional: z.boolean(),
  source: connectorProvidedBindingSourceSchema,
});

export type ConnectorProvidedBinding = z.infer<
  typeof connectorProvidedBindingSchema
>;
export type ConnectorProvidedBindingNamespace = z.infer<
  typeof connectorProvidedBindingNamespaceSchema
>;

/**
 * Names that a stored connector guarantees at runtime. Optional bindings are
 * omitted because they describe possible connector supply, not guaranteed
 * connector supply.
 */
export function guaranteedConnectorProvidedBindingNames(args: {
  readonly bindings: readonly ConnectorProvidedBinding[];
  readonly namespace: ConnectorProvidedBindingNamespace;
}): Set<string> {
  const names = new Set<string>();
  for (const binding of args.bindings) {
    if (binding.namespace === args.namespace && !binding.optional) {
      names.add(binding.name);
    }
  }
  return names;
}

/**
 * List connectors response
 */
export const builtinConnectorListResponseSchema = z.object({
  connectors: z.array(builtinConnectorResponseSchema),
  connectorProvidedBindings: z
    .array(connectorProvidedBindingSchema)
    .default([]),
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
      connector: builtinConnectorResponseSchema,
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
    connector: builtinConnectorResponseSchema,
  });

export type BuiltinConnectorExternalCodeSessionCompleteResponse = z.infer<
  typeof builtinConnectorExternalCodeSessionCompleteResponseSchema
>;
