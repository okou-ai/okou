import {
  and,
  eq,
  inArray,
  ne,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import {
  orgCustomConnectors,
  type OrgCustomConnectorAuthMode,
  type OrgCustomConnectorMcpTransport,
} from "@okouai/db/schema/org-custom-connector";
import { connectors } from "@okouai/db/schema/connector";
import { customConnectorAccountOauthBindings } from "@okouai/db/schema/custom-connector-account-oauth-binding";
import { secrets } from "@okouai/db/schema/secret";
import { variables } from "@okouai/db/schema/variable";
import { alias, unionAll } from "drizzle-orm/pg-core";
import { z } from "zod";

import {
  pgTextDecoder,
  zodEnumDriverValueDecoder,
} from "../../lib/db-structured-result";
import { nowDate } from "../../lib/time";
import type { ReadonlyDb } from "../external/db";
import {
  connectorCredentialStatusForAccess,
  connectorRuntimeCredentialStatusForAccess,
} from "./connector-credential-status.service";

const OAUTH_ACCESS_TOKEN_SECRET_NAME = "access_token";
const OAUTH_REFRESH_TOKEN_SECRET_NAME = "refresh_token";
const customConnectorRuntimeStorageKindSchema = z.enum(["secret", "variable"]);
type CustomConnectorRuntimeStorageKind = z.output<
  typeof customConnectorRuntimeStorageKindSchema
>;
const customConnectorRuntimeStorageKindDecoder = zodEnumDriverValueDecoder(
  customConnectorRuntimeStorageKindSchema,
);

const customConnectorAccessTokenSecret = alias(
  secrets,
  "custom_connector_access_token_secret",
);
const customConnectorRefreshTokenSecret = alias(
  secrets,
  "custom_connector_refresh_token_secret",
);

export interface CustomConnectorCredentialValueMarker {
  readonly connectorId: string;
  readonly authMode: OrgCustomConnectorAuthMode;
  readonly storageVersion: number;
  readonly kind: "secret" | "variable";
  readonly key: string;
}

export type CustomConnectorStoredValue =
  | {
      readonly connectorId: string;
      readonly kind: "secret";
      readonly key: string;
      readonly encryptedValue: string;
    }
  | {
      readonly connectorId: string;
      readonly kind: "variable";
      readonly key: string;
      readonly value: string;
    };

interface CustomConnectorCredentialDefinition {
  readonly id: string;
  readonly authMode: OrgCustomConnectorAuthMode;
  readonly storageVersion: number;
}

interface CustomConnectorStoredConnection {
  readonly id: string;
  readonly updatedAt: Date;
  readonly customConnectorId: string;
  readonly storedAuthMethod: string;
  readonly storedStorageVersion: number;
  readonly storedNeedsReconnect: boolean;
  readonly tokenExpiresAt: Date | null;
  readonly definitionAuthMethod: OrgCustomConnectorAuthMode;
  readonly definitionMcpTransport: OrgCustomConnectorMcpTransport | null;
  readonly definitionStorageVersion: number;
  readonly oauthAccessTokenId: string | null;
  readonly oauthRefreshTokenId: string | null;
  readonly automaticOAuthBindingId: string | null;
}

interface ConnectedCustomConnectorConnection {
  readonly id: string;
  readonly updatedAt: Date;
  readonly authMode: OrgCustomConnectorAuthMode;
  readonly storageVersion: number;
}

interface ConnectedCustomConnectorAccount {
  readonly id: string;
  readonly updatedAt: Date;
}

export type CustomConnectorCredentialAccess =
  | { readonly kind: "absent" }
  | {
      readonly kind: "current";
      readonly memberConnectorId: string;
      readonly resolvedAuthMethod: "none" | "manual" | "oauth";
      readonly connected: boolean;
      readonly runtimeAvailable: boolean;
    }
  | {
      readonly kind: "incompatible";
      readonly memberConnectorId: string;
      readonly expectedAuthMethod: OrgCustomConnectorAuthMode;
      readonly storedAuthMethod: string;
      readonly expectedStorageVersion: number;
      readonly storedStorageVersion: number;
      readonly definitionAuthMethod: OrgCustomConnectorAuthMode;
      readonly definitionStorageVersion: number;
    };

interface CustomConnectorRuntimeStorageSnapshot {
  readonly accesses: ReadonlyMap<string, CustomConnectorCredentialAccess>;
  readonly values: readonly CustomConnectorStoredValue[];
}

interface CustomConnectorRuntimeStorageRow extends CustomConnectorStoredConnection {
  readonly kind: CustomConnectorRuntimeStorageKind | null;
  readonly key: string | null;
  readonly storedValue: string | null;
}

function customConnectorStoredConnectionsQuery(
  db: Pick<ReadonlyDb, "select">,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorIds?: readonly string[];
    readonly memberConnectorIds?: readonly string[];
    readonly defaultOnly?: boolean;
  },
) {
  return db
    .select({
      id: sql`${connectors.id}`
        .mapWith(connectors.id)
        .as("member_connector_id"),
      updatedAt: connectors.updatedAt,
      customConnectorId: sql`${orgCustomConnectors.id}`
        .mapWith(orgCustomConnectors.id)
        .as("custom_connector_id"),
      storedAuthMethod: sql`${connectors.authMethod}`
        .mapWith(connectors.authMethod)
        .as("stored_auth_method"),
      storedStorageVersion: sql`${connectors.storageVersion}`
        .mapWith(connectors.storageVersion)
        .as("stored_storage_version"),
      storedNeedsReconnect: sql`${connectors.needsReconnect}`
        .mapWith(connectors.needsReconnect)
        .as("stored_needs_reconnect"),
      tokenExpiresAt: sql`${connectors.tokenExpiresAt}`
        .mapWith(connectors.tokenExpiresAt)
        .as("token_expires_at"),
      definitionAuthMethod: sql`${orgCustomConnectors.authMode}`
        .mapWith(orgCustomConnectors.authMode)
        .as("definition_auth_method"),
      definitionMcpTransport: orgCustomConnectors.mcpTransport,
      definitionStorageVersion: sql`${orgCustomConnectors.storageVersion}`
        .mapWith(orgCustomConnectors.storageVersion)
        .as("definition_storage_version"),
      oauthAccessTokenId: sql`${customConnectorAccessTokenSecret.id}`
        .mapWith(customConnectorAccessTokenSecret.id)
        .as("oauth_access_token_id"),
      oauthRefreshTokenId: sql`${customConnectorRefreshTokenSecret.id}`
        .mapWith(customConnectorRefreshTokenSecret.id)
        .as("oauth_refresh_token_id"),
      automaticOAuthBindingId:
        sql`${customConnectorAccountOauthBindings.connectorAccountId}`
          .mapWith(customConnectorAccountOauthBindings.connectorAccountId)
          .as("automatic_oauth_binding_id"),
    })
    .from(connectors)
    .innerJoin(
      orgCustomConnectors,
      and(
        eq(orgCustomConnectors.id, connectors.customConnectorId),
        eq(orgCustomConnectors.orgId, connectors.orgId),
      ),
    )
    .leftJoin(
      customConnectorAccessTokenSecret,
      and(
        eq(customConnectorAccessTokenSecret.connectorId, connectors.id),
        eq(
          customConnectorAccessTokenSecret.name,
          OAUTH_ACCESS_TOKEN_SECRET_NAME,
        ),
      ),
    )
    .leftJoin(
      customConnectorRefreshTokenSecret,
      and(
        eq(customConnectorRefreshTokenSecret.connectorId, connectors.id),
        eq(
          customConnectorRefreshTokenSecret.name,
          OAUTH_REFRESH_TOKEN_SECRET_NAME,
        ),
      ),
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
          orgCustomConnectors.id,
        ),
      ),
    )
    .where(
      and(
        eq(connectors.orgId, args.orgId),
        eq(connectors.userId, args.userId),
        args.defaultOnly ? eq(connectors.isDefault, true) : undefined,
        args.connectorIds
          ? inArray(connectors.customConnectorId, [...args.connectorIds])
          : undefined,
        args.memberConnectorIds
          ? inArray(connectors.id, [...args.memberConnectorIds])
          : undefined,
      ),
    );
}

async function loadCustomConnectorStoredConnections(
  db: Pick<ReadonlyDb, "select">,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorIds?: readonly string[];
  },
): Promise<readonly CustomConnectorStoredConnection[]> {
  if (args.connectorIds?.length === 0) {
    return [];
  }
  return await customConnectorStoredConnectionsQuery(db, {
    ...args,
    defaultOnly: true,
  });
}

export function customConnectorAccountAuthMethodIsCompatible(
  definitionAuthMethod: OrgCustomConnectorAuthMode,
  storedAuthMethod: string,
): storedAuthMethod is "none" | "manual" | "oauth" {
  if (definitionAuthMethod === "automatic") {
    return storedAuthMethod === "none" || storedAuthMethod === "oauth";
  }
  return storedAuthMethod === definitionAuthMethod;
}

function resolveCustomConnectorAccountAuthMethod(
  definitionAuthMethod: OrgCustomConnectorAuthMode,
  storedAuthMethod: string,
): "none" | "manual" | "oauth" | null {
  return customConnectorAccountAuthMethodIsCompatible(
    definitionAuthMethod,
    storedAuthMethod,
  )
    ? storedAuthMethod
    : null;
}

function customConnectorStoredAuthMethodIsCompatibleSql(args: {
  readonly definitionAuthMethod: SQLWrapper;
  readonly storedAuthMethod: SQLWrapper;
}): SQL {
  return or(
    eq(args.definitionAuthMethod, args.storedAuthMethod),
    and(
      eq(args.definitionAuthMethod, "automatic"),
      inArray(args.storedAuthMethod, ["none", "oauth"]),
    ),
  )!;
}

export function customConnectorAccountStorageIsCompatible(args: {
  readonly authMethod: string;
  readonly mcpTransport: OrgCustomConnectorMcpTransport | null;
  readonly storageVersion: number;
  readonly definitionStorageVersion: number;
}): boolean {
  return (
    (args.authMethod === "none" && args.mcpTransport !== null) ||
    args.storageVersion === args.definitionStorageVersion
  );
}

function customConnectorStoredConnectionIsCurrent(
  connection: CustomConnectorStoredConnection,
): boolean {
  return (
    resolveCustomConnectorAccountAuthMethod(
      connection.definitionAuthMethod,
      connection.storedAuthMethod,
    ) !== null &&
    customConnectorAccountStorageIsCompatible({
      authMethod: connection.storedAuthMethod,
      mcpTransport: connection.definitionMcpTransport,
      storageVersion: connection.storedStorageVersion,
      definitionStorageVersion: connection.definitionStorageVersion,
    })
  );
}

export function customConnectorAccountHasRequiredCredentialMaterial(args: {
  readonly definitionAuthMode: OrgCustomConnectorAuthMode;
  readonly storedAuthMethod: string;
  readonly hasAccessToken: boolean;
  readonly hasAutomaticOAuthBinding: boolean;
}): boolean {
  if (
    !customConnectorAccountAuthMethodIsCompatible(
      args.definitionAuthMode,
      args.storedAuthMethod,
    )
  ) {
    return false;
  }
  if (args.storedAuthMethod === "none") {
    return true;
  }
  if (args.definitionAuthMode === "automatic") {
    return args.hasAccessToken && args.hasAutomaticOAuthBinding;
  }
  return (
    args.definitionAuthMode === "manual" ||
    (args.hasAccessToken && !args.hasAutomaticOAuthBinding)
  );
}

function customConnectorStoredConnectionHasRequiredMaterial(
  connection: CustomConnectorStoredConnection,
): boolean {
  return customConnectorAccountHasRequiredCredentialMaterial({
    definitionAuthMode: connection.definitionAuthMethod,
    storedAuthMethod: connection.storedAuthMethod,
    hasAccessToken: connection.oauthAccessTokenId !== null,
    hasAutomaticOAuthBinding: connection.automaticOAuthBindingId !== null,
  });
}

function customConnectorStoredConnectionIsConnected(
  connection: CustomConnectorStoredConnection,
  now: Date,
): boolean {
  if (!customConnectorStoredConnectionIsCurrent(connection)) {
    return false;
  }
  if (connection.storedAuthMethod === "none") {
    return true;
  }
  const credentialStatus = connectorCredentialStatusForAccess({
    storedNeedsReconnect: connection.storedNeedsReconnect,
    tokenExpiresAt:
      connection.storedAuthMethod === "oauth"
        ? connection.tokenExpiresAt
        : null,
    now,
    isRefreshable: connection.oauthRefreshTokenId !== null,
  });
  return (
    credentialStatus === "available" &&
    customConnectorStoredConnectionHasRequiredMaterial(connection)
  );
}

function currentCustomConnectorStoredConnectionIsRuntimeAvailable(
  connection: CustomConnectorStoredConnection,
  now: Date,
): boolean {
  if (connection.storedAuthMethod === "none") {
    return true;
  }
  return (
    connectorRuntimeCredentialStatusForAccess({
      storedNeedsReconnect: connection.storedNeedsReconnect,
      tokenExpiresAt:
        connection.storedAuthMethod === "oauth"
          ? connection.tokenExpiresAt
          : null,
      now,
      isRefreshable: connection.storedAuthMethod === "oauth",
    }) === "available"
  );
}

function customConnectorCredentialAccesses(
  definitions: readonly CustomConnectorCredentialDefinition[],
  rows: readonly CustomConnectorStoredConnection[],
  memberConnectorIdsByCustomConnectorId: ReadonlyMap<string, string>,
): ReadonlyMap<string, CustomConnectorCredentialAccess> {
  const memberById = new Map<string, CustomConnectorStoredConnection>();
  for (const row of rows) {
    memberById.set(row.id, row);
  }

  const accesses = new Map<string, CustomConnectorCredentialAccess>();
  const now = nowDate();
  for (const definition of definitions) {
    const memberConnectorId = memberConnectorIdsByCustomConnectorId.get(
      definition.id,
    );
    const member = memberConnectorId
      ? memberById.get(memberConnectorId)
      : undefined;
    const resolvedAuthMethod = member
      ? resolveCustomConnectorAccountAuthMethod(
          member.definitionAuthMethod,
          member.storedAuthMethod,
        )
      : null;
    if (!member || member.customConnectorId !== definition.id) {
      accesses.set(definition.id, { kind: "absent" });
    } else if (
      member.definitionAuthMethod === definition.authMode &&
      member.definitionStorageVersion === definition.storageVersion &&
      resolvedAuthMethod !== null &&
      customConnectorStoredConnectionIsCurrent(member)
    ) {
      accesses.set(definition.id, {
        kind: "current",
        memberConnectorId: member.id,
        resolvedAuthMethod,
        connected: customConnectorStoredConnectionIsConnected(member, now),
        runtimeAvailable:
          customConnectorStoredConnectionHasRequiredMaterial(member) &&
          currentCustomConnectorStoredConnectionIsRuntimeAvailable(member, now),
      });
    } else {
      accesses.set(definition.id, {
        kind: "incompatible",
        memberConnectorId: member.id,
        expectedAuthMethod: definition.authMode,
        storedAuthMethod: member.storedAuthMethod,
        expectedStorageVersion: definition.storageVersion,
        storedStorageVersion: member.storedStorageVersion,
        definitionAuthMethod: member.definitionAuthMethod,
        definitionStorageVersion: member.definitionStorageVersion,
      });
    }
  }
  return accesses;
}

function customConnectorRuntimeStorageSnapshot(
  definitions: readonly CustomConnectorCredentialDefinition[],
  rows: readonly CustomConnectorRuntimeStorageRow[],
  memberConnectorIdsByCustomConnectorId: ReadonlyMap<string, string>,
): CustomConnectorRuntimeStorageSnapshot {
  const connectionsById = new Map<string, CustomConnectorStoredConnection>();
  for (const row of rows) {
    connectionsById.set(row.id, row);
  }
  const accesses = customConnectorCredentialAccesses(
    definitions,
    [...connectionsById.values()],
    memberConnectorIdsByCustomConnectorId,
  );
  const expectedByMemberConnectorId = new Map(
    definitions.flatMap((definition) => {
      const access = accesses.get(definition.id);
      return access?.kind === "current"
        ? ([[access.memberConnectorId, definition]] as const)
        : [];
    }),
  );
  const values: CustomConnectorStoredValue[] = [];
  for (const row of rows) {
    const expected = expectedByMemberConnectorId.get(row.id);
    if (
      !expected ||
      row.kind === null ||
      row.customConnectorId !== expected.id ||
      row.definitionAuthMethod !== expected.authMode ||
      row.definitionStorageVersion !== expected.storageVersion
    ) {
      continue;
    }
    if (row.key === null || row.storedValue === null) {
      throw new Error("Expected a complete custom connector stored value row");
    }
    if (row.kind === "secret") {
      values.push({
        connectorId: row.customConnectorId,
        kind: "secret",
        key: row.key,
        encryptedValue: row.storedValue,
      });
    } else {
      values.push({
        connectorId: row.customConnectorId,
        kind: "variable",
        key: row.key,
        value: row.storedValue,
      });
    }
  }
  return { accesses, values };
}

export async function loadCurrentCustomConnectorValueMarkers(
  db: Pick<ReadonlyDb, "select">,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorIds?: readonly string[];
  },
): Promise<readonly CustomConnectorCredentialValueMarker[]> {
  if (args.connectorIds?.length === 0) {
    return [];
  }
  const secretQuery = db
    .select({
      connectorId: orgCustomConnectors.id,
      authMode: orgCustomConnectors.authMode,
      storageVersion: orgCustomConnectors.storageVersion,
      kind: sql`'secret'`.mapWith(pgTextDecoder).as("kind"),
      key: secrets.name,
    })
    .from(secrets)
    .innerJoin(
      connectors,
      and(
        eq(connectors.id, secrets.connectorId),
        eq(connectors.orgId, secrets.orgId),
        eq(connectors.userId, secrets.userId),
      ),
    )
    .innerJoin(
      orgCustomConnectors,
      and(
        eq(orgCustomConnectors.id, connectors.customConnectorId),
        eq(orgCustomConnectors.orgId, connectors.orgId),
        customConnectorStoredAuthMethodIsCompatibleSql({
          definitionAuthMethod: orgCustomConnectors.authMode,
          storedAuthMethod: connectors.authMethod,
        }),
        eq(orgCustomConnectors.storageVersion, connectors.storageVersion),
      ),
    )
    .where(
      and(
        eq(secrets.type, "connector"),
        eq(secrets.orgId, args.orgId),
        eq(secrets.userId, args.userId),
        eq(connectors.isDefault, true),
        args.connectorIds
          ? inArray(orgCustomConnectors.id, [...args.connectorIds])
          : undefined,
      ),
    );
  const variableQuery = db
    .select({
      connectorId: orgCustomConnectors.id,
      authMode: orgCustomConnectors.authMode,
      storageVersion: orgCustomConnectors.storageVersion,
      kind: sql`'variable'`.mapWith(pgTextDecoder).as("kind"),
      key: variables.name,
    })
    .from(variables)
    .innerJoin(
      connectors,
      and(
        eq(connectors.id, variables.connectorId),
        eq(connectors.orgId, variables.orgId),
        eq(connectors.userId, variables.userId),
      ),
    )
    .innerJoin(
      orgCustomConnectors,
      and(
        eq(orgCustomConnectors.id, connectors.customConnectorId),
        eq(orgCustomConnectors.orgId, connectors.orgId),
        customConnectorStoredAuthMethodIsCompatibleSql({
          definitionAuthMethod: orgCustomConnectors.authMode,
          storedAuthMethod: connectors.authMethod,
        }),
        eq(orgCustomConnectors.storageVersion, connectors.storageVersion),
      ),
    )
    .where(
      and(
        eq(variables.type, "connector"),
        eq(variables.orgId, args.orgId),
        eq(variables.userId, args.userId),
        eq(connectors.isDefault, true),
        args.connectorIds
          ? inArray(orgCustomConnectors.id, [...args.connectorIds])
          : undefined,
      ),
    );
  const rows = await secretQuery.unionAll(variableQuery);
  return rows.flatMap(
    (row): readonly CustomConnectorCredentialValueMarker[] => {
      return row.kind === "secret" || row.kind === "variable"
        ? [
            {
              connectorId: row.connectorId,
              authMode: row.authMode,
              storageVersion: row.storageVersion,
              kind: row.kind,
              key: row.key,
            },
          ]
        : [];
    },
  );
}

export async function loadCurrentCustomConnectorStoredValues(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly definitions: readonly CustomConnectorCredentialDefinition[];
    readonly memberConnectorIdsByCustomConnectorId: ReadonlyMap<string, string>;
  },
): Promise<CustomConnectorRuntimeStorageSnapshot> {
  if (args.definitions.length === 0) {
    return { accesses: new Map(), values: [] };
  }

  const connectorIds = args.definitions.map((definition) => {
    return definition.id;
  });
  const memberConnectorIds = args.definitions.flatMap((definition) => {
    const memberConnectorId = args.memberConnectorIdsByCustomConnectorId.get(
      definition.id,
    );
    return memberConnectorId ? [memberConnectorId] : [];
  });
  if (memberConnectorIds.length === 0) {
    return customConnectorRuntimeStorageSnapshot(
      args.definitions,
      [],
      args.memberConnectorIdsByCustomConnectorId,
    );
  }
  const storedConnections = db.$with("custom_connector_runtime_connections").as(
    customConnectorStoredConnectionsQuery(db, {
      orgId: args.orgId,
      userId: args.userId,
      connectorIds,
      memberConnectorIds,
    }),
  );
  const authMethodCurrent = customConnectorStoredAuthMethodIsCompatibleSql({
    definitionAuthMethod: storedConnections.definitionAuthMethod,
    storedAuthMethod: storedConnections.storedAuthMethod,
  });
  const storageVersionCurrent = eq(
    storedConnections.storedStorageVersion,
    storedConnections.definitionStorageVersion,
  );
  const secretQuery = db
    .select({
      memberConnectorId: sql`${storedConnections.id}`
        .mapWith(pgTextDecoder)
        .as("value_member_connector_id"),
      kind: sql`'secret'`
        .mapWith(customConnectorRuntimeStorageKindDecoder)
        .as("kind"),
      key: secrets.name,
      storedValue: secrets.encryptedValue,
    })
    .from(storedConnections)
    .innerJoin(secrets, eq(secrets.connectorId, storedConnections.id))
    .where(
      and(
        eq(secrets.type, "connector"),
        eq(secrets.orgId, args.orgId),
        eq(secrets.userId, args.userId),
        authMethodCurrent,
        storageVersionCurrent,
        ne(storedConnections.storedAuthMethod, "none"),
      ),
    );
  const variableQuery = db
    .select({
      memberConnectorId: sql`${storedConnections.id}`
        .mapWith(pgTextDecoder)
        .as("value_member_connector_id"),
      kind: sql`'variable'`
        .mapWith(customConnectorRuntimeStorageKindDecoder)
        .as("kind"),
      key: variables.name,
      storedValue: variables.value,
    })
    .from(storedConnections)
    .innerJoin(variables, eq(variables.connectorId, storedConnections.id))
    .where(
      and(
        eq(variables.type, "connector"),
        eq(variables.orgId, args.orgId),
        eq(variables.userId, args.userId),
        authMethodCurrent,
        storageVersionCurrent,
      ),
    );
  const storedValues = db
    .$with("custom_connector_runtime_values")
    .as(unionAll(secretQuery, variableQuery));
  const rows = await db
    .with(storedConnections, storedValues)
    .select({
      id: storedConnections.id,
      updatedAt: storedConnections.updatedAt,
      customConnectorId: storedConnections.customConnectorId,
      storedAuthMethod: storedConnections.storedAuthMethod,
      storedStorageVersion: storedConnections.storedStorageVersion,
      storedNeedsReconnect: storedConnections.storedNeedsReconnect,
      tokenExpiresAt: storedConnections.tokenExpiresAt,
      definitionAuthMethod: storedConnections.definitionAuthMethod,
      definitionMcpTransport: storedConnections.definitionMcpTransport,
      definitionStorageVersion: storedConnections.definitionStorageVersion,
      oauthAccessTokenId: storedConnections.oauthAccessTokenId,
      oauthRefreshTokenId: storedConnections.oauthRefreshTokenId,
      automaticOAuthBindingId: storedConnections.automaticOAuthBindingId,
      kind: storedValues.kind,
      key: storedValues.key,
      storedValue: storedValues.storedValue,
    })
    .from(storedConnections)
    .leftJoin(
      storedValues,
      eq(storedValues.memberConnectorId, storedConnections.id),
    );
  return customConnectorRuntimeStorageSnapshot(
    args.definitions,
    rows,
    args.memberConnectorIdsByCustomConnectorId,
  );
}

export async function loadConnectedCustomConnectorConnections(
  db: Pick<ReadonlyDb, "select">,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorIds?: readonly string[];
  },
): Promise<ReadonlyMap<string, ConnectedCustomConnectorConnection>> {
  if (args.connectorIds?.length === 0) {
    return new Map();
  }
  const rows = await loadCustomConnectorStoredConnections(db, args);
  const now = nowDate();
  const connectedConnections = new Map<
    string,
    ConnectedCustomConnectorConnection
  >();
  for (const row of rows) {
    if (customConnectorStoredConnectionIsConnected(row, now)) {
      connectedConnections.set(row.customConnectorId, {
        id: row.id,
        updatedAt: row.updatedAt,
        authMode: row.definitionAuthMethod,
        storageVersion: row.definitionStorageVersion,
      });
    }
  }
  return connectedConnections;
}

export function customConnectorDefinitionConnectedAccount(args: {
  readonly connectedConnections: ReadonlyMap<
    string,
    ConnectedCustomConnectorConnection
  >;
  readonly definition: CustomConnectorCredentialDefinition;
}): ConnectedCustomConnectorAccount | null {
  const connection = args.connectedConnections.get(args.definition.id);
  const current =
    connection?.authMode === args.definition.authMode &&
    connection.storageVersion === args.definition.storageVersion;
  return current
    ? { id: connection.id, updatedAt: connection.updatedAt }
    : null;
}
