import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { orgCustomConnectorOauthConfigs } from "@okouai/db/schema/org-custom-connector-oauth-config";
import { userDisabledPaidTools } from "@okouai/db/schema/user-disabled-paid-tools";
import { variables } from "@okouai/db/schema/variable";
import { secrets as secretsTable } from "@okouai/db/schema/secret";
import { computed } from "ccstate";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { zodEnumDriverValueDecoder } from "../../lib/db-structured-result";
import { db$ } from "../external/db";
import { ORG_SENTINEL_USER_ID } from "./feature-switch-scope";
import type {
  BootstrapEnvironment,
  BootstrapVariable,
  BootstrapEncryptedSecret,
} from "./agent-bootstrap.service";
import {
  customConnectorDefinitionSelection,
  type CustomConnectorExecutionDefinition,
} from "./custom-connector-definition-selection";
import { normaliseCustomConnectorRow } from "./custom-connector.service";

const environmentRowKindDecoder = zodEnumDriverValueDecoder(
  z.enum(["variable", "secret"]),
);

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

export function createAgentEnvironment(
  userId: string,
  orgId: string,
  secretNames: readonly string[],
) {
  return computed(async (get): Promise<BootstrapEnvironment> => {
    const db = get(db$);
    const variableQuery = db
      .select({
        kind: sql`'variable'`.mapWith(environmentRowKindDecoder).as("kind"),
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
    const rows =
      secretNames.length > 0
        ? await variableQuery.unionAll(
            db
              .select({
                kind: sql`'secret'`
                  .mapWith(environmentRowKindDecoder)
                  .as("kind"),
                name: secretsTable.name,
                value: secretsTable.encryptedValue,
                userId: secretsTable.userId,
              })
              .from(secretsTable)
              .where(
                and(
                  eq(secretsTable.orgId, orgId),
                  eq(secretsTable.type, "user"),
                  or(
                    eq(secretsTable.userId, ORG_SENTINEL_USER_ID),
                    eq(secretsTable.userId, userId),
                  ),
                  inArray(secretsTable.name, [...secretNames]),
                ),
              ),
          )
        : await variableQuery;
    const variableRows: BootstrapVariable[] = [];
    const secretRows: BootstrapEncryptedSecret[] = [];
    for (const row of rows) {
      if (row.kind === "variable") {
        variableRows.push({
          name: row.name,
          value: row.value,
          userId: row.userId,
        });
      } else {
        secretRows.push({
          name: row.name,
          encryptedValue: row.value,
          userId: row.userId,
        });
      }
    }
    return {
      requestedSecretNames: secretNames,
      variables: variableRows,
      secrets: secretRows,
    };
  });
}
