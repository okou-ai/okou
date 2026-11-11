import { connectors } from "@okouai/db/schema/connector";
import { customConnectorAccountOauthBindings } from "@okouai/db/schema/custom-connector-account-oauth-binding";
import { secrets } from "@okouai/db/schema/secret";
import { variables } from "@okouai/db/schema/variable";
import { computed, type Computed } from "ccstate";
import { and, eq, isNull, isNotNull, or, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { performance } from "node:perf_hooks";
import { array, object, record, string } from "zod";
import type { PgPoolAcquisition } from "../../lib/db-instrumentation";
import {
  nullableDriverValueDecoder,
  pgInt8ToBigIntDecoder,
  zodDriverValueDecoder,
} from "../../lib/db-structured-result";
import { now } from "../../lib/time";
import { db$ } from "../external/db";
import { safeSync } from "../utils";
import type { ConnectorSourceRow } from "./execution-connector-sources.service";
import { ORG_SENTINEL_USER_ID } from "./feature-switch-scope";

export interface BootstrapVariable {
  readonly name: string;
  readonly value: string;
  readonly userId: string;
}

/** Admission needs user variables, independently of connector accounts. */
export function createAgentRunVariables(
  identity$: Computed<
    Promise<{ readonly orgId: string; readonly userId: string }>
  >,
) {
  return computed(async (get) => {
    const identity = await get(identity$);
    return get(db$)
      .select({
        name: variables.name,
        value: variables.value,
        userId: variables.userId,
      })
      .from(variables)
      .where(
        and(
          eq(variables.orgId, identity.orgId),
          eq(variables.type, "user"),
          isNull(variables.connectorId),
          or(
            eq(variables.userId, identity.userId),
            eq(variables.userId, ORG_SENTINEL_USER_ID),
          ),
        ),
      );
  });
}

export interface ConnectorContextDuration {
  readonly durationMs: number;
  readonly finishedAt: number;
}

export interface BootstrapEnvironmentObservation {
  readonly query: ConnectorContextDuration | undefined;
  readonly materialize: ConnectorContextDuration | undefined;
  readonly acquisitions: readonly PgPoolAcquisition[];
  readonly returnedRowCount: number;
  readonly accountCount: number;
  readonly customAccountCount: number;
  readonly storedValueCount: number;
}

export function connectorContextDuration(
  startedAt: number,
): ConnectorContextDuration | undefined {
  const result = safeSync(() => {
    return {
      durationMs: Math.max(0, performance.now() - startedAt),
      finishedAt: now(),
    };
  });
  return "ok" in result ? result.ok : undefined;
}

function bootstrapEnvironmentObservation(args: {
  readonly query: ConnectorContextDuration | undefined;
  readonly materialize: ConnectorContextDuration | undefined;
  readonly acquisitions: readonly PgPoolAcquisition[];
  readonly returnedRowCount: number;
  readonly accounts: readonly Pick<ConnectorSourceRow, "customConnectorId">[];
  readonly storedValueCount: number;
}): BootstrapEnvironmentObservation | undefined {
  const result = safeSync(() => {
    return {
      query: args.query,
      materialize: args.materialize,
      acquisitions: [...args.acquisitions],
      returnedRowCount: args.returnedRowCount,
      accountCount: args.accounts.length,
      customAccountCount: args.accounts.filter((account) => {
        return account.customConnectorId !== null;
      }).length,
      storedValueCount: args.storedValueCount,
    };
  });
  return "ok" in result ? result.ok : undefined;
}

const bootstrapConnectorVariablesDecoder = zodDriverValueDecoder(
  record(string(), string()),
);
const bootstrapCredentialsDecoder = zodDriverValueDecoder(
  array(
    object({
      id: string(),
      name: string(),
      encryptedValue: string(),
    }),
  ),
);

function bootstrapConnectorAccountColumns() {
  return {
    id: connectors.id,
    connectorSlug: connectors.connectorSlug,
    customConnectorId: connectors.customConnectorId,
    isDefault: connectors.isDefault,
    defaultEnabledForChats: connectors.defaultEnabledForChats,
    createdAt: connectors.createdAt,
    automaticAuthType: connectors.automaticAuthType,
    connectorStateRevision:
      sql`(EXTRACT(EPOCH FROM ${connectors.updatedAt}) * 1000000)::bigint`
        .mapWith(pgInt8ToBigIntDecoder)
        .as("connector_state_revision"),
    needsReconnect: connectors.needsReconnect,
    authMethod: connectors.authMethod,
    storageVersion: connectors.storageVersion,
    tokenExpiresAt: connectors.tokenExpiresAt,
    updatedAt: connectors.updatedAt,
    orgId: connectors.orgId,
    userId: connectors.userId,
  };
}

export type BootstrapEnvironmentSnapshot = ReturnType<
  typeof materializeConnectorEnvironment
>;

export function connectorEnvironmentRead({
  userId,
  orgId,
}: {
  readonly userId: string;
  readonly orgId: string;
}) {
  const variableRows = bootstrapVariableRows(userId, orgId);
  const connectorVariableSnapshot =
    bootstrapConnectorVariableSnapshot(variableRows);
  const credentialSnapshot = bootstrapCredentialSnapshot(userId, orgId);
  // A single statement owns the account revision and its credential values.
  // Keep one seed row even when this member has no connector accounts.
  return new QueryBuilder()
    .with(variableRows, connectorVariableSnapshot, credentialSnapshot)
    .select({
      account: bootstrapConnectorAccountColumns(),
      connectorVariables: connectorVariableSnapshot.values,
      credentials: credentialSnapshot.values,
      automaticOAuthBindingId:
        customConnectorAccountOauthBindings.connectorAccountId,
    })
    .from(sql`(values (1)) as connector_seed(value)`)
    .leftJoin(
      connectors,
      and(eq(connectors.orgId, orgId), eq(connectors.userId, userId)),
    )
    .leftJoin(
      connectorVariableSnapshot,
      eq(connectorVariableSnapshot.connectorId, connectors.id),
    )
    .leftJoin(
      credentialSnapshot,
      eq(credentialSnapshot.connectorId, connectors.id),
    )
    .leftJoin(
      customConnectorAccountOauthBindings,
      and(
        eq(
          customConnectorAccountOauthBindings.connectorAccountId,
          connectors.id,
        ),
        eq(
          customConnectorAccountOauthBindings.customConnectorId,
          connectors.customConnectorId,
        ),
      ),
    )
    .as("connector_environment_sources");
}

type EnvironmentAccount = Pick<
  typeof connectors.$inferSelect,
  Exclude<
    keyof ReturnType<typeof bootstrapConnectorAccountColumns>,
    "connectorStateRevision"
  >
> & { readonly connectorStateRevision: bigint };

export interface ConnectorEnvironmentRow {
  readonly account:
    | { readonly [K in keyof EnvironmentAccount]: EnvironmentAccount[K] | null }
    | null;
  readonly connectorVariables: Readonly<Record<string, string>> | null;
  readonly credentials:
    | readonly {
        readonly id: string;
        readonly name: string;
        readonly encryptedValue: string;
      }[]
    | null;
  readonly automaticOAuthBindingId: string | null;
}

function environmentAccount(
  account: ConnectorEnvironmentRow["account"],
): EnvironmentAccount | null {
  if (!account?.id) {
    return null;
  }
  const {
    id,
    isDefault,
    defaultEnabledForChats,
    createdAt,
    connectorStateRevision,
    needsReconnect,
    authMethod,
    storageVersion,
    updatedAt,
    orgId,
    userId,
  } = account;
  if (
    isDefault === null ||
    defaultEnabledForChats === null ||
    createdAt === null ||
    connectorStateRevision === null ||
    needsReconnect === null ||
    authMethod === null ||
    storageVersion === null ||
    updatedAt === null ||
    orgId === null ||
    userId === null
  ) {
    throw new Error("Connector environment returned an incomplete account");
  }
  return {
    ...account,
    id,
    isDefault,
    defaultEnabledForChats,
    createdAt,
    connectorStateRevision,
    needsReconnect,
    authMethod,
    storageVersion,
    updatedAt,
    orgId,
    userId,
  };
}

export function materializeConnectorEnvironment(
  rows: readonly ConnectorEnvironmentRow[],
  observation: {
    readonly query: ConnectorContextDuration | undefined;
    readonly acquisitions: readonly PgPoolAcquisition[];
  },
) {
  const materializeStartedAt = performance.now();
  const [first] = rows;
  if (!first) {
    throw new Error("Bootstrap environment aggregate returned no row");
  }
  const snapshot = {
    accounts: rows.flatMap((row) => {
      const account = environmentAccount(row.account);
      return account
        ? [
            {
              ...account,
              automaticOAuthBindingId: row.automaticOAuthBindingId,
            },
          ]
        : [];
    }),
    values: {
      variables: rows.flatMap((row) => {
        const account = row.account;
        return account?.id
          ? Object.entries(row.connectorVariables ?? {}).map(
              ([name, value]) => {
                return { sourceId: account.id, name, value };
              },
            )
          : [];
      }),
      credentials: rows.flatMap((row) => {
        const account = row.account;
        return account?.id
          ? (row.credentials ?? []).map((credential) => {
              return { ...credential, sourceId: account.id };
            })
          : [];
      }),
    },
  };
  return {
    ...snapshot,
    observation: bootstrapEnvironmentObservation({
      ...observation,
      materialize: connectorContextDuration(materializeStartedAt),
      returnedRowCount: rows.length,
      accounts: snapshot.accounts,
      storedValueCount:
        snapshot.values.variables.length + snapshot.values.credentials.length,
    }),
  };
}

function bootstrapVariableRows(userId: string, orgId: string) {
  const db = new QueryBuilder();
  return db.$with("bootstrap_variables").as(
    db
      .select({
        name: variables.name,
        value: variables.value,
        userId: variables.userId,
        connectorId: variables.connectorId,
      })
      .from(variables)
      .where(
        and(
          eq(variables.orgId, orgId),
          eq(variables.type, "connector"),
          eq(variables.userId, userId),
        ),
      ),
  );
}

function bootstrapConnectorVariableSnapshot(
  rows: ReturnType<typeof bootstrapVariableRows>,
) {
  const db = new QueryBuilder();
  return db.$with("bootstrap_connector_variables").as(
    db
      .select({
        connectorId: rows.connectorId,
        values: sql`jsonb_object_agg(${rows.name}, ${rows.value})`
          .mapWith(
            nullableDriverValueDecoder(bootstrapConnectorVariablesDecoder),
          )
          .as("connector_variable_values"),
      })
      .from(rows)
      .where(isNotNull(rows.connectorId))
      .groupBy(rows.connectorId),
  );
}

function bootstrapCredentialSnapshot(userId: string, orgId: string) {
  const db = new QueryBuilder();
  return db.$with("bootstrap_credentials").as(
    db
      .select({
        connectorId: secrets.connectorId,
        values: sql`jsonb_agg(jsonb_build_object(
          'id', ${secrets.id}, 'name', ${secrets.name}, 'encryptedValue', ${secrets.encryptedValue}
        ))`
          .mapWith(nullableDriverValueDecoder(bootstrapCredentialsDecoder))
          .as("credential_values"),
      })
      .from(secrets)
      .where(
        and(
          eq(secrets.orgId, orgId),
          eq(secrets.userId, userId),
          eq(secrets.type, "connector"),
        ),
      )
      .groupBy(secrets.connectorId),
  );
}
