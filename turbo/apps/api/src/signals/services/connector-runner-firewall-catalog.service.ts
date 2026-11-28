import { MODEL_PROVIDER_FIREWALL_CONFIGS } from "@okouai/api-contracts/contracts/model-provider-firewalls";
import {
  createRunnerRuntimeFirewallCatalog,
  projectRunnerConnectorFirewall,
  projectRunnerRuntimeFirewall,
} from "@okouai/connectors/firewall-metadata/runner-runtime-catalog";
import type { RunnerBuiltinFirewall } from "@okouai/connectors/firewall-contracts";

import {
  connectorCatalog,
  connectorCatalogEntries,
} from "@okouai/db/runtime/connector-catalog";
import { asc, eq } from "drizzle-orm";
import { computed } from "ccstate";

import { singleton } from "../../lib/singleton";
import { db$ } from "../external/db";
import { ExternalConnectorCatalogUnavailableError } from "./connector-catalog-external-reader.service";
import { connectorCatalogRuntimeColumns } from "./connector-catalog-columns";
import { connectorCatalogCurrentWhere } from "./connector-catalog-slug-source.service";

const MODEL_PROVIDER_FIREWALL_PREFIX = "model-provider:";

interface ConnectorRunnerFirewallCatalog {
  readonly catalogDigest: string;
  readonly catalogVersion: string;
  readonly names: readonly string[];
  has(name: string): boolean;
  load(
    names: readonly string[] | undefined,
  ): Promise<Record<string, RunnerBuiltinFirewall>>;
}

interface CatalogCache {
  catalog: ConnectorRunnerFirewallCatalog | undefined;
  key: string | undefined;
}

interface CapturedCatalog {
  readonly schemaVersion: number;
  readonly hash: string;
}

function capturedCatalogKey(captured: CapturedCatalog): string {
  return `${captured.schemaVersion}\0${captured.hash}`;
}

const localModelProviderFirewalls = singleton(
  (): readonly RunnerBuiltinFirewall[] => {
    return Object.values(MODEL_PROVIDER_FIREWALL_CONFIGS).map((firewall) => {
      if (!firewall.name.startsWith(MODEL_PROVIDER_FIREWALL_PREFIX)) {
        throw new Error(
          `Local model-provider runner firewall has invalid ownership: ${firewall.name}`,
        );
      }
      return projectRunnerRuntimeFirewall(firewall);
    });
  },
);

function createCatalog(
  connectors: readonly Parameters<typeof projectRunnerConnectorFirewall>[0][],
): ConnectorRunnerFirewallCatalog {
  const connectorFirewalls = connectors.flatMap((connector) => {
    const firewall = projectRunnerConnectorFirewall(connector);
    return firewall === null ? [] : [firewall];
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
  return { catalog: undefined, key: undefined };
});

export const connectorRunnerFirewallCatalog$ = computed(async (get) => {
  const db = get(db$);
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
  // The digest covers every connector firewall, so read all entries at the
  // captured hash, including whether each entry is an MCP connector.
  const connectors = await db
    .select({
      slug: connectorCatalogRuntimeColumns.slug,
      firewall: connectorCatalogRuntimeColumns.firewall,
      mcp: connectorCatalogRuntimeColumns.mcp,
    })
    .from(connectorCatalogEntries)
    .where(eq(connectorCatalogEntries.hash, captured.hash))
    .orderBy(asc(connectorCatalogEntries.slug));
  if (connectors.length === 0) {
    throw new ExternalConnectorCatalogUnavailableError("missing_entries");
  }
  const catalog = createCatalog(connectors);
  cache.key = key;
  cache.catalog = catalog;
  return catalog;
});
