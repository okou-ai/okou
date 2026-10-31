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

import {
  connectorAuthMethodIdSchema,
  connectorSlugSchema,
  type ConnectorAuthMethodId,
  type ConnectorSlug,
} from "../contracts/connector-identity";
import {
  connectorReconnectReasonSchema,
  connectorResponseConnectionStatusSchema,
} from "../contracts/connector-schemas";

export const connectorAccountTargetSchema = discriminatedUnion("kind", [
  object({
    kind: literal("builtin"),
    connectorSlug: connectorSlugSchema,
  }).strict(),
  object({
    kind: literal("custom"),
    customConnectorId: uuid(),
  }).strict(),
]);

export const connectorAccountFieldMetadataSchema = object({
  missingRequiredFields: array(string()),
  configuredFieldKeys: array(string()),
});

export const connectorAccountConnectionSchema = object({
  ...connectorAccountFieldMetadataSchema.shape,
  id: uuid(),
  target: connectorAccountTargetSchema,
  authMethod: connectorAuthMethodIdSchema,
  displayName: string().min(1).max(255).nullable(),
  isDefault: boolean(),
  externalId: string().nullable(),
  externalUsername: string().nullable(),
  externalEmail: string().nullable(),
  oauthScopes: array(string()).nullable(),
  scopeMismatch: boolean().optional(),
  connectionStatus: connectorResponseConnectionStatusSchema,
  reconnectReason: connectorReconnectReasonSchema.nullable(),
  tokenExpiresAt: string().nullable(),
  createdAt: string(),
  updatedAt: string(),
}).strict();

export const connectorAccountSelectionSchema = object({
  connectionId: uuid(),
  target: connectorAccountTargetSchema,
}).strict();

export type ConnectorAccountTarget = zInfer<
  typeof connectorAccountTargetSchema
>;

export function connectorAccountTargetKey(
  target: ConnectorAccountTarget,
): string {
  return target.kind === "builtin"
    ? `builtin:${target.connectorSlug}`
    : `custom:${target.customConnectorId}`;
}

export type ConnectorAccountConnection = zInfer<
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

/** Canonical saved-account facts; connect-method visibility does not identify accounts. */
export function builtinConnectorAccountFacts(
  connector: {
    readonly slug: ConnectorSlug;
    readonly authMethods: readonly {
      readonly id: ConnectorAuthMethodId;
      readonly supportsRefresh: boolean;
    }[];
  },
  account: ConnectorAccountConnection,
) {
  if (
    account.target.kind !== "builtin" ||
    account.target.connectorSlug !== connector.slug
  ) {
    throw new Error("Connector account metadata identity mismatch");
  }
  const method = connector.authMethods.find((candidate) => {
    return candidate.id === account.authMethod;
  });
  return {
    scopeMismatch: account.scopeMismatch,
    // Existing accounts can use a method hidden from new connections, such as
    // the non-expiring Mercury API token. Absence does not invent a capability.
    supportsRefresh: method?.supportsRefresh,
  };
}
