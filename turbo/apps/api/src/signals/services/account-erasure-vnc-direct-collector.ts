import { createHash } from "node:crypto";
import { v5 as uuidv5 } from "uuid";
import { and, asc, eq, exists, gt, inArray, ne, or } from "drizzle-orm";
import { z } from "zod";

import {
  renewErasureLease,
  type EncryptedErasureSelector,
  type ErasureHandler,
  type ErasureInventoryPage,
  type ErasureLease,
  type ErasureProof,
  type ErasureUnresolved,
} from "@okouai/db/operations/account-erasure";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentVncAccess } from "@okouai/db/schema/agent-vnc-access";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { chatThreadVncAccessOverrides } from "@okouai/db/schema/chat-thread-vnc-access-override";
import { vncConnections } from "@okouai/db/schema/vnc-connection";
import { vncCredentials } from "@okouai/db/schema/vnc-credential";

import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import { publishCancelToRunnerGroup } from "../external/realtime";
import { safeJsonParse, settle } from "../utils";
import {
  decryptErasureSelector,
  encryptErasureSelector,
} from "./account-erasure-selector";
import {
  neverStartedRunIds,
  releaseActiveAgentRuns,
  transitionAgentRunsToTerminal,
} from "./agent-run-terminal-transition.service";

const NAMESPACE = "4bdb17ae-090d-4b15-b282-dbe985ba263e";
const PAGE_SIZE = 100;
const cursorSchema = z.tuple([
  z.number().int().min(0).max(3),
  z.uuid(),
  z.string().min(1).max(192),
]);
export const VNC_DIRECT_ERASURE_COLLECTOR_VERSION =
  "8d8538ec-5cc8-4a92-af0d-6f0c90ceacba";

type ResourceType = "credential" | "connection" | "grant" | "run";
type Resource = {
  readonly ordinal: number;
  readonly id: string;
  readonly orgId: string;
  readonly userId: string;
  readonly credentialId: string | null;
  readonly credentialRevision: number | null;
  readonly credentialDigest: string | null;
  readonly connectionId: string | null;
  readonly host: string | null;
  readonly port: number | null;
  readonly agentId: string | null;
  readonly runnerGroup: string | null;
};

function ref(parts: readonly unknown[]) {
  return uuidv5(JSON.stringify(parts), NAMESPACE);
}

function unresolved(
  errorCode: NonNullable<ErasureUnresolved["errorCode"]>,
  outcome: ErasureUnresolved["outcome"] = "capability_unresolved",
): ErasureUnresolved {
  return { outcome, errorCode, requestRef: null };
}

function digest(ciphertext: string) {
  return createHash("sha256").update(ciphertext).digest("hex");
}

async function selected(lease: ErasureLease) {
  if (!lease.item.selectorCiphertext || !lease.item.selectorDigest) {
    return undefined;
  }
  return await decryptErasureSelector({
    ciphertext: lease.item.selectorCiphertext,
    digest: lease.item.selectorDigest,
  });
}

async function readCredentialPage(
  db: Db,
  userId: string,
  after: readonly [number, string, string] | undefined,
  limit: number,
): Promise<Resource[]> {
  const credentials = await db
    .select({
      id: vncCredentials.id,
      orgId: vncCredentials.orgId,
      revision: vncCredentials.revision,
      encryptedPassword: vncCredentials.encryptedPassword,
    })
    .from(vncCredentials)
    .where(
      and(
        eq(vncCredentials.userId, userId),
        after?.[0] === 0 ? gt(vncCredentials.id, after[1]) : undefined,
      ),
    )
    .orderBy(asc(vncCredentials.id))
    .limit(limit);
  return credentials.map((credential) => {
    return {
      ordinal: 0,
      id: credential.id,
      orgId: credential.orgId,
      userId,
      credentialId: credential.id,
      credentialRevision: credential.revision,
      credentialDigest: digest(credential.encryptedPassword),
      connectionId: null,
      host: null,
      port: null,
      agentId: null,
      runnerGroup: null,
    };
  });
}

async function readConnectionPage(
  db: Db,
  userId: string,
  after: readonly [number, string, string] | undefined,
  limit: number,
): Promise<Resource[]> {
  const connections = await db
    .select({
      id: vncConnections.id,
      orgId: vncConnections.orgId,
      credentialId: vncConnections.credentialId,
      host: vncConnections.host,
      port: vncConnections.port,
    })
    .from(vncConnections)
    .where(
      and(
        eq(vncConnections.userId, userId),
        eq(vncConnections.transportType, "direct"),
        after?.[0] === 1 ? gt(vncConnections.id, after[1]) : undefined,
      ),
    )
    .orderBy(asc(vncConnections.id))
    .limit(limit);
  return connections.map((connection) => {
    return {
      ordinal: 1,
      id: connection.id,
      orgId: connection.orgId,
      userId,
      credentialId: connection.credentialId,
      credentialRevision: null,
      credentialDigest: null,
      connectionId: connection.id,
      host: connection.host,
      port: connection.port,
      agentId: null,
      runnerGroup: null,
    };
  });
}

async function readGrantPage(
  db: Db,
  userId: string,
  after: readonly [number, string, string] | undefined,
  limit: number,
): Promise<Resource[]> {
  const grants = await db
    .select({ orgId: agentVncAccess.orgId, agentId: agentVncAccess.agentId })
    .from(agentVncAccess)
    .where(
      and(
        eq(agentVncAccess.userId, userId),
        after?.[0] === 2
          ? or(
              gt(agentVncAccess.agentId, after[1]),
              and(
                eq(agentVncAccess.agentId, after[1]),
                gt(agentVncAccess.orgId, after[2]),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(asc(agentVncAccess.agentId), asc(agentVncAccess.orgId))
    .limit(limit);
  return grants.map((grant) => {
    return {
      ordinal: 2,
      id: grant.agentId,
      orgId: grant.orgId,
      userId,
      credentialId: null,
      credentialRevision: null,
      credentialDigest: null,
      connectionId: null,
      host: null,
      port: null,
      agentId: grant.agentId,
      runnerGroup: null,
    };
  });
}

async function readRunPage(
  db: Db,
  userId: string,
  after: readonly [number, string, string] | undefined,
  limit: number,
): Promise<Resource[]> {
  // There is no server-side VNC session table. A Run in an org with a direct
  // connection is the most precise available in-flight locator, including a
  // Run whose grant was revoked after an earlier password handoff.
  const runs = await db
    .select({
      id: agentRuns.id,
      orgId: agentRuns.orgId,
      runnerGroup: agentRuns.runnerGroup,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.userId, userId),
        inArray(agentRuns.status, ["queued", "pending", "running"]),
        after?.[0] === 3 ? gt(agentRuns.id, after[1]) : undefined,
        exists(
          db
            .select({ id: vncConnections.id })
            .from(vncConnections)
            .where(
              and(
                eq(vncConnections.orgId, agentRuns.orgId),
                eq(vncConnections.userId, agentRuns.userId),
                eq(vncConnections.transportType, "direct"),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(agentRuns.id))
    .limit(limit);
  return runs.map((run) => {
    return {
      ordinal: 3,
      id: run.id,
      orgId: run.orgId,
      userId,
      credentialId: null,
      credentialRevision: null,
      credentialDigest: null,
      connectionId: null,
      host: null,
      port: null,
      agentId: null,
      runnerGroup: run.runnerGroup,
    };
  });
}

async function readPage(
  db: Db,
  userId: string,
  after?: readonly [number, string, string],
): Promise<Resource[]> {
  const rows: Resource[] = [];
  if (!after || after[0] === 0) {
    rows.push(...(await readCredentialPage(db, userId, after, PAGE_SIZE)));
  }
  if (rows.length < PAGE_SIZE && (!after || after[0] <= 1)) {
    rows.push(
      ...(await readConnectionPage(db, userId, after, PAGE_SIZE - rows.length)),
    );
  }
  if (rows.length < PAGE_SIZE && (!after || after[0] <= 2)) {
    rows.push(
      ...(await readGrantPage(db, userId, after, PAGE_SIZE - rows.length)),
    );
  }
  if (rows.length < PAGE_SIZE) {
    rows.push(
      ...(await readRunPage(db, userId, after, PAGE_SIZE - rows.length)),
    );
  }
  return rows;
}

async function foreignConnectionReference(
  db: Db,
  connectionId: string,
  userId: string,
): Promise<boolean> {
  const [other] = await db
    .select({ id: chatThreadVncAccessOverrides.chatThreadId })
    .from(chatThreadVncAccessOverrides)
    .innerJoin(
      chatThreads,
      eq(chatThreads.id, chatThreadVncAccessOverrides.chatThreadId),
    )
    .where(
      and(
        eq(chatThreadVncAccessOverrides.connectionId, connectionId),
        ne(chatThreads.userId, userId),
      ),
    )
    .limit(1);
  return Boolean(other);
}

async function ownershipSafe(
  db: Db,
  rows: readonly Resource[],
): Promise<boolean> {
  for (const row of rows) {
    if (row.credentialId) {
      const [credential] = await db
        .select({ orgId: vncCredentials.orgId, userId: vncCredentials.userId })
        .from(vncCredentials)
        .where(eq(vncCredentials.id, row.credentialId));
      if (credential?.orgId !== row.orgId || credential.userId !== row.userId) {
        return false;
      }
      const [other] = await db
        .select({ id: vncConnections.id })
        .from(vncConnections)
        .where(
          and(
            eq(vncConnections.credentialId, row.credentialId),
            or(
              ne(vncConnections.userId, row.userId),
              ne(vncConnections.orgId, row.orgId),
            ),
          ),
        )
        .limit(1);
      if (other) {
        return false;
      }
    }
    if (
      row.connectionId &&
      (await foreignConnectionReference(db, row.connectionId, row.userId))
    ) {
      return false;
    }
  }
  return true;
}

async function inventory(
  db: Db,
  lease: ErasureLease,
  cursor: EncryptedErasureSelector | null,
): Promise<ErasureInventoryPage | ErasureUnresolved> {
  const subject = await selected(lease);
  if (subject?.kind !== "subject" || subject.subjectKind !== "user") {
    return unresolved("selector_missing");
  }
  await renewErasureLease(db, lease);
  let after: readonly [number, string, string] | undefined;
  if (cursor) {
    const decoded = await decryptErasureSelector(cursor);
    const parsed =
      decoded.kind === "cursor"
        ? cursorSchema.safeParse(safeJsonParse(decoded.after))
        : undefined;
    if (!parsed?.success) {
      return unresolved("selector_missing");
    }
    after = parsed.data;
  }
  const rows = await readPage(db, subject.subjectId, after);
  if (!(await ownershipSafe(db, rows))) {
    return unresolved("ownership_unknown");
  }
  const types: readonly ResourceType[] = [
    "credential",
    "connection",
    "grant",
    "run",
  ];
  const items = await Promise.all(
    rows.map(async (row) => {
      return {
        sinkId: lease.item.sinkId,
        itemKey: ref([
          "vnc-direct",
          row.ordinal,
          row.orgId,
          row.userId,
          row.id,
        ]),
        kind: "erase" as const,
        selector: await encryptErasureSelector({
          version: 1,
          kind: "vnc_direct",
          orgId: row.orgId,
          userId: row.userId,
          resourceType: types[row.ordinal],
          resourceId: row.id,
          credentialId: row.credentialId,
          credentialRevision: row.credentialRevision,
          credentialDigest: row.credentialDigest,
          connectionId: row.connectionId,
          host: row.host,
          port: row.port,
          agentId: row.agentId,
          runnerGroup: row.runnerGroup,
        }),
        dependencies: [],
      };
    }),
  );
  const last = rows.at(-1);
  return {
    pageKey: ref([
      "vnc-direct-page",
      lease.jobId,
      lease.captureRevision,
      after ?? null,
    ]),
    inputCursorDigest: lease.item.cursorDigest,
    nextCursor:
      rows.length < PAGE_SIZE || !last
        ? null
        : await encryptErasureSelector({
            version: 1,
            kind: "cursor",
            after: JSON.stringify([last.ordinal, last.id, last.orgId]),
          }),
    enumerationRef:
      rows.length < PAGE_SIZE
        ? ref([
            "vnc-direct-enumeration",
            subject.subjectId,
            VNC_DIRECT_ERASURE_COLLECTOR_VERSION,
          ])
        : null,
    items,
  };
}

type DirectSelector = Extract<
  NonNullable<Awaited<ReturnType<typeof selected>>>,
  { kind: "vnc_direct" }
>;

function credentialTarget(resource: DirectSelector) {
  return (
    resource.credentialId === resource.resourceId &&
    resource.credentialRevision !== null &&
    resource.credentialDigest !== null &&
    resource.connectionId === null &&
    resource.host === null &&
    resource.port === null &&
    resource.agentId === null &&
    resource.runnerGroup === null
  );
}

function connectionTarget(resource: DirectSelector) {
  return (
    resource.connectionId === resource.resourceId &&
    resource.credentialId !== null &&
    resource.credentialRevision === null &&
    resource.credentialDigest === null &&
    resource.host !== null &&
    resource.port !== null &&
    resource.agentId === null &&
    resource.runnerGroup === null
  );
}

function withoutConnection(resource: DirectSelector) {
  return (
    resource.credentialId === null &&
    resource.credentialRevision === null &&
    resource.credentialDigest === null &&
    resource.connectionId === null &&
    resource.host === null &&
    resource.port === null
  );
}

async function target(lease: ErasureLease) {
  const resource = await selected(lease);
  if (resource?.kind !== "vnc_direct") {
    return undefined;
  }
  switch (resource.resourceType) {
    case "credential": {
      return credentialTarget(resource) ? resource : undefined;
    }
    case "connection": {
      return connectionTarget(resource) ? resource : undefined;
    }
    case "grant": {
      return withoutConnection(resource) &&
        resource.agentId === resource.resourceId &&
        resource.runnerGroup === null
        ? resource
        : undefined;
    }
    case "run": {
      return withoutConnection(resource) && resource.agentId === null
        ? resource
        : undefined;
    }
  }
}

type Target = NonNullable<Awaited<ReturnType<typeof target>>>;

async function currentCredentialOwnership(db: Db, resource: Target) {
  if (!resource.credentialId) {
    return true;
  }
  const [credential] = await db
    .select({
      orgId: vncCredentials.orgId,
      userId: vncCredentials.userId,
      revision: vncCredentials.revision,
      encryptedPassword: vncCredentials.encryptedPassword,
    })
    .from(vncCredentials)
    .where(eq(vncCredentials.id, resource.credentialId));
  return (
    !credential ||
    (credential.orgId === resource.orgId &&
      credential.userId === resource.userId &&
      (resource.credentialRevision === null ||
        (credential.revision === resource.credentialRevision &&
          digest(credential.encryptedPassword) === resource.credentialDigest)))
  );
}

async function currentOwnership(db: Db, resource: Target): Promise<boolean> {
  if (!(await currentCredentialOwnership(db, resource))) {
    return false;
  }
  if (resource.connectionId) {
    const [connection] = await db
      .select({
        orgId: vncConnections.orgId,
        userId: vncConnections.userId,
        transportType: vncConnections.transportType,
        credentialId: vncConnections.credentialId,
        host: vncConnections.host,
        port: vncConnections.port,
      })
      .from(vncConnections)
      .where(eq(vncConnections.id, resource.connectionId));
    if (
      connection &&
      (connection.orgId !== resource.orgId ||
        connection.userId !== resource.userId ||
        connection.transportType !== "direct" ||
        connection.credentialId !== resource.credentialId ||
        connection.host !== resource.host ||
        connection.port !== resource.port)
    ) {
      return false;
    }
  }
  if (
    resource.connectionId &&
    (await foreignConnectionReference(
      db,
      resource.connectionId,
      resource.userId,
    ))
  ) {
    return false;
  }
  if (resource.resourceType === "run") {
    const [run] = await db
      .select({ orgId: agentRuns.orgId, userId: agentRuns.userId })
      .from(agentRuns)
      .where(eq(agentRuns.id, resource.resourceId));
    if (
      run &&
      (run.orgId !== resource.orgId || run.userId !== resource.userId)
    ) {
      return false;
    }
  }
  return true;
}

async function stopRun(db: Db, resource: Target): Promise<string | null> {
  if (resource.resourceType !== "run") {
    return null;
  }
  return await db.transaction(async (tx) => {
    const stopped = await transitionAgentRunsToTerminal(tx, {
      values: {
        status: "cancelled",
        completedAt: nowDate(),
        runnerCancellationMode: "hard",
      },
      conditions: [
        eq(agentRuns.id, resource.resourceId),
        eq(agentRuns.orgId, resource.orgId),
        eq(agentRuns.userId, resource.userId),
        inArray(agentRuns.status, ["queued", "pending", "running"]),
      ],
    });
    // A failed publish retries after the Run is already terminal. Read its
    // last known group again so a post-capture group is not lost on retry.
    const [current] = await tx
      .select({ runnerGroup: agentRuns.runnerGroup })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.id, resource.resourceId),
          eq(agentRuns.orgId, resource.orgId),
          eq(agentRuns.userId, resource.userId),
        ),
      );
    await releaseActiveAgentRuns(tx, neverStartedRunIds(stopped));
    return stopped[0]?.runnerGroup ?? current?.runnerGroup ?? null;
  });
}

async function erase(db: Db, lease: ErasureLease, signal: AbortSignal) {
  const resource = await target(lease);
  if (!resource) {
    return unresolved("selector_missing");
  }
  await renewErasureLease(db, lease);
  if (!(await currentOwnership(db, resource))) {
    return unresolved("ownership_unknown");
  }
  const currentGroup = await stopRun(db, resource);
  // Agent identity and an organization can be shared. Delete only this
  // account's grant; never delete the agent or a peer's grant/credential.
  await db
    .delete(agentVncAccess)
    .where(
      and(
        eq(agentVncAccess.orgId, resource.orgId),
        eq(agentVncAccess.userId, resource.userId),
      ),
    );
  signal.throwIfAborted();
  const groups = [resource.runnerGroup, currentGroup].filter(
    (group, index, values): group is string => {
      return group !== null && values.indexOf(group) === index;
    },
  );
  if (resource.resourceType === "run" && groups.length > 0) {
    for (const group of groups) {
      const published = await settle(
        publishCancelToRunnerGroup(group, resource.resourceId, "hard"),
        signal,
      );
      if (!published.ok) {
        return unresolved("verification_failed", "retryable_failure");
      }
    }
  }
  // A successful publish is not a Runner acknowledgement, nor a VNC server
  // disconnect receipt. No direct VNC provider supports per-user deletion.
  return {
    requestRef: ref(["vnc-direct-stop", lease.jobId, lease.item.itemKey]),
  };
}

async function verify(
  db: Db,
  lease: ErasureLease,
  boundary: string,
  signal: AbortSignal,
): Promise<ErasureProof | ErasureUnresolved> {
  const resource = await target(lease);
  if (!resource) {
    const subject = await selected(lease);
    if (subject?.kind !== "subject" || subject.subjectKind !== "user") {
      return unresolved("selector_missing");
    }
    return {
      workId: lease.workId,
      sinkId: lease.item.sinkId,
      generation: lease.generation,
      captureRevision: lease.captureRevision,
      inventoryRevision: lease.inventoryRevision,
      producerBoundaryRef: boundary,
      outcome: "verified_no_applicable_data",
      evidenceRef: ref(["vnc-direct-absence", lease.jobId, lease.item.itemKey]),
      authenticatedReaderRef: ref([
        "vnc-direct-db-reader",
        VNC_DIRECT_ERASURE_COLLECTOR_VERSION,
      ]),
      enumerationRef: ref(["vnc-direct-item-enumeration", lease.item.itemKey]),
      observedAt: nowDate(),
    };
  }
  signal.throwIfAborted();
  if (!(await currentOwnership(db, resource))) {
    return unresolved("ownership_unknown");
  }
  const [grant] = await db
    .select({ agentId: agentVncAccess.agentId })
    .from(agentVncAccess)
    .where(
      and(
        eq(agentVncAccess.orgId, resource.orgId),
        eq(agentVncAccess.userId, resource.userId),
      ),
    )
    .limit(1);
  if (grant) {
    return unresolved("verification_failed", "retryable_failure");
  }
  if (resource.resourceType === "run") {
    const [run] = await db
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, resource.resourceId));
    if (run && ["queued", "pending", "running"].includes(run.status)) {
      return unresolved("verification_failed", "retryable_failure");
    }
  }
  // DB grant and Run status readback is necessary, not a socket/provider
  // terminal proof. Even a swept connection/password row cannot establish it.
  return unresolved("boundary_unproven");
}

/** Partial direct VNC slice; the required top-level remote sink stays absent. */
export function createVncDirectErasureCollector(db: Db): ErasureHandler {
  return {
    version: VNC_DIRECT_ERASURE_COLLECTOR_VERSION,
    inventory: async (lease, cursor) => {
      return await inventory(db, lease, cursor);
    },
    erase: async (lease, signal) => {
      return await erase(db, lease, signal);
    },
    verify: async (lease, boundary, signal) => {
      return await verify(db, lease, boundary, signal);
    },
  };
}
