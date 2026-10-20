import { open } from "node:fs/promises";

import {
  CONNECTOR_ACCOUNT_INSPECTION_MAX_SELECTIONS,
  connectorAccountTargetKey,
  type ConnectorAccountInspectionResult,
  type ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { connectorSlugSchema } from "@okouai/api-contracts/contracts/connector-identity";
import type { CustomConnectorResponse } from "@okouai/api-contracts/contracts/custom-connectors";
import { z } from "zod";

import {
  inspectConnectorAccounts,
  listConnectorCatalog,
  listCustomConnectors,
  type ConnectorCatalogItem,
} from "../../lib/api/domains/connectors";
import {
  getOkouAgentId,
  getOkouConnectorAccountContextFile,
} from "../../lib/okou-env";
import { connectorAccountCliLabel } from "./account-label";
import { connectorInspectionType } from "./inspection";

export const RUN_CONNECTOR_ACCOUNT_CONTEXT_MAX_BYTES = 1024 * 1024;

const runConnectorAccountTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("builtin"),
      connectorSlug: connectorSlugSchema,
      connectionId: z.uuid().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("custom"),
      customConnectorId: z.uuid(),
      connectionId: z.uuid().nullable(),
    })
    .strict(),
]);

const runConnectorAccountContextSchema = z
  .object({
    schemaVersion: z.literal(1),
    targets: z.array(runConnectorAccountTargetSchema),
  })
  .strict();

type RunConnectorAccountTarget = z.infer<
  typeof runConnectorAccountTargetSchema
>;

type RunConnectorAccountContextUnavailableReason =
  | "legacy-or-missing"
  | "unreadable"
  | "malformed"
  | "unsupported-version"
  | "oversized"
  | "duplicate-target";

type RunConnectorAccountMetadata = Extract<
  ConnectorAccountInspectionResult,
  { kind: "available" }
>;

export type RunConnectorAccountState =
  | {
      readonly state: "available";
      readonly connectionId: string;
      readonly label: string;
      readonly metadata: RunConnectorAccountMetadata;
    }
  | {
      readonly state: "metadata-unavailable";
      readonly connectionId: string;
    }
  | {
      readonly state: "not-admitted";
      readonly connectionId: null;
    };

export type RunConnectorAccountLookup =
  | RunConnectorAccountState
  | {
      readonly state: "context-unavailable";
      readonly reason: RunConnectorAccountContextUnavailableReason;
    };

export interface RunConnectorAccountEntry {
  readonly target: ConnectorAccountTarget;
  readonly connectorType: ReturnType<typeof connectorInspectionType>;
  readonly definitionAvailable: boolean;
  readonly slug: string;
  readonly connectorLabel: string;
  readonly account: RunConnectorAccountState;
}

type RunConnectorAccountView =
  | {
      readonly context: "run";
      readonly state: "unavailable";
      readonly reason: RunConnectorAccountContextUnavailableReason;
      readonly connectors: readonly [];
    }
  | {
      readonly context: "run";
      readonly state: "available";
      readonly connectors: readonly RunConnectorAccountEntry[];
    };

type ProjectionReadResult =
  | {
      readonly state: "available";
      readonly targets: readonly RunConnectorAccountTarget[];
    }
  | {
      readonly state: "unavailable";
      readonly reason: RunConnectorAccountContextUnavailableReason;
    };

type BoundedFileReadResult =
  | { readonly state: "available"; readonly contents: string }
  | {
      readonly state: "unavailable";
      readonly reason: "unreadable" | "oversized";
    };

function projectionTarget(
  target: RunConnectorAccountTarget,
): ConnectorAccountTarget {
  return target.kind === "builtin"
    ? { kind: "builtin", connectorSlug: target.connectorSlug }
    : { kind: "custom", customConnectorId: target.customConnectorId };
}

async function readBoundedFile(path: string): Promise<BoundedFileReadResult> {
  try {
    const handle = await open(path, "r");
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) {
        return { state: "unavailable", reason: "unreadable" };
      }
      if (stats.size > RUN_CONNECTOR_ACCOUNT_CONTEXT_MAX_BYTES) {
        return { state: "unavailable", reason: "oversized" };
      }
      const buffer = Buffer.alloc(RUN_CONNECTOR_ACCOUNT_CONTEXT_MAX_BYTES + 1);
      let totalBytesRead = 0;
      while (totalBytesRead < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          totalBytesRead,
          buffer.length - totalBytesRead,
          totalBytesRead,
        );
        if (bytesRead === 0) break;
        totalBytesRead += bytesRead;
      }
      if (totalBytesRead > RUN_CONNECTOR_ACCOUNT_CONTEXT_MAX_BYTES) {
        return { state: "unavailable", reason: "oversized" };
      }
      return {
        state: "available",
        contents: buffer.toString("utf8", 0, totalBytesRead),
      };
    } finally {
      await handle.close();
    }
  } catch {
    return { state: "unavailable", reason: "unreadable" };
  }
}

async function readProjection(): Promise<ProjectionReadResult> {
  const path = getOkouConnectorAccountContextFile();
  if (!path) {
    return { state: "unavailable", reason: "legacy-or-missing" };
  }
  const file = await readBoundedFile(path);
  if (file.state === "unavailable") {
    return file;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(file.contents);
  } catch {
    return { state: "unavailable", reason: "malformed" };
  }
  const version = z
    .object({ schemaVersion: z.unknown() })
    .passthrough()
    .safeParse(raw);
  if (version.success && version.data.schemaVersion !== 1) {
    return { state: "unavailable", reason: "unsupported-version" };
  }
  const parsed = runConnectorAccountContextSchema.safeParse(raw);
  if (!parsed.success) {
    return { state: "unavailable", reason: "malformed" };
  }
  const targetKeys = new Set<string>();
  for (const target of parsed.data.targets) {
    const key = connectorAccountTargetKey(projectionTarget(target));
    if (targetKeys.has(key)) {
      return { state: "unavailable", reason: "duplicate-target" };
    }
    targetKeys.add(key);
  }
  return { state: "available", targets: parsed.data.targets };
}

function metadataKey(
  target: ConnectorAccountTarget,
  connectionId: string,
): string {
  return `${connectorAccountTargetKey(target)}:${connectionId}`;
}

function accountState(
  projected: RunConnectorAccountTarget | undefined,
  metadata: ReadonlyMap<string, RunConnectorAccountMetadata>,
): RunConnectorAccountState {
  if (!projected?.connectionId) {
    return { state: "not-admitted", connectionId: null };
  }
  const target = projectionTarget(projected);
  const current = metadata.get(metadataKey(target, projected.connectionId));
  return current
    ? {
        state: "available",
        connectionId: projected.connectionId,
        label: connectorAccountCliLabel(current),
        metadata: current,
      }
    : {
        state: "metadata-unavailable",
        connectionId: projected.connectionId,
      };
}

async function enrichTargets(
  targets: readonly RunConnectorAccountTarget[],
): Promise<ReadonlyMap<string, RunConnectorAccountMetadata>> {
  const selections = targets.flatMap((target) => {
    return target.connectionId
      ? [
          {
            target: projectionTarget(target),
            connectionId: target.connectionId,
          },
        ]
      : [];
  });
  const metadata = new Map<string, RunConnectorAccountMetadata>();
  for (
    let offset = 0;
    offset < selections.length;
    offset += CONNECTOR_ACCOUNT_INSPECTION_MAX_SELECTIONS
  ) {
    const chunk = selections.slice(
      offset,
      offset + CONNECTOR_ACCOUNT_INSPECTION_MAX_SELECTIONS,
    );
    const results = await inspectConnectorAccounts(chunk);
    if (!results) break;
    for (const result of results) {
      if (result.kind === "available") {
        metadata.set(metadataKey(result.target, result.connectionId), result);
      }
    }
  }
  return metadata;
}

function connectorIdentity(
  target: ConnectorAccountTarget,
  catalog: readonly ConnectorCatalogItem[],
  customConnectors: readonly CustomConnectorResponse[],
): {
  readonly slug: string;
  readonly label: string;
  readonly connectorType: ReturnType<typeof connectorInspectionType>;
  readonly definitionAvailable: boolean;
} {
  if (target.kind === "builtin") {
    const definition = catalog.find((connector) => {
      return connector.slug === target.connectorSlug;
    });
    return {
      slug: target.connectorSlug,
      label: definition?.label ?? target.connectorSlug,
      connectorType: "builtin",
      definitionAvailable: definition !== undefined,
    };
  }
  const definition = customConnectors.find((connector) => {
    return connector.id === target.customConnectorId;
  });
  return {
    slug: definition?.slug ?? `custom:${target.customConnectorId}`,
    label: definition?.displayName ?? target.customConnectorId,
    connectorType: connectorInspectionType(target, definition ?? null),
    definitionAvailable: definition !== undefined,
  };
}

export function isRunBoundConnectorContext(): boolean {
  return getOkouAgentId() !== undefined;
}

export async function resolveRunConnectorAccountLookups(
  targets: readonly ConnectorAccountTarget[],
): Promise<readonly RunConnectorAccountLookup[]> {
  const projection = await readProjection();
  if (projection.state === "unavailable") {
    return targets.map(() => {
      return {
        state: "context-unavailable" as const,
        reason: projection.reason,
      };
    });
  }
  const projectedByTarget = new Map(
    projection.targets.map((projected) => {
      return [
        connectorAccountTargetKey(projectionTarget(projected)),
        projected,
      ] as const;
    }),
  );
  const projectedTargets = targets.flatMap((target) => {
    const projected = projectedByTarget.get(connectorAccountTargetKey(target));
    return projected ? [projected] : [];
  });
  const metadata = await enrichTargets(projectedTargets);
  return targets.map((target) => {
    const projected = projectedByTarget.get(connectorAccountTargetKey(target));
    return accountState(projected, metadata);
  });
}

export async function resolveRunConnectorAccountView(): Promise<RunConnectorAccountView> {
  const projection = await readProjection();
  if (projection.state === "unavailable") {
    return {
      context: "run",
      state: "unavailable",
      reason: projection.reason,
      connectors: [],
    };
  }
  const [{ connectors: catalog }, customConnectors, metadata] =
    await Promise.all([
      listConnectorCatalog(),
      listCustomConnectors(),
      enrichTargets(projection.targets),
    ]);
  return {
    context: "run",
    state: "available",
    connectors: projection.targets.map((projected) => {
      const target = projectionTarget(projected);
      const identity = connectorIdentity(target, catalog, customConnectors);
      return {
        target,
        connectorType: identity.connectorType,
        definitionAvailable: identity.definitionAvailable,
        slug: identity.slug,
        connectorLabel: identity.label,
        account: accountState(projected, metadata),
      };
    }),
  };
}

export function runConnectorAccountUnavailableMessage(
  reason: RunConnectorAccountContextUnavailableReason,
): string {
  const detail =
    reason === "legacy-or-missing"
      ? "this run was started without connector account context"
      : `the connector account context is ${reason.replaceAll("-", " ")}`;
  return `Account used by this run is unavailable because ${detail}. Reconnect or change the thread selection, then start a new run.`;
}
