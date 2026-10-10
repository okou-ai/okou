import type {
  ConnectorRuntimeTargetRegistration,
  SecretConnectorMetadata,
} from "@okouai/api-contracts/contracts/runners";
import type {
  ExecutionFirewalls,
  NetworkPolicies,
} from "@okouai/connectors/firewall-types";
import type { PermissionManifest } from "./agent-run-contracts";
import {
  compactRecord,
  mergeRecords,
} from "./connector-runtime-preparation.service";

/**
 * One source's contribution to a Run's sandbox environment and firewall. Each
 * source expands its own environment templates; `mergeEnvironments` only
 * applies precedence. Fields map to the stored execution context.
 */
export interface Environment {
  /** Connector variables persisted as `executionContext.vars`. */
  readonly vars: Record<string, string> | undefined;
  /** Expanded, untrusted sandbox environment entries. */
  readonly environment: Record<string, string> | undefined;
  /** Trusted platform entries layered over the sandbox environment. */
  readonly platformEnvironment: Record<string, string> | undefined;
  /** Runtime `secrets.NAME` namespace, keyed by env alias. */
  readonly secrets: Record<string, string> | undefined;
  /** Owner of each refreshable secret alias, used by firewall auth refresh. */
  readonly secretConnectorMap: Record<string, string> | undefined;
  /** Storage source of each refreshable secret alias. */
  readonly secretConnectorMetadataMap:
    Record<string, SecretConnectorMetadata> | undefined;
  readonly firewalls: ExecutionFirewalls;
  readonly networkPolicies: NetworkPolicies;
  /** Placeholder values that keep firewall-injected secrets out of the env. */
  readonly environmentSecretPlaceholders:
    Readonly<Record<string, string>> | undefined;
  readonly billableFirewalls: readonly string[];
  /** Connector and account behind each connector firewall. */
  readonly runtimeTargets: readonly ConnectorRuntimeTargetRegistration[];
  /** Aliases owned by custom connectors; no other source may claim them. */
  readonly reservedSecretAliases: readonly string[];
}

export function emptyEnvironment(): Environment {
  return {
    vars: undefined,
    environment: undefined,
    platformEnvironment: undefined,
    secrets: undefined,
    secretConnectorMap: undefined,
    secretConnectorMetadataMap: undefined,
    firewalls: [],
    networkPolicies: {},
    environmentSecretPlaceholders: undefined,
    billableFirewalls: [],
    runtimeTargets: [],
    reservedSecretAliases: [],
  };
}

/** The firewall part of an Environment, in the permission manifest shape. */
export function environmentPermissionManifest(
  environment: Environment,
): PermissionManifest | undefined {
  return environment.firewalls.length === 0
    ? undefined
    : {
        firewalls: environment.firewalls,
        networkPolicies: environment.networkPolicies,
        environmentSecretPlaceholders:
          environment.environmentSecretPlaceholders,
        billableFirewalls: environment.billableFirewalls,
      };
}

/**
 * Merge sources in ascending precedence: a later source's secrets override
 * earlier ones and drop the earlier owner of that alias. Firewalls keep the
 * model provider ahead of connectors, matching the Runner's matching order.
 */
export function mergeEnvironments(
  sources: readonly Environment[],
  firewallOrder: readonly Environment[] = sources,
): Environment {
  const reserved = new Set(
    sources.flatMap((source) => {
      return source.reservedSecretAliases;
    }),
  );
  const secretConnectorMap: Record<string, string> = {};
  const secretConnectorMetadataMap: Record<string, SecretConnectorMetadata> =
    {};
  for (const [index, source] of sources.entries()) {
    const overridden = new Set(
      sources.slice(index + 1).flatMap((later) => {
        return [
          ...Object.keys(later.secrets ?? {}),
          ...Object.keys(later.secretConnectorMap ?? {}),
        ];
      }),
    );
    for (const [key, owner] of Object.entries(
      source.secretConnectorMap ?? {},
    )) {
      if (overridden.has(key) || reserved.has(key)) {
        continue;
      }
      secretConnectorMap[key] = owner;
      const metadata = source.secretConnectorMetadataMap?.[key];
      if (metadata) {
        secretConnectorMetadataMap[key] = metadata;
      }
    }
  }
  return {
    vars: mergeRecords(
      ...sources.map((source) => {
        return source.vars;
      }),
    ),
    // Higher-precedence entries come first; lower sources fill the rest.
    environment: mergeRecords(
      ...[...sources].reverse().map((source, index, reversed) => {
        const claimed = new Set(
          reversed.slice(0, index).flatMap((higher) => {
            return Object.keys(higher.environment ?? {});
          }),
        );
        return source.environment
          ? Object.fromEntries(
              Object.entries(source.environment).filter(([key]) => {
                return !claimed.has(key);
              }),
            )
          : undefined;
      }),
    ),
    platformEnvironment: mergeRecords(
      ...sources.map((source) => {
        return source.platformEnvironment;
      }),
    ),
    secrets: mergeRecords(
      ...sources.map((source) => {
        return source.secrets;
      }),
    ),
    secretConnectorMap: compactRecord(secretConnectorMap),
    secretConnectorMetadataMap: compactRecord(secretConnectorMetadataMap),
    firewalls: firewallOrder.flatMap((source) => {
      return source.firewalls;
    }),
    networkPolicies: Object.assign(
      {},
      ...firewallOrder.map((source) => {
        return source.networkPolicies;
      }),
    ) as NetworkPolicies,
    environmentSecretPlaceholders: mergeRecords(
      ...firewallOrder.map((source) => {
        return source.environmentSecretPlaceholders;
      }),
    ),
    billableFirewalls: firewallOrder.flatMap((source) => {
      return source.billableFirewalls;
    }),
    runtimeTargets: sources.flatMap((source) => {
      return source.runtimeTargets;
    }),
    reservedSecretAliases: [...reserved],
  };
}
