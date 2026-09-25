import { createHash } from "node:crypto";
import { v5 as uuidv5 } from "uuid";
import { and, asc, eq, gt, inArray, ne } from "drizzle-orm";
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
import { agentSshAccess } from "@okouai/db/schema/agent-ssh-access";
import { cloudflareAccessConfigs } from "@okouai/db/schema/cloudflare-access-config";
import { sshConnections } from "@okouai/db/schema/ssh-connection";
import { sshCredentials } from "@okouai/db/schema/ssh-credential";
import { vncConnections } from "@okouai/db/schema/vnc-connection";

import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import {
  publishCancelToRunnerGroup,
  publishSshInvalidationToRunnerGroup,
} from "../external/realtime";
import { safeJsonParse, settle } from "../utils";
import {
  decryptErasureSelector,
  encryptErasureSelector,
} from "./account-erasure-selector";
import { publishSshRuntimeInvalidation } from "./ssh-runtime-wakeup.service";
import {
  neverStartedRunIds,
  releaseActiveAgentRuns,
  transitionAgentRunsToTerminal,
} from "./agent-run-terminal-transition.service";

const NAMESPACE = "a66735b0-9b30-468f-804a-6b0c4f6f580d";
const PAGE_SIZE = 100;
const cursorSchema = z.tuple([z.number().int().min(0).max(3), z.uuid()]);
export const SSH_REMOTE_ERASURE_COLLECTOR_VERSION =
  "86281eb2-6c60-4f66-a7fb-fd6b536e2d10";

function ref(parts: readonly unknown[]) {
  return uuidv5(JSON.stringify(parts), NAMESPACE);
}

function unresolved(
  errorCode: NonNullable<ErasureUnresolved["errorCode"]>,
  outcome: ErasureUnresolved["outcome"] = "capability_unresolved",
): ErasureUnresolved {
  return { outcome, errorCode, requestRef: null };
}

function credentialDigest(row: {
  encryptedPrivateKey: string | null;
  encryptedPassphrase: string | null;
  encryptedPassword: string | null;
}) {
  // The ciphertext is not copied into B1; only its integrity locator is.
  return createHash("sha256")
    .update(
      JSON.stringify([
        row.encryptedPrivateKey,
        row.encryptedPassphrase,
        row.encryptedPassword,
      ]),
    )
    .digest("hex");
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

type Resource = {
  readonly ordinal: number;
  readonly id: string;
  readonly userId: string;
  readonly orgId: string;
  readonly credentialId: string | null;
  readonly credentialRevision: number | null;
  readonly credentialDigest: string | null;
  readonly connectionId: string | null;
  readonly host: string | null;
  readonly port: number | null;
  readonly cloudflareAccessId: string | null;
  readonly runnerGroup: string | null;
};

async function inFlightRunPage(
  db: Db,
  userId: string,
  after: readonly [number, string] | undefined,
  limit: number,
): Promise<Resource[]> {
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
      ),
    )
    .orderBy(asc(agentRuns.id))
    .limit(limit);
  return runs.map((run) => {
    return {
      ordinal: 3,
      id: run.id,
      userId,
      orgId: run.orgId,
      credentialId: null,
      credentialRevision: null,
      credentialDigest: null,
      connectionId: null,
      host: null,
      port: null,
      cloudflareAccessId: null,
      runnerGroup: run.runnerGroup,
    };
  });
}

async function readPage(
  db: Db,
  userId: string,
  after?: readonly [number, string],
): Promise<Resource[]> {
  const rows: Resource[] = [];
  if (!after || after[0] === 0) {
    const credentials = await db
      .select()
      .from(sshCredentials)
      .where(
        and(
          eq(sshCredentials.userId, userId),
          after ? gt(sshCredentials.id, after[1]) : undefined,
        ),
      )
      .orderBy(asc(sshCredentials.id))
      .limit(PAGE_SIZE);
    rows.push(
      ...credentials.map((credential) => {
        return {
          ordinal: 0,
          id: credential.id,
          userId,
          orgId: credential.orgId,
          credentialId: credential.id,
          credentialRevision: credential.revision,
          credentialDigest: credentialDigest(credential),
          connectionId: null,
          host: null,
          port: null,
          cloudflareAccessId: null,
          runnerGroup: null,
        };
      }),
    );
  }
  if (rows.length < PAGE_SIZE && (!after || after[0] <= 1)) {
    const connections = await db
      .select()
      .from(sshConnections)
      .where(
        and(
          eq(sshConnections.userId, userId),
          after?.[0] === 1 ? gt(sshConnections.id, after[1]) : undefined,
        ),
      )
      .orderBy(asc(sshConnections.id))
      .limit(PAGE_SIZE - rows.length);
    rows.push(
      ...connections.map((connection) => {
        return {
          ordinal: 1,
          id: connection.id,
          userId,
          orgId: connection.orgId,
          credentialId: connection.credentialId,
          credentialRevision: null,
          credentialDigest: null,
          connectionId: connection.id,
          host: connection.host,
          port: connection.port,
          cloudflareAccessId: connection.cloudflareAccessId,
          runnerGroup: null,
        };
      }),
    );
  }
  if (rows.length < PAGE_SIZE && (!after || after[0] <= 2)) {
    const linked = await db
      .select({
        id: vncConnections.id,
        userId: vncConnections.userId,
        orgId: vncConnections.orgId,
        connectionId: vncConnections.sshConnectionId,
      })
      .from(vncConnections)
      .where(
        and(
          eq(vncConnections.userId, userId),
          eq(vncConnections.transportType, "ssh"),
          after?.[0] === 2 ? gt(vncConnections.id, after[1]) : undefined,
        ),
      )
      .orderBy(asc(vncConnections.id))
      .limit(PAGE_SIZE - rows.length);
    rows.push(
      ...linked.map((link) => {
        return {
          ordinal: 2,
          id: link.id,
          userId,
          orgId: link.orgId,
          credentialId: null,
          credentialRevision: null,
          credentialDigest: null,
          connectionId: link.connectionId,
          host: null,
          port: null,
          cloudflareAccessId: null,
          runnerGroup: null,
        };
      }),
    );
  }
  if (rows.length < PAGE_SIZE) {
    rows.push(
      ...(await inFlightRunPage(db, userId, after, PAGE_SIZE - rows.length)),
    );
  }
  return rows;
}

async function ownershipSafe(
  db: Db,
  rows: readonly Resource[],
): Promise<boolean> {
  // No shared organization Cloudflare configuration is revoked by this sink.
  // Composite FKs protect the ordinary case; these checks also fail closed on
  // orphaned or unexpected cross-owner references before capturing a page.
  for (const row of rows) {
    if (row.ordinal === 2 && row.connectionId === null) {
      return false;
    }
    if (row.credentialId) {
      const [credential] = await db
        .select({ userId: sshCredentials.userId, orgId: sshCredentials.orgId })
        .from(sshCredentials)
        .where(eq(sshCredentials.id, row.credentialId));
      if (credential?.userId !== row.userId || credential.orgId !== row.orgId) {
        return false;
      }
      const [foreign] = await db
        .select({ id: sshConnections.id })
        .from(sshConnections)
        .where(
          and(
            eq(sshConnections.credentialId, row.credentialId),
            ne(sshConnections.userId, row.userId),
          ),
        )
        .limit(1);
      if (foreign) {
        return false;
      }
    }
    if (row.cloudflareAccessId) {
      const [access] = await db
        .select({
          orgId: cloudflareAccessConfigs.orgId,
          userId: cloudflareAccessConfigs.userId,
          scope: cloudflareAccessConfigs.scope,
        })
        .from(cloudflareAccessConfigs)
        .where(eq(cloudflareAccessConfigs.id, row.cloudflareAccessId));
      if (
        access?.orgId !== row.orgId ||
        (access.scope === "personal" && access.userId !== row.userId)
      ) {
        return false;
      }
    }
    if (row.connectionId) {
      const [connection] = await db
        .select({ userId: sshConnections.userId, orgId: sshConnections.orgId })
        .from(sshConnections)
        .where(eq(sshConnections.id, row.connectionId));
      if (connection?.userId !== row.userId || connection.orgId !== row.orgId) {
        return false;
      }
      const [foreign] = await db
        .select({ id: vncConnections.id })
        .from(vncConnections)
        .where(
          and(
            eq(vncConnections.sshConnectionId, row.connectionId),
            ne(vncConnections.userId, row.userId),
          ),
        )
        .limit(1);
      if (foreign) {
        return false;
      }
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
  let after: readonly [number, string] | undefined;
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
  const items = await Promise.all(
    rows.map(async (row) => {
      return {
        sinkId: lease.item.sinkId,
        itemKey: ref(["ssh-remote", row.ordinal, row.id]),
        kind: "erase" as const,
        selector: await encryptErasureSelector({
          version: 1,
          kind: "ssh_remote",
          userId: row.userId,
          orgId: row.orgId,
          resourceType: (
            ["credential", "connection", "vnc_link", "run"] as const
          )[row.ordinal],
          resourceId: row.id,
          credentialId: row.credentialId,
          credentialRevision: row.credentialRevision,
          credentialDigest: row.credentialDigest,
          connectionId: row.connectionId,
          host: row.host,
          port: row.port,
          cloudflareAccessId: row.cloudflareAccessId,
          runnerGroup: row.runnerGroup,
        }),
        dependencies: [],
      };
    }),
  );
  const last = rows.at(-1);
  return {
    pageKey: ref([
      "ssh-remote-page",
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
            after: JSON.stringify([last.ordinal, last.id]),
          }),
    enumerationRef:
      rows.length < PAGE_SIZE
        ? ref([
            "ssh-remote-enumeration",
            subject.subjectId,
            SSH_REMOTE_ERASURE_COLLECTOR_VERSION,
          ])
        : null,
    items,
  };
}

async function target(lease: ErasureLease) {
  const resource = await selected(lease);
  if (resource?.kind !== "ssh_remote") {
    return undefined;
  }
  const valid =
    (resource.resourceType === "credential" &&
      resource.credentialId === resource.resourceId &&
      resource.credentialRevision !== null &&
      resource.credentialDigest !== null &&
      resource.connectionId === null) ||
    (resource.resourceType === "connection" &&
      resource.connectionId === resource.resourceId &&
      resource.credentialId !== null &&
      resource.host !== null &&
      resource.port !== null) ||
    (resource.resourceType === "vnc_link" &&
      resource.connectionId !== null &&
      resource.credentialId === null) ||
    (resource.resourceType === "run" &&
      resource.connectionId === null &&
      resource.credentialId === null);
  return valid ? resource : undefined;
}

async function currentInFlightOwnership(
  db: Db,
  resource: NonNullable<Awaited<ReturnType<typeof target>>>,
): Promise<boolean> {
  if (resource.resourceType === "vnc_link") {
    const [link] = await db
      .select({
        userId: vncConnections.userId,
        orgId: vncConnections.orgId,
        connectionId: vncConnections.sshConnectionId,
      })
      .from(vncConnections)
      .where(eq(vncConnections.id, resource.resourceId));
    if (
      link &&
      (link.userId !== resource.userId ||
        link.orgId !== resource.orgId ||
        link.connectionId !== resource.connectionId)
    ) {
      return false;
    }
  }
  if (resource.resourceType === "run") {
    const [run] = await db
      .select({
        userId: agentRuns.userId,
        orgId: agentRuns.orgId,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, resource.resourceId));
    if (
      run &&
      (run.userId !== resource.userId || run.orgId !== resource.orgId)
    ) {
      return false;
    }
  }
  return true;
}

async function currentOwnership(
  db: Db,
  resource: NonNullable<Awaited<ReturnType<typeof target>>>,
): Promise<boolean> {
  if (resource.credentialId) {
    const [credential] = await db
      .select({
        userId: sshCredentials.userId,
        orgId: sshCredentials.orgId,
        revision: sshCredentials.revision,
        encryptedPrivateKey: sshCredentials.encryptedPrivateKey,
        encryptedPassphrase: sshCredentials.encryptedPassphrase,
        encryptedPassword: sshCredentials.encryptedPassword,
      })
      .from(sshCredentials)
      .where(eq(sshCredentials.id, resource.credentialId));
    if (
      credential &&
      (credential.userId !== resource.userId ||
        credential.orgId !== resource.orgId ||
        (resource.credentialRevision !== null &&
          (credential.revision !== resource.credentialRevision ||
            credentialDigest(credential) !== resource.credentialDigest)))
    ) {
      return false;
    }
  }
  if (!(await currentInFlightOwnership(db, resource))) {
    return false;
  }
  if (resource.connectionId) {
    const [connection] = await db
      .select({
        userId: sshConnections.userId,
        orgId: sshConnections.orgId,
        credentialId: sshConnections.credentialId,
        host: sshConnections.host,
        port: sshConnections.port,
        cloudflareAccessId: sshConnections.cloudflareAccessId,
      })
      .from(sshConnections)
      .where(eq(sshConnections.id, resource.connectionId));
    if (
      connection &&
      (connection.userId !== resource.userId ||
        connection.orgId !== resource.orgId ||
        (resource.credentialId !== null &&
          connection.credentialId !== resource.credentialId) ||
        (resource.resourceType === "connection" &&
          (connection.host !== resource.host ||
            connection.port !== resource.port ||
            connection.cloudflareAccessId !== resource.cloudflareAccessId)))
    ) {
      return false;
    }
  }
  return true;
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
  // Close the captured Run's server authority first. The runner may retain a
  // socket, so the hard-cancel signal still needs a remote acknowledgement.
  const transitionedGroup =
    resource.resourceType === "run"
      ? await db.transaction(async (tx) => {
          const transitioned = await transitionAgentRunsToTerminal(tx, {
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
          await releaseActiveAgentRuns(tx, neverStartedRunIds(transitioned));
          return transitioned[0]?.runnerGroup ?? null;
        })
      : null;
  // Server-side access is per user even when an agent or Cloudflare Access
  // configuration is shared by an organization. Never revoke the shared peer.
  await db
    .delete(agentSshAccess)
    .where(
      and(
        eq(agentSshAccess.userId, resource.userId),
        eq(agentSshAccess.orgId, resource.orgId),
      ),
    );
  signal.throwIfAborted();
  const published = await settle(
    (async () => {
      const groups = [resource.runnerGroup, transitionedGroup].filter(
        (group, index, values): group is string => {
          return group !== null && values.indexOf(group) === index;
        },
      );
      if (resource.resourceType === "run" && groups.length > 0) {
        for (const group of groups) {
          await publishCancelToRunnerGroup(group, resource.resourceId, "hard");
          await publishSshInvalidationToRunnerGroup(group, {
            runId: resource.resourceId,
            connectionId: null,
          });
        }
      } else {
        await publishSshRuntimeInvalidation(db, {
          userId: resource.userId,
          orgId: resource.orgId,
          connectionId: resource.connectionId,
        });
      }
    })(),
    signal,
  );
  if (!published.ok) {
    return unresolved("verification_failed", "retryable_failure");
  }
  // Publication is not an acknowledgement by a runner/remote host; the
  // encrypted SSH key can still be used outside this server.
  return {
    requestRef: ref(["ssh-remote-revoke", lease.jobId, lease.item.itemKey]),
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
      evidenceRef: ref(["ssh-remote-absence", lease.jobId, lease.item.itemKey]),
      authenticatedReaderRef: ref([
        "ssh-remote-db-reader",
        SSH_REMOTE_ERASURE_COLLECTOR_VERSION,
      ]),
      enumerationRef: ref(["ssh-remote-item-enumeration", lease.item.itemKey]),
      observedAt: nowDate(),
    };
  }
  signal.throwIfAborted();
  if (!(await currentOwnership(db, resource))) {
    return unresolved("ownership_unknown");
  }
  const [grant] = await db
    .select({ agentId: agentSshAccess.agentId })
    .from(agentSshAccess)
    .where(
      and(
        eq(agentSshAccess.userId, resource.userId),
        eq(agentSshAccess.orgId, resource.orgId),
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
  // A fresh server read proves the grant is gone. It cannot prove the runner
  // evicted a cached key, a live SSH/VNC socket closed, or that the remote SSH
  // provider deleted the authorized key. The catalog row disappearing is not
  // a substitute for those independent remote readbacks.
  return unresolved("boundary_unproven");
}

/** Partial remote B1 capture; the top-level remote gate remains unregistered. */
export function createSshRemoteErasureCollector(db: Db): ErasureHandler {
  return {
    version: SSH_REMOTE_ERASURE_COLLECTOR_VERSION,
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
