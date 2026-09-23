import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { connectorRuntimeTargetKey } from "@okouai/api-contracts/contracts/runners";
import { matchFirewallRequestDecision } from "@okouai/connectors/firewall-rule-matcher";
import type { NetworkPolicies } from "@okouai/connectors/firewall-types";

import type { ReadonlyDb } from "../external/db";
import {
  buildConnectorDiagnosticBaseCandidates,
  loadConnectorDiagnosticCatalogView,
} from "./connector-diagnostic-runtime.service";
import type { ConnectorRuntimeSnapshot } from "./connector-catalog-runtime.service";
import { resolveActiveNetworkPolicyRefreshes } from "./user-permission-grants.service";

function decisionPermissions(
  routes: readonly { readonly permissionName: string; readonly rule: string }[],
) {
  const rulesByPermission = new Map<string, string[]>();
  for (const route of routes) {
    const rules = rulesByPermission.get(route.permissionName);
    if (rules) {
      rules.push(route.rule);
      continue;
    }
    rulesByPermission.set(route.permissionName, [route.rule]);
  }
  return [...rulesByPermission].map(([name, rules]) => {
    return { name, rules };
  });
}

/**
 * Resolve the live URL-level permission for one Agent connector request.
 *
 * Catalog routing and the Agent's current grants are evaluated together. Only
 * an unambiguous `allow` passes; missing metadata, no route match, `deny`,
 * `ask`, ambiguity and expired grants all fail closed.
 */
export async function connectorUrlPermission(args: {
  readonly db: ReadonlyDb;
  readonly snapshot: ConnectorRuntimeSnapshot;
  readonly scope: {
    readonly orgId: string;
    readonly userId: string;
    readonly agentId: string;
  };
  readonly connectorSlug: ConnectorSlug;
  readonly method: "GET";
  readonly url: string;
}): Promise<{ readonly allowed: boolean; readonly permission: string | null }> {
  const view = await loadConnectorDiagnosticCatalogView(
    args.snapshot.serverFirewalls,
    args.connectorSlug,
  );
  if (!view) {
    return { allowed: false, permission: null };
  }
  const { candidates } = buildConnectorDiagnosticBaseCandidates(view, null, {
    allowStructuralDynamic: false,
  });
  const refreshes = await resolveActiveNetworkPolicyRefreshes(
    args.db,
    args.scope,
    [args.connectorSlug],
    args.snapshot,
  );
  const firewallName = connectorRuntimeTargetKey({
    kind: "builtin",
    connectorSlug: args.connectorSlug,
  });
  const policies: NetworkPolicies = Object.fromEntries(
    refreshes.map((refresh) => {
      return [
        connectorRuntimeTargetKey({
          kind: "builtin",
          connectorSlug: refresh.connectorSlug as ConnectorSlug,
        }),
        refresh.networkPolicy,
      ];
    }),
  );
  const decision = matchFirewallRequestDecision(
    [
      {
        name: firewallName,
        apis: candidates.map((candidate) => {
          return {
            base: candidate.decisionBase,
            auth: {},
            permissions: decisionPermissions(candidate.routes),
          };
        }),
      },
    ],
    args.method,
    args.url,
    policies,
    { status: "present", value: firewallName },
  );
  return decision.kind === "allow"
    ? { allowed: true, permission: decision.permission ?? null }
    : { allowed: false, permission: null };
}
