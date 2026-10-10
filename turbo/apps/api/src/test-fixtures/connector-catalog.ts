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
    installApiTestConnectorCatalog(),
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
}): Promise<void> {
  // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0350; new non-billing transactions are prohibited.
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
    await tx.insert(connectorCatalog).values(pointer).onConflictDoNothing();
  });
}

export async function installApiTestConnectorCatalog<
  TQueryResult extends PgQueryResultHKT,
>(
  options: {
    readonly database?: PgDatabase<TQueryResult>;
  } = {},
): Promise<void> {
  const catalog = API_TEST_CONNECTOR_CATALOG;
  validateConnectorCatalogArtifact(catalog);
  const rawBytes = Buffer.from(`${JSON.stringify(catalog)}\n`);
  const hash = sha256Digest(rawBytes);
  const publication = {
    catalog,
    hash,
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
