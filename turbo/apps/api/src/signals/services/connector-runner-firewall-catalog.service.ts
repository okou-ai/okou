import { MODEL_PROVIDER_FIREWALL_CONFIGS } from "@okouai/api-contracts/contracts/model-provider-firewalls";
import {
  createRunnerRuntimeFirewallCatalog,
  projectRunnerRuntimeFirewall,
} from "@okouai/connectors/firewall-metadata/runner-runtime-catalog";
import type { Firewall } from "@okouai/connectors/firewall-types";

import {
  connectorCatalog,
  connectorCatalogEntries,
} from "@okouai/db/runtime/connector-catalog";
import { asc, eq } from "drizzle-orm";

import { singleton } from "../../lib/singleton";
import type { ReadonlyDb } from "../external/db";
import { onRejection } from "../utils";
import { ExternalConnectorCatalogUnavailableError } from "./connector-catalog-external-reader.service";
import { connectorCatalogRuntimeColumns } from "./connector-catalog-columns";
import { connectorCatalogCurrentWhere } from "./connector-catalog-slug-source.service";
import { connectorCatalogFirewallConfig } from "@okouai/connectors/connector-catalog/artifacts/relationships";

const MODEL_PROVIDER_FIREWALL_PREFIX = "model-provider:";

interface ConnectorRunnerFirewallCatalog {
  readonly catalogDigest: string;
  readonly catalogVersion: string;
  readonly names: readonly string[];
  has(name: string): boolean;
  load(names: readonly string[] | undefined): Promise<Record<string, Firewall>>;
}

interface CatalogCache {
  catalog: ConnectorRunnerFirewallCatalog | undefined;
  key: string | undefined;
  readonly inFlight: Map<string, Promise<ConnectorRunnerFirewallCatalog>>;
}

type ReadonlyDbLoader = () => ReadonlyDb;

interface CapturedCatalog {
  readonly schemaVersion: number;
  readonly hash: string;
}

function capturedCatalogKey(captured: CapturedCatalog): string {
  return `${captured.schemaVersion}\0${captured.hash}`;
}

const localModelProviderFirewalls = singleton((): readonly Firewall[] => {
  return Object.values(MODEL_PROVIDER_FIREWALL_CONFIGS).map((firewall) => {
    if (!firewall.name.startsWith(MODEL_PROVIDER_FIREWALL_PREFIX)) {
      throw new Error(
        `Local model-provider runner firewall has invalid ownership: ${firewall.name}`,
      );
    }
    return projectRunnerRuntimeFirewall(firewall);
  });
});

function createCatalog(
  connectors: readonly Parameters<typeof connectorCatalogFirewallConfig>[0][],
): ConnectorRunnerFirewallCatalog {
  const connectorFirewalls = connectors.flatMap((connector) => {
    const firewall = connectorCatalogFirewallConfig(connector);
    return firewall === null ? [] : [projectRunnerRuntimeFirewall(firewall)];
  });
  const materialized = createRunnerRuntimeFirewallCatalog([
    ...connectorFirewalls,
    ...localModelProviderFirewalls(),
  ]);
  const nameSet = new Set(materialized.names);
  return {
    catalogDigest: materialized.catalogDigest,
    catalogVersion: materialized.catalogVersion,
    names: materialized.names,
    has: (name) => {
      return nameSet.has(name);
    },
    load: (names) => {
      const selectedNames = names ?? materialized.names;
      return Promise.resolve(
        Object.fromEntries(
          selectedNames.map((name) => {
            const firewall = materialized.firewalls[name];
            if (!firewall) {
              throw new Error(`Missing runner runtime firewall: ${name}`);
            }
            return [name, firewall];
          }),
        ),
      );
    },
  };
}

const catalogCache = singleton((): CatalogCache => {
  return { catalog: undefined, key: undefined, inFlight: new Map() };
});

async function loadCatalog(
  db: ReadonlyDb,
): Promise<ConnectorRunnerFirewallCatalog> {
  const [captured] = await db
    .select({
      schemaVersion: connectorCatalog.schemaVersion,
      hash: connectorCatalog.hash,
    })
    .from(connectorCatalog)
    .where(connectorCatalogCurrentWhere())
    .limit(1);
  if (!captured) {
    throw new ExternalConnectorCatalogUnavailableError(
      "missing_current_identity",
    );
  }
  const key = capturedCatalogKey(captured);
  const cache = catalogCache();
  if (cache.key === key && cache.catalog !== undefined) {
    return cache.catalog;
  }
  // Concurrent misses after a publish share one full firewall read.
  const existing = cache.inFlight.get(key);
  if (existing) {
    return await existing;
  }
  const promise = readCatalog(db, captured.hash);
  cache.inFlight.set(key, promise);
  const catalog = await onRejection(promise, () => {
    deleteInFlightCatalog(cache, key, promise);
  });
  deleteInFlightCatalog(cache, key, promise);
  cache.key = key;
  cache.catalog = catalog;
  return catalog;
}

function deleteInFlightCatalog(
  cache: CatalogCache,
  key: string,
  promise: Promise<ConnectorRunnerFirewallCatalog>,
): void {
  if (cache.inFlight.get(key) === promise) {
    cache.inFlight.delete(key);
  }
}

/**
 * The digest covers every connector firewall, so this reads every entry at
 * the captured hash, but only its slug and firewall rules.
 */
async function readCatalog(
  db: ReadonlyDb,
  hash: string,
): Promise<ConnectorRunnerFirewallCatalog> {
  const connectors = await db
    .select({
      slug: connectorCatalogRuntimeColumns.slug,
      firewall: connectorCatalogRuntimeColumns.firewall,
    })
    .from(connectorCatalogEntries)
    .where(eq(connectorCatalogEntries.hash, hash))
    .orderBy(asc(connectorCatalogEntries.slug));
  if (connectors.length === 0) {
    throw new ExternalConnectorCatalogUnavailableError("missing_entries");
  }
  return createCatalog(connectors);
}

export async function loadConnectorRunnerFirewallCatalog(
  loadDb: ReadonlyDbLoader,
): Promise<ConnectorRunnerFirewallCatalog> {
  return await loadCatalog(loadDb());
}
