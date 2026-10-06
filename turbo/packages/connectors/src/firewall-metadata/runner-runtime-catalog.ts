import { createHash } from "node:crypto";
import { canonicalJsonValue } from "../connector-catalog/entry-payload";

import type { Firewall, FirewallBaseHostPolicy } from "../firewall-contracts";

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
}

export interface RunnerRuntimeFirewallCatalog {
  readonly catalogDigest: string;
  readonly catalogVersion: string;
  readonly names: readonly string[];
  readonly firewalls: Record<string, Firewall>;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function projectRunnerRuntimeFirewall(
  firewall: RunnerRuntimeFirewallSource,
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

export function createRunnerRuntimeFirewallCatalog(
  firewalls: readonly Firewall[],
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
