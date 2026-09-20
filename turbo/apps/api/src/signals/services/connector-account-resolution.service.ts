import {
  connectorAccountTargetKey,
  type ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { connectors } from "@okouai/db/schema/connector";
import { and, eq, inArray, isNotNull, or, type SQL } from "drizzle-orm";

import { logger } from "../../lib/log";
import type { ReadonlyDb } from "../external/db";

const L = logger("connector-account-resolution");

export type ConnectorAccountSelectionMode =
  | { readonly kind: "exact"; readonly sourceId: string }
  | { readonly kind: "default" };

export interface ConnectorAccountResolutionRequest {
  readonly target: ConnectorAccountTarget;
  readonly selection: ConnectorAccountSelectionMode;
}

interface ResolvedConnectorAccount {
  readonly authMethod: string;
  readonly automaticAuthType: "none" | "oauth" | null;
  readonly connectorId: string;
  readonly storageVersion: number;
  readonly target: ConnectorAccountTarget;
}

type ConnectorAccountResolution =
  | {
      readonly kind: "resolved";
      readonly account: ResolvedConnectorAccount;
    }
  | { readonly kind: "missing" }
  | { readonly kind: "mismatch" }
  | { readonly kind: "missing-default" }
  | { readonly kind: "ambiguous" };

interface ConnectorAccountIdentityRow {
  readonly authMethod: string;
  readonly automaticAuthType: "none" | "oauth" | null;
  readonly connectorId: string;
  readonly connectorSlug: string | null;
  readonly customConnectorId: string | null;
  readonly storageVersion: number;
}

export { connectorAccountTargetKey };

function connectorAccountTargetFromRow(
  row: ConnectorAccountIdentityRow,
): ConnectorAccountTarget {
  if (row.connectorSlug !== null && row.customConnectorId === null) {
    return { kind: "builtin", connectorSlug: row.connectorSlug };
  }
  if (row.customConnectorId !== null && row.connectorSlug === null) {
    return { kind: "custom", customConnectorId: row.customConnectorId };
  }
  throw new Error("Expected exactly one connector account target");
}

function selectionModesMatch(
  left: ConnectorAccountSelectionMode,
  right: ConnectorAccountSelectionMode,
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind !== "exact" ||
      (right.kind === "exact" && left.sourceId === right.sourceId))
  );
}

function normalizeRequests(
  requests: readonly ConnectorAccountResolutionRequest[],
): ReadonlyMap<string, ConnectorAccountResolutionRequest> {
  const normalized = new Map<string, ConnectorAccountResolutionRequest>();
  for (const request of requests) {
    const key = connectorAccountTargetKey(request.target);
    const existing = normalized.get(key);
    if (
      existing &&
      !selectionModesMatch(existing.selection, request.selection)
    ) {
      throw new Error(
        "Conflicting connector account selections for one target",
      );
    }
    normalized.set(key, request);
  }
  return normalized;
}

function targetCondition(
  targets: readonly ConnectorAccountTarget[],
): SQL | undefined {
  const connectorSlugs = targets.flatMap((target) => {
    return target.kind === "builtin" ? [target.connectorSlug] : [];
  });
  const customConnectorIds = targets.flatMap((target) => {
    return target.kind === "custom" ? [target.customConnectorId] : [];
  });
  return or(
    connectorSlugs.length > 0
      ? and(
          isNotNull(connectors.connectorSlug),
          inArray(connectors.connectorSlug, connectorSlugs),
        )
      : undefined,
    customConnectorIds.length > 0
      ? and(
          isNotNull(connectors.customConnectorId),
          inArray(connectors.customConnectorId, customConnectorIds),
        )
      : undefined,
  );
}

function identitySelection() {
  return {
    authMethod: connectors.authMethod,
    automaticAuthType: connectors.automaticAuthType,
    connectorId: connectors.id,
    connectorSlug: connectors.connectorSlug,
    customConnectorId: connectors.customConnectorId,
    storageVersion: connectors.storageVersion,
  };
}

async function loadExactRows(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly requests: readonly ConnectorAccountResolutionRequest[];
  },
): Promise<readonly ConnectorAccountIdentityRow[]> {
  const sourceIds = args.requests.flatMap((request) => {
    return request.selection.kind === "exact"
      ? [request.selection.sourceId]
      : [];
  });
  if (sourceIds.length === 0) {
    return [];
  }
  return await db
    .select(identitySelection())
    .from(connectors)
    .where(
      and(
        eq(connectors.orgId, args.orgId),
        eq(connectors.userId, args.userId),
        inArray(connectors.id, sourceIds),
      ),
    );
}

async function loadDefaultRows(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly requests: readonly ConnectorAccountResolutionRequest[];
  },
): Promise<readonly ConnectorAccountIdentityRow[]> {
  const targets = args.requests.flatMap((request) => {
    return request.selection.kind === "default" ? [request.target] : [];
  });
  if (targets.length === 0) {
    return [];
  }
  return await db
    .select(identitySelection())
    .from(connectors)
    .where(
      and(
        eq(connectors.orgId, args.orgId),
        eq(connectors.userId, args.userId),
        eq(connectors.isDefault, true),
        targetCondition(targets),
      ),
    );
}

function rowsByTarget(
  rows: readonly ConnectorAccountIdentityRow[],
): ReadonlyMap<string, readonly ConnectorAccountIdentityRow[]> {
  const grouped = new Map<string, ConnectorAccountIdentityRow[]>();
  for (const row of rows) {
    const key = connectorAccountTargetKey(connectorAccountTargetFromRow(row));
    const values = grouped.get(key) ?? [];
    values.push(row);
    grouped.set(key, values);
  }
  return grouped;
}

function resolved(
  row: ConnectorAccountIdentityRow,
): ConnectorAccountResolution {
  return {
    kind: "resolved",
    account: {
      authMethod: row.authMethod,
      automaticAuthType: row.automaticAuthType,
      connectorId: row.connectorId,
      storageVersion: row.storageVersion,
      target: connectorAccountTargetFromRow(row),
    },
  };
}

export async function resolveConnectorAccounts(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly requests: readonly ConnectorAccountResolutionRequest[];
  },
): Promise<ReadonlyMap<string, ConnectorAccountResolution>> {
  const requests = normalizeRequests(args.requests);
  if (requests.size === 0) {
    return new Map();
  }
  const normalizedRequests = [...requests.values()];
  const [exactRows, defaultRows] = await Promise.all([
    loadExactRows(db, { ...args, requests: normalizedRequests }),
    loadDefaultRows(db, { ...args, requests: normalizedRequests }),
  ]);
  const exactById = new Map(
    exactRows.map((row) => {
      return [row.connectorId, row] as const;
    }),
  );
  const defaultByTarget = rowsByTarget(defaultRows);
  const resolutions = new Map<string, ConnectorAccountResolution>();
  for (const [key, request] of requests) {
    if (request.selection.kind === "exact") {
      const row = exactById.get(request.selection.sourceId);
      resolutions.set(
        key,
        !row
          ? { kind: "missing" }
          : connectorAccountTargetKey(connectorAccountTargetFromRow(row)) ===
              key
            ? resolved(row)
            : { kind: "mismatch" },
      );
      continue;
    }
    const rows = defaultByTarget.get(key);
    if (!rows || rows.length === 0) {
      resolutions.set(key, { kind: "missing-default" });
    } else if (rows.length > 1) {
      resolutions.set(key, { kind: "ambiguous" });
    } else {
      const [row] = rows;
      if (!row) {
        throw new Error("Expected one resolved connector account");
      }
      resolutions.set(key, resolved(row));
    }
  }
  const outcomeCounts = {
    resolved: 0,
    missing: 0,
    mismatch: 0,
    missingDefault: 0,
    ambiguous: 0,
  };
  for (const resolution of resolutions.values()) {
    switch (resolution.kind) {
      case "resolved": {
        outcomeCounts.resolved += 1;
        break;
      }
      case "missing": {
        outcomeCounts.missing += 1;
        break;
      }
      case "mismatch": {
        outcomeCounts.mismatch += 1;
        break;
      }
      case "missing-default": {
        outcomeCounts.missingDefault += 1;
        break;
      }
      case "ambiguous": {
        outcomeCounts.ambiguous += 1;
        break;
      }
    }
  }
  L.debug("Resolved connector accounts", {
    requestCount: requests.size,
    exactRequestCount: normalizedRequests.filter((request) => {
      return request.selection.kind === "exact";
    }).length,
    defaultRequestCount: normalizedRequests.filter((request) => {
      return request.selection.kind === "default";
    }).length,
    ...outcomeCounts,
  });
  return resolutions;
}

export async function resolveConnectorAccount(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly request: ConnectorAccountResolutionRequest;
  },
): Promise<ConnectorAccountResolution> {
  const key = connectorAccountTargetKey(args.request.target);
  const resolutions = await resolveConnectorAccounts(db, {
    orgId: args.orgId,
    userId: args.userId,
    requests: [args.request],
  });
  const resolution = resolutions.get(key);
  if (!resolution) {
    throw new Error("Expected one connector account resolution");
  }
  return resolution;
}

export function resolvedConnectorAccountIdsByTarget(
  resolutions: ReadonlyMap<string, ConnectorAccountResolution>,
): ReadonlyMap<string, string> {
  const resolved = new Map<string, string>();
  for (const [targetKey, resolution] of resolutions) {
    if (resolution.kind === "resolved") {
      resolved.set(targetKey, resolution.account.connectorId);
    }
  }
  return resolved;
}
