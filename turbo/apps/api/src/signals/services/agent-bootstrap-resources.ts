import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { orgCustomConnectorOauthConfigs } from "@okouai/db/schema/org-custom-connector-oauth-config";
import { userDisabledPaidTools } from "@okouai/db/schema/user-disabled-paid-tools";
import { variables } from "@okouai/db/schema/variable";
import { computed } from "ccstate";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { db$ } from "../external/db";
import { ORG_SENTINEL_USER_ID } from "./feature-switch-scope";
import type { BootstrapEnvironment } from "./agent-bootstrap.service";
import {
  customConnectorDefinitionSelection,
  type CustomConnectorExecutionDefinition,
} from "./custom-connector-definition-selection";
import { normaliseCustomConnectorRow } from "./custom-connector.service";

export function createAgentDisabledPaidTools(userId: string, orgId: string) {
  return computed(async (get): Promise<readonly string[]> => {
    const rows = await get(db$)
      .select({ toolId: userDisabledPaidTools.toolId })
      .from(userDisabledPaidTools)
      .where(
        and(
          eq(userDisabledPaidTools.orgId, orgId),
          eq(userDisabledPaidTools.userId, userId),
        ),
      )
      .orderBy(asc(userDisabledPaidTools.toolId));
    return rows.map((row) => {
      return row.toolId;
    });
  });
}

export function createAgentCustomConnectorDefinitions(
  orgId: string,
  ids: readonly string[],
) {
  return computed(async (get) => {
    if (ids.length === 0) {
      return [];
    }
    const rows = await get(db$)
      .select({
        connector: customConnectorDefinitionSelection(),
        oauthConfig: orgCustomConnectorOauthConfigs,
      })
      .from(orgCustomConnectors)
      .leftJoin(
        orgCustomConnectorOauthConfigs,
        and(
          eq(
            orgCustomConnectorOauthConfigs.connectorId,
            orgCustomConnectors.id,
          ),
          eq(orgCustomConnectorOauthConfigs.orgId, orgCustomConnectors.orgId),
        ),
      )
      .where(
        and(
          eq(orgCustomConnectors.orgId, orgId),
          eq(orgCustomConnectors.enabled, true),
          inArray(orgCustomConnectors.id, [...ids]),
        ),
      );
    return rows.map((row): CustomConnectorExecutionDefinition => {
      const definition = normaliseCustomConnectorRow(
        row.connector,
        row.oauthConfig,
      );
      const config = definition.oauthConfig;
      const shared = {
        id: definition.id,
        orgId: definition.orgId,
        slug: definition.slug,
        displayName: definition.displayName,
        fields: definition.fields,
        headerInjections: definition.headerInjections,
        queryInjections: definition.queryInjections,
        authMode: definition.authMode,
        skillMarkdown: definition.skillMarkdown,
        skillStorageVersionId: definition.skillStorageVersionId,
        storageVersion: definition.storageVersion,
        oauthConfig:
          config === null
            ? null
            : {
                providerAdapter: config.providerAdapter,
                clientId: config.clientId,
                encryptedClientSecret: config.encryptedClientSecret,
                authorizationUrl: config.authorizationUrl,
                tokenUrl: config.tokenUrl,
                tokenEndpointAuthMethod: config.tokenEndpointAuthMethod,
                pkceMethod: config.pkceMethod,
                scopes: config.scopes,
                authorizationParams: config.authorizationParams,
              },
      };
      return definition.kind === "http"
        ? {
            ...shared,
            kind: "http",
            prefixTemplates: definition.prefixTemplates,
            permissionBundleRef: definition.permissionBundleRef,
          }
        : {
            ...shared,
            kind: "mcp",
            endpoint: definition.endpoint,
            transport: definition.transport,
          };
    });
  });
}

export function createAgentEnvironment(userId: string, orgId: string) {
  return computed(async (get): Promise<BootstrapEnvironment> => {
    const rows = await get(db$)
      .select({
        name: variables.name,
        value: variables.value,
        userId: variables.userId,
      })
      .from(variables)
      .where(
        and(
          eq(variables.orgId, orgId),
          eq(variables.type, "user"),
          or(
            eq(variables.userId, ORG_SENTINEL_USER_ID),
            eq(variables.userId, userId),
          ),
        ),
      );
    return { variables: rows };
  });
}
