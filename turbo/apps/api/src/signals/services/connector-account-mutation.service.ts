import { connectorAccountMutationIntentSchema } from "@okouai/api-contracts/contracts/connector-accounts";
import { connectors } from "@okouai/db/schema/connector";
import { sql, type SQLWrapper } from "drizzle-orm";

import { zodDriverValueDecoder } from "../../lib/db-structured-result";

const storedConnectorAccountMutationDecoder = zodDriverValueDecoder(
  connectorAccountMutationIntentSchema,
);

export function storedConnectorAccountMutationSelection(
  accountMutation: SQLWrapper,
) {
  return sql`${accountMutation}`.mapWith(storedConnectorAccountMutationDecoder);
}

type ConnectorConnectionTarget =
  | {
      readonly kind: "builtin";
      readonly connectorSlug: string;
      readonly identity:
        | { readonly kind: "local" }
        | {
            readonly kind: "external";
            readonly externalId: string;
            readonly externalUsername: string | null;
            readonly externalEmail: string | null;
            readonly oauthRequestedScopes: readonly string[] | null;
            readonly oauthGrantedScopes: readonly string[] | null;
          };
    }
  | {
      readonly kind: "custom";
      readonly customConnectorId: string;
      readonly oauthScopes: readonly string[] | null;
      readonly identity:
        | { readonly kind: "local" }
        | {
            readonly kind: "external";
            readonly externalId: string;
            readonly externalUsername: string | null;
            readonly externalEmail: string | null;
          };
    };

export interface ConnectorConnectionMetadataArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly authMethod: string;
  readonly automaticAuthType?: "none" | "oauth";
  readonly storageVersion: number;
  readonly tokenExpiresAt: Date | null;
  readonly target: ConnectorConnectionTarget;
  readonly insertConnectionId?: string;
}

export function connectorConnectionIdentityValues(
  target: ConnectorConnectionMetadataArgs["target"],
) {
  return target.kind === "custom"
    ? {
        externalId:
          target.identity.kind === "external"
            ? target.identity.externalId
            : null,
        externalUsername:
          target.identity.kind === "external"
            ? target.identity.externalUsername
            : null,
        externalEmail:
          target.identity.kind === "external"
            ? target.identity.externalEmail
            : null,
        oauthScopes:
          target.oauthScopes === null
            ? null
            : JSON.stringify(target.oauthScopes),
        oauthGrantedScopes: null,
      }
    : target.identity.kind === "external"
      ? {
          externalId: target.identity.externalId,
          externalUsername: target.identity.externalUsername,
          externalEmail: target.identity.externalEmail,
          oauthScopes:
            target.identity.oauthRequestedScopes === null
              ? null
              : JSON.stringify(target.identity.oauthRequestedScopes),
          oauthGrantedScopes:
            target.identity.oauthGrantedScopes === null
              ? null
              : JSON.stringify(target.identity.oauthGrantedScopes),
        }
      : {
          externalId: null,
          externalUsername: null,
          externalEmail: null,
          oauthScopes: null,
          oauthGrantedScopes: null,
        };
}

export function connectorConnectionTargetValues(
  target: ConnectorConnectionMetadataArgs["target"],
) {
  return target.kind === "builtin"
    ? {
        connectorSlug: target.connectorSlug,
        customConnectorId: null,
      }
    : {
        connectorSlug: null,
        customConnectorId: target.customConnectorId,
      };
}

export function connectorConnectionReplacementValues(
  authMethod: string,
  automaticAuthType: "none" | "oauth" | null,
  storageVersion: number,
  identityValues: ReturnType<typeof connectorConnectionIdentityValues>,
  tokenExpiresAt: Date | null,
) {
  return {
    authMethod,
    automaticAuthType,
    storageVersion,
    ...identityValues,
    tokenExpiresAt,
    needsReconnect: false,
    reconnectReason: null,
  };
}

export function connectorConnectionDefaultConflict(kind: "builtin" | "custom") {
  return kind === "builtin"
    ? {
        target: [connectors.orgId, connectors.userId, connectors.connectorSlug],
        where: sql`${connectors.connectorSlug} IS NOT NULL AND ${connectors.isDefault} = true`,
      }
    : {
        target: [
          connectors.orgId,
          connectors.userId,
          connectors.customConnectorId,
        ],
        where: sql`${connectors.customConnectorId} IS NOT NULL AND ${connectors.isDefault} = true`,
      };
}
