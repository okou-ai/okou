import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
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
import {
  ORG_SENTINEL_USER_ID,
  type DisabledPaidToolsSnapshot,
  type RunMemberSnapshot,
  type PersistedRunEnvironmentSecret,
  type PersistedRunEnvironmentVariable,
} from "./agent-run-execution.service";
import { customConnectorDefinitionSelection } from "./custom-connector-definition-selection";
import { normaliseCustomConnectorRow } from "./custom-connector.service";

const environmentRowKindDecoder = zodEnumDriverValueDecoder(
  z.enum(["variable", "secret"]),
);

export function createAgentDisabledPaidTools(userId: string, orgId: string) {
  return computed(async (get): Promise<DisabledPaidToolsSnapshot> => {
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
    return {
      orgId,
      userId,
      toolIds: rows.map((row) => {
        return row.toolId;
      }),
    };
  });
}

export function createAgentMemberSnapshot(userId: string, orgId: string) {
  return computed(async (get): Promise<RunMemberSnapshot> => {
    const [member] = await get(db$)
      .select({
        timezone: orgMembersMetadata.timezone,
        selectedImageModel: orgMembersMetadata.selectedImageModel,
      })
      .from(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, orgId),
          eq(orgMembersMetadata.userId, userId),
        ),
      )
      .limit(1);
    return { orgId, userId, member };
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
    return rows.map((row) => {
      return normaliseCustomConnectorRow(row.connector, row.oauthConfig);
    });
  });
}

export interface AgentEnvironmentSnapshot {
  readonly orgId: string;
  readonly userId: string;
  readonly secretNames: readonly string[];
  readonly variables: readonly PersistedRunEnvironmentVariable[];
  readonly secrets: readonly PersistedRunEnvironmentSecret[];
}

export function createAgentEnvironment(
  userId: string,
  orgId: string,
  secretNames: readonly string[],
) {
  return computed(async (get): Promise<AgentEnvironmentSnapshot> => {
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
    const variableRows: PersistedRunEnvironmentVariable[] = [];
    const secretRows: PersistedRunEnvironmentSecret[] = [];
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
      orgId,
      userId,
      secretNames,
      variables: variableRows,
      secrets: secretRows,
    };
  });
}
