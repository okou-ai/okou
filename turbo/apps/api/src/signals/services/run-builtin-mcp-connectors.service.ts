import type { McpConnector } from "@okouai/api-contracts/contracts/mcp-connectors";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import type { ReadonlyDb } from "../external/db";
import { nowDate } from "../../lib/time";
import { loadConnectorRuntimeSnapshot } from "./connector-catalog-runtime.service";
import {
  loadConnectorCredentialConnection,
  loadConnectorCredentialValues,
} from "./connector-credential-runtime.service";
import { connectorCredentialStatusWithMethod } from "./connector-credential-status.service";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";

/** Called only after the run/session ownership boundary has been checked. */
export async function loadRunBuiltinMcpConnectors(args: {
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly userId: string;
  readonly sourceIds: Readonly<Record<string, string>>;
}): Promise<readonly McpConnector[]> {
  if (Object.keys(args.sourceIds).length === 0) {
    return [];
  }
  const featureSwitchContext = await loadUserFeatureSwitchContext(
    args.db,
    args.orgId,
    args.userId,
  );
  if (
    !isFeatureEnabled(
      FeatureSwitchKey.BuiltinConnectorMcp,
      featureSwitchContext,
    )
  ) {
    return [];
  }
  const snapshot = await loadConnectorRuntimeSnapshot(args.db);
  const descriptors: McpConnector[] = [];
  for (const [slug, connectorId] of Object.entries(args.sourceIds)) {
    const connector = snapshot.connectors.get(slug);
    if (connector?.mcp === undefined) {
      continue;
    }
    const resolved = await loadConnectorCredentialConnection({
      connectorId,
      connectorSlug: slug,
      db: args.db,
      orgId: args.orgId,
      userId: args.userId,
      snapshot,
    });
    if (resolved.kind !== "ok") {
      continue;
    }
    const { connection } = resolved;
    const method = connection.runtimeMethod.method;
    const valueRefs = Object.values(
      method.access.kind === "none" ? {} : method.access.envBindings,
    ).flatMap((binding) => {
      return typeof binding === "string" ? [binding] : [];
    });
    const values = await loadConnectorCredentialValues({
      connection,
      db: args.db,
      valueRefs,
      featureSwitchContext,
    });
    const connected =
      valueRefs.every((ref) => {
        return values.has(ref);
      }) &&
      connectorCredentialStatusWithMethod({
        method,
        storedNeedsReconnect: connection.needsReconnect,
        tokenExpiresAt: connection.tokenExpiresAt,
        now: nowDate(),
      }) === "available";
    descriptors.push({
      kind: "builtin",
      slug,
      displayName: connector.catalogConnector.label,
      ...connector.mcp,
      connected,
    });
  }
  return descriptors;
}
