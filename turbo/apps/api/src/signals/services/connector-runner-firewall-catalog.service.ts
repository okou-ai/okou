import { MODEL_PROVIDER_FIREWALL_CONFIGS } from "@okouai/api-contracts/contracts/model-provider-firewalls";
import {
  createRunnerRuntimeFirewallCatalog,
  projectRunnerRuntimeFirewall,
} from "@okouai/connectors/firewall-metadata/runner-runtime-catalog";
import type { Firewall } from "@okouai/connectors/firewall-types";

import { singleton } from "../../lib/singleton";
import type { ReadonlyDb } from "../external/db";
import {
  loadAcceptedConnectorCatalogSnapshot,
  type AcceptedConnectorCatalogSnapshot,
  type ExternalCatalogIdentity,
} from "./connector-catalog-external-reader.service";
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
}

type ReadonlyDbLoader = () => ReadonlyDb;

function externalIdentityKey(identity: ExternalCatalogIdentity): string {
  return [
    identity.sourceId,
    identity.schemaVersion,
    identity.catalogVersion,
    identity.catalogDigest,
    identity.capabilityDigest,
  ].join("\0");
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
  snapshot: AcceptedConnectorCatalogSnapshot,
): ConnectorRunnerFirewallCatalog {
  const connectorFirewalls = snapshot.artifact.connectors.flatMap(
    (connector) => {
      const firewall = connectorCatalogFirewallConfig(connector);
      return firewall === null ? [] : [projectRunnerRuntimeFirewall(firewall)];
    },
  );
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

async function loadCatalog(
  db: ReadonlyDb,
): Promise<ConnectorRunnerFirewallCatalog> {
  const snapshot = await loadAcceptedConnectorCatalogSnapshot(db);
  const key = externalIdentityKey(snapshot.identity);
  const cache = catalogCache();
  if (cache.key === key && cache.catalog !== undefined) {
    return cache.catalog;
  }
  const catalog = createCatalog(snapshot);
  cache.key = key;
  cache.catalog = catalog;
  return catalog;
}

export async function loadConnectorRunnerFirewallCatalog(
  loadDb: ReadonlyDbLoader,
): Promise<ConnectorRunnerFirewallCatalog> {
  return await loadCatalog(loadDb());
}
