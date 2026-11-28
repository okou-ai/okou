import { createHash } from "node:crypto";
import type { ConnectorCatalogArtifactConnector } from "../connector-catalog/artifacts/artifacts";
import { connectorCatalogFirewallConfig } from "../connector-catalog/artifacts/relationships";
import { canonicalJsonValue } from "../connector-catalog/entry-payload";
import { extractSecretNamesFromApis } from "../firewall-types";
import { connectorCredentialPlaceholder } from "./credential-placeholder";

import type {
  Firewall,
  FirewallBaseHostPolicy,
  RunnerBuiltinFirewall,
} from "../firewall-contracts";

interface RunnerRuntimePermissionSource {
  readonly name: string;
  readonly rules: readonly string[];
}

interface RunnerRuntimeApiSource {
  readonly base: string;
  readonly hostPolicy?: FirewallBaseHostPolicy;
  readonly auth: Firewall["apis"][number]["auth"];
  readonly permissions?: readonly RunnerRuntimePermissionSource[];
}

export interface RunnerRuntimeFirewallSource {
  readonly name: string;
  readonly apis: readonly RunnerRuntimeApiSource[];
  readonly placeholders?: Readonly<Record<string, string>>;
}

export interface RunnerRuntimeFirewallCatalog {
  readonly catalogDigest: string;
  readonly catalogVersion: string;
  readonly names: readonly string[];
  readonly firewalls: Record<string, RunnerBuiltinFirewall>;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function projectRuntimeFirewall(
  firewall: Pick<RunnerRuntimeFirewallSource, "name" | "apis">,
): Firewall {
  return {
    name: firewall.name,
    apis: firewall.apis.map((api) => {
      return {
        base: api.base,
        ...(api.hostPolicy === undefined ? {} : { hostPolicy: api.hostPolicy }),
        auth: api.auth,
        permissions: (api.permissions ?? []).map((permission) => {
          return {
            name: permission.name,
            rules: [...permission.rules],
          };
        }),
      };
    }),
  };
}

export function projectRunnerRuntimeFirewall(
  firewall: RunnerRuntimeFirewallSource,
): RunnerBuiltinFirewall {
  const projected = projectRuntimeFirewall(firewall);
  return firewall.placeholders === undefined
    ? projected
    : { ...projected, placeholders: { ...firewall.placeholders } };
}

export function projectRunnerConnectorFirewall(
  connector: Pick<ConnectorCatalogArtifactConnector, "slug" | "firewall"> & {
    readonly mcp?: ConnectorCatalogArtifactConnector["mcp"] | null;
  },
): RunnerBuiltinFirewall | null {
  const firewall = connectorCatalogFirewallConfig(connector);
  if (firewall === null) {
    return null;
  }
  const projected = projectRunnerRuntimeFirewall(firewall);
  if (connector.mcp === null || connector.mcp === undefined) {
    return projected;
  }

  const placeholders = { ...projected.placeholders };
  for (const name of extractSecretNamesFromApis(firewall.apis)) {
    placeholders[name] ??= connectorCredentialPlaceholder(connector.slug, name);
  }
  return Object.keys(placeholders).length === 0
    ? projected
    : { ...projected, placeholders };
}

export function createRunnerRuntimeFirewallCatalog(
  firewalls: readonly RunnerBuiltinFirewall[],
): RunnerRuntimeFirewallCatalog {
  const names = new Set<string>();
  for (const firewall of firewalls) {
    if (names.has(firewall.name)) {
      throw new Error(
        `Duplicate runner runtime firewall name: ${firewall.name}`,
      );
    }
    names.add(firewall.name);
  }
  const sortedNames = [...names].sort(compareStrings);
  const firewallByName = new Map(
    firewalls.map((firewall) => {
      return [firewall.name, firewall] as const;
    }),
  );
  const catalog = Object.fromEntries(
    sortedNames.map((name) => {
      const firewall = firewallByName.get(name);
      if (!firewall) {
        throw new Error(`Missing runner runtime firewall: ${name}`);
      }
      return [name, firewall];
    }),
  );
  const hex = createHash("sha256")
    .update(JSON.stringify(canonicalJsonValue(catalog), null, 2))
    .digest("hex");
  return {
    catalogDigest: `sha256:${hex}`,
    catalogVersion: `sha256-${hex.slice(0, 12)}`,
    names: sortedNames,
    firewalls: catalog,
  };
}
