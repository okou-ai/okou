import type { AgentCustomConnectorGrant } from "@okouai/api-contracts/contracts/agent-custom-connectors";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type { ConnectorRuntimeTargetRegistration } from "@okouai/api-contracts/contracts/runners";
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { computed, type Computed } from "ccstate";
import type { AgentConnectorScope } from "./agent-connector-scope.service";
import type { ConnectorExecutionRuntimeSelection } from "./connector-catalog-runtime.service";

export type ConnectorScopeSource = "stored_agent" | "empty";

export interface EffectiveConnectorScope {
  readonly allowedConnectorSlugs: readonly ConnectorSlug[];
  readonly allowedCustomConnectorIds: readonly string[];
  readonly customConnectorGrants:
    readonly AgentCustomConnectorGrant[] | undefined;
  readonly source: ConnectorScopeSource;
}

/** The Agent's stored connector scope as a Run connector scope. */
export function runConnectorScope(
  scope: AgentConnectorScope,
): EffectiveConnectorScope {
  return {
    allowedConnectorSlugs: scope.allowedConnectorSlugs,
    allowedCustomConnectorIds: scope.allowedCustomConnectorIds,
    customConnectorGrants: scope.customConnectorGrants,
    source: isEmptyRunConnectorScope(scope) ? "empty" : "stored_agent",
  };
}

export function isEmptyRunConnectorScope(scope: {
  readonly allowedConnectorSlugs: readonly ConnectorSlug[];
  readonly allowedCustomConnectorIds: readonly string[];
}): boolean {
  return (
    scope.allowedConnectorSlugs.length === 0 &&
    scope.allowedCustomConnectorIds.length === 0
  );
}

/** Share current execution authority before account acquisition and preparation. */
export function createExecutionConnectorScope(args: {
  readonly scope$: Computed<Promise<AgentConnectorScope>>;
  readonly targets$: Computed<
    Promise<readonly ConnectorRuntimeTargetRegistration[]>
  >;
  readonly catalog$: Computed<
    Promise<ConnectorExecutionRuntimeSelection | null>
  >;
  readonly features$: Computed<Promise<FeatureSwitchContext>>;
}) {
  return computed(async (get): Promise<EffectiveConnectorScope> => {
    const [scope, targets, catalog] = await Promise.all([
      get(args.scope$),
      get(args.targets$),
      get(args.catalog$),
    ]);
    const allowed = runConnectorScope(scope);
    if (allowed.allowedConnectorSlugs.length > 0 && !catalog) {
      throw new Error("Scoped connector catalog is missing from Claim");
    }
    return {
      ...allowed,
      customConnectorGrants: isFeatureEnabled(
        FeatureSwitchKey.ConnectorChatAccountAccess,
        await get(args.features$),
      )
        ? []
        : allowed.customConnectorGrants,
      allowedConnectorSlugs: allowed.allowedConnectorSlugs.filter((slug) => {
        // Native-only environment bindings have no firewall registration.
        return (
          (catalog !== null &&
            !catalog.serverFirewalls.has(slug) &&
            !catalog.serverFirewalls.isMcp(slug)) ||
          targets.some((target) => {
            return target.kind === "builtin" && target.connectorSlug === slug;
          })
        );
      }),
      allowedCustomConnectorIds: allowed.allowedCustomConnectorIds.filter(
        (id) => {
          return targets.some((target) => {
            return target.kind === "custom" && target.customConnectorId === id;
          });
        },
      ),
    };
  });
}
