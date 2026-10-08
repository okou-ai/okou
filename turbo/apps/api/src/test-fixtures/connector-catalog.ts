import { connectorCatalogEntryColumns } from "@okouai/connectors/connector-catalog/entry-columns";
import { createHash } from "node:crypto";

import { createStore } from "ccstate";
import { getConnectorAuthProviderRegistrationCapabilities } from "@okouai/connectors/auth-providers";
import {
  connectorCatalog,
  connectorCatalogEntries,
} from "@okouai/db/runtime/connector-catalog";

import { mockOptionalEnv } from "../lib/env";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { closeDbPool } from "../lib/db";
import { settleIncludingAbort } from "../signals/utils";
import { writeDb$ } from "../signals/external/db";
import {
  connectorCatalogArtifactSchema,
  type ConnectorCatalogArtifact,
} from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import {
  connectorCatalogFirewallConfig,
  validateConnectorCatalogArtifact,
} from "@okouai/connectors/connector-catalog/artifacts/relationships";
import { connectorCatalogSource } from "../signals/services/connector-catalog-source";
import { API_TEST_CONNECTOR_CATALOG_ARTIFACT } from "./connector-catalog-artifact";

export const API_TEST_CONNECTOR_CATALOG = connectorCatalogArtifactSchema.parse(
  API_TEST_CONNECTOR_CATALOG_ARTIFACT,
);

validateConnectorCatalogArtifact(API_TEST_CONNECTOR_CATALOG);

export const API_TEST_CONNECTOR_FIREWALL_CONFIGS =
  API_TEST_CONNECTOR_CATALOG.connectors.flatMap((connector) => {
    const firewall = connectorCatalogFirewallConfig(connector);
    return firewall === null ? [] : [firewall];
  });

export const API_TEST_CONNECTOR_CATALOG_SOURCE = connectorCatalogSource();

export async function installSharedApiTestConnectorCatalog(): Promise<void> {
  const installation = await settleIncludingAbort(
    installApiTestConnectorCatalog({ ifAbsent: true }),
  );
  // Startup owns this connection, not the case's database authority. Cases
  // may deliberately choose an unavailable endpoint before their first read.
  const shutdown = await settleIncludingAbort(closeDbPool());
  if (!installation.ok) {
    throw installation.error;
  }
  if (!shutdown.ok) {
    throw shutdown.error;
  }
}

const DEFAULT_API_TEST_CONNECTOR_CATALOG_VERSION =
  API_TEST_CONNECTOR_CATALOG.catalogVersion;

const store = createStore();

function sha256Digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function mockApiTestConnectorProviderConfiguration(): void {
  const requiredNames = new Set(
    getConnectorAuthProviderRegistrationCapabilities().flatMap(
      (registration) => {
        return registration.requiredConfigurationNames;
      },
    ),
  );
  for (const name of requiredNames) {
    mockOptionalEnv(name, `api-test-${name.toLowerCase()}`);
  }
}

async function publishFixtureGeneration<
  TQueryResult extends PgQueryResultHKT,
>(args: {
  readonly database: PgDatabase<TQueryResult>;
  readonly catalog: ConnectorCatalogArtifact;
  readonly hash: string;
  readonly ifAbsent: boolean;
}): Promise<void> {
  await args.database.transaction(async (tx) => {
    // The same entries-then-pointer order as the production writer.
    await tx
      .insert(connectorCatalogEntries)
      .values(
        args.catalog.connectors.map((connector) => {
          return {
            hash: args.hash,
            slug: connector.slug,
            ...connectorCatalogEntryColumns(connector),
          };
        }),
      )
      .onConflictDoNothing();
    const pointer = {
      schemaVersion: args.catalog.artifactSchemaVersion,
      hash: args.hash,
    };
    // Shared installation never replaces a pointer that another suite owns;
    // concurrent workers wait on the conflicting insert instead.
    await (args.ifAbsent
      ? tx.insert(connectorCatalog).values(pointer).onConflictDoNothing()
      : tx
          .insert(connectorCatalog)
          .values(pointer)
          .onConflictDoUpdate({
            target: connectorCatalog.schemaVersion,
            set: { hash: args.hash },
          }));
  });
}

export async function installApiTestConnectorCatalog<
  TQueryResult extends PgQueryResultHKT,
>(
  options: {
    readonly catalogVersion?: string;
    readonly catalog?: ConnectorCatalogArtifact;
    readonly ifAbsent?: boolean;
    readonly database?: PgDatabase<TQueryResult>;
  } = {},
): Promise<void> {
  const catalogVersion =
    options.catalogVersion ??
    options.catalog?.catalogVersion ??
    DEFAULT_API_TEST_CONNECTOR_CATALOG_VERSION;
  const catalog =
    options.catalog ??
    (catalogVersion === DEFAULT_API_TEST_CONNECTOR_CATALOG_VERSION
      ? API_TEST_CONNECTOR_CATALOG
      : connectorCatalogArtifactSchema.parse({
          ...API_TEST_CONNECTOR_CATALOG_ARTIFACT,
          catalogVersion,
        }));
  validateConnectorCatalogArtifact(catalog);
  const rawBytes = Buffer.from(`${JSON.stringify(catalog)}\n`);
  const hash = sha256Digest(rawBytes);
  const publication = {
    catalog,
    hash,
    ifAbsent: options.ifAbsent ?? false,
  };
  if (options.database) {
    await publishFixtureGeneration({
      database: options.database,
      ...publication,
    });
  } else {
    await publishFixtureGeneration({
      database: store.set(writeDb$),
      ...publication,
    });
  }
}

const UNAVAILABLE_PLATFORM_SECRET = "API_TEST_UNAVAILABLE_PLATFORM_SECRET";

// Requires an undeclared platform secret, so on-demand compatibility reports a
// provider contract mismatch for exactly these executable methods.
export function apiTestConnectorCatalogWithUnavailableAuthMethods(
  catalog: ConnectorCatalogArtifact,
  methods: readonly {
    readonly connectorSlug: string;
    readonly authMethodId: string;
  }[],
): ConnectorCatalogArtifact {
  const remaining = new Set(
    methods.map((method) => {
      return `${method.connectorSlug}\0${method.authMethodId}`;
    }),
  );
  const unavailable = {
    ...catalog,
    connectors: catalog.connectors.map((connector) => {
      return {
        ...connector,
        authMethods: connector.authMethods.map((method) => {
          if (!remaining.delete(`${connector.slug}\0${method.id}`)) {
            return method;
          }
          if (
            method.access.kind !== "static" &&
            method.access.kind !== "refresh-token"
          ) {
            throw new Error(
              `${connector.slug}/${method.id} has no platform secret contract`,
            );
          }
          return {
            ...method,
            access: {
              ...method.access,
              platformSecrets: [
                ...(method.access.platformSecrets ?? []),
                UNAVAILABLE_PLATFORM_SECRET,
              ],
            },
          };
        }),
      };
    }),
  };
  if (remaining.size > 0) {
    throw new Error(`Unknown auth methods: ${[...remaining].join(", ")}`);
  }
  return connectorCatalogArtifactSchema.parse(unavailable);
}
