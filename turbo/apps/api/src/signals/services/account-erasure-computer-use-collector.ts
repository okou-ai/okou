import { createStore } from "ccstate";
import { and, asc, eq, gt, inArray, ne } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";
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
import {
  computerUseCommandAuditEvents,
  computerUseCommands,
  computerUseHosts,
} from "@okouai/db/schema/computer-use-host";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { chatThreadEvents } from "@okouai/db/schema/chat-thread-event";

import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import { deleteS3Objects, listS3ObjectsPage } from "../external/s3";
import { safeJsonParse, settle } from "../utils";
import {
  decryptErasureSelector,
  encryptErasureSelector,
} from "./account-erasure-selector";

const NAMESPACE = "a77c441d-55a1-4c96-84e6-15b62a79b4f3";
const PAGE_SIZE = 100;
const DELETE_PAGE_SIZE = 1000;
const MAX_DELETE_PAGES = 10;
const cursorSchema = z.tuple([z.number().int().min(0).max(1), z.uuid()]);
export const COMPUTER_USE_ERASURE_COLLECTOR_VERSION =
  "41aca836-2010-4bf6-9019-6cd3df7f0371";

function ref(parts: readonly unknown[]): string {
  return uuidv5(JSON.stringify(parts), NAMESPACE);
}

function unresolved(
  errorCode: NonNullable<ErasureUnresolved["errorCode"]>,
  outcome: ErasureUnresolved["outcome"] = "capability_unresolved",
): ErasureUnresolved {
  return { outcome, errorCode, requestRef: null };
}

function storageRef(bucket: string): string {
  return ref([
    "computer-use-bucket",
    bucket,
    env("R2_ACCOUNT_ID"),
    env("S3_ENDPOINT") ?? null,
  ]);
}

function safeScope(orgId: string, userId: string): boolean {
  return /^[a-zA-Z0-9_-]+$/u.test(orgId) && /^[a-zA-Z0-9_-]+$/u.test(userId);
}

function commandPrefix(orgId: string, userId: string, id: string): string {
  return `computer-use/${orgId}/${userId}/${id}/`;
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
  readonly orgId: string;
  readonly hostId: string | null;
  readonly credentialDigest: string | null;
  readonly wasRunning: boolean;
  readonly result?: typeof computerUseCommands.$inferSelect.result;
};

async function readPage(
  db: Db,
  userId: string,
  after?: readonly [number, string],
): Promise<Resource[]> {
  const rows: Resource[] = [];
  if (!after || after[0] === 0) {
    const hosts = await db
      .select({
        id: computerUseHosts.id,
        orgId: computerUseHosts.orgId,
        tokenHash: computerUseHosts.tokenHash,
      })
      .from(computerUseHosts)
      .where(
        and(
          eq(computerUseHosts.userId, userId),
          after ? gt(computerUseHosts.id, after[1]) : undefined,
        ),
      )
      .orderBy(asc(computerUseHosts.id))
      .limit(PAGE_SIZE);
    rows.push(
      ...hosts.map((host) => {
        return {
          ordinal: 0,
          id: host.id,
          orgId: host.orgId,
          hostId: host.id,
          credentialDigest: host.tokenHash,
          wasRunning: false,
        };
      }),
    );
  }
  if (rows.length < PAGE_SIZE) {
    const commands = await db
      .select({
        id: computerUseCommands.id,
        orgId: computerUseCommands.orgId,
        hostId: computerUseCommands.hostId,
        status: computerUseCommands.status,
        result: computerUseCommands.result,
      })
      .from(computerUseCommands)
      .where(
        and(
          eq(computerUseCommands.userId, userId),
          after?.[0] === 1 ? gt(computerUseCommands.id, after[1]) : undefined,
        ),
      )
      .orderBy(asc(computerUseCommands.id))
      .limit(PAGE_SIZE - rows.length);
    rows.push(
      ...commands.map((command) => {
        return {
          ordinal: 1,
          id: command.id,
          orgId: command.orgId,
          hostId: command.hostId,
          credentialDigest: null,
          wasRunning: command.status === "running",
          result: command.result,
        };
      }),
    );
  }
  return rows;
}

/** Another account's row can refer to a host even if its registration belongs
 * to this account. Never revoke the shared credential or delete its host. */
async function otherHostReferences(db: Db, hostId: string, userId: string) {
  const [command] = await db
    .select({ id: computerUseCommands.id })
    .from(computerUseCommands)
    .where(
      and(
        eq(computerUseCommands.hostId, hostId),
        ne(computerUseCommands.userId, userId),
      ),
    )
    .limit(1);
  const [thread] = await db
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.computerUseHostId, hostId),
        ne(chatThreads.userId, userId),
      ),
    )
    .limit(1);
  const [event] = await db
    .select({ id: chatThreadEvents.id })
    .from(chatThreadEvents)
    .where(
      and(
        eq(chatThreadEvents.computerUseHostId, hostId),
        ne(chatThreadEvents.userId, userId),
      ),
    )
    .limit(1);
  const [audit] = await db
    .select({ id: computerUseCommandAuditEvents.id })
    .from(computerUseCommandAuditEvents)
    .where(
      and(
        eq(computerUseCommandAuditEvents.hostId, hostId),
        ne(computerUseCommandAuditEvents.userId, userId),
      ),
    )
    .limit(1);
  return Boolean(command || thread || event || audit);
}

function pointerOwned(value: unknown, bucket: string, prefix: string): boolean {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return true;
  }
  if (value.type === "expired") {
    return !("bucket" in value) && !("key" in value);
  }
  if (value.type !== "s3") {
    return false;
  }
  return (
    "bucket" in value &&
    value.bucket === bucket &&
    "key" in value &&
    typeof value.key === "string" &&
    value.key.startsWith(prefix)
  );
}

async function pageOwnershipSafe(
  db: Db,
  rows: readonly Resource[],
  userId: string,
  bucket: string,
): Promise<boolean> {
  // Many commands can share one host. Check its owner and cross-account
  // references once per bounded page, not once per command (8,000+ per user).
  const checkedHosts = new Map<string, { userId: string; orgId: string }>();
  for (const row of rows) {
    if (!safeScope(row.orgId, userId)) {
      return false;
    }
    if (row.hostId) {
      if (!checkedHosts.has(row.hostId)) {
        if (await otherHostReferences(db, row.hostId, userId)) {
          return false;
        }
        const [host] = await db
          .select({
            userId: computerUseHosts.userId,
            orgId: computerUseHosts.orgId,
          })
          .from(computerUseHosts)
          .where(eq(computerUseHosts.id, row.hostId))
          .limit(1);
        if (!host) {
          return false;
        }
        checkedHosts.set(row.hostId, host);
      }
      const host = checkedHosts.get(row.hostId);
      if (host?.userId !== userId || host.orgId !== row.orgId) {
        return false;
      }
    }
    if (row.ordinal !== 1) {
      continue;
    }
    const prefix = commandPrefix(row.orgId, userId, row.id);
    if (
      !pointerOwned(row.result?.screenshot, bucket, prefix) ||
      !pointerOwned(row.result?.pluginContent, bucket, prefix)
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
  const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
  if (subject?.kind !== "subject" || subject.subjectKind !== "user") {
    return unresolved("selector_missing");
  }
  if (!bucket) {
    return unresolved("permission_missing");
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
  if (!(await pageOwnershipSafe(db, rows, subject.subjectId, bucket))) {
    return unresolved("ownership_unknown");
  }
  const items = await Promise.all(
    rows.map(async (row) => {
      return {
        sinkId: lease.item.sinkId,
        itemKey: ref(["computer-use", row.ordinal, row.id]),
        kind: "erase" as const,
        selector: await encryptErasureSelector({
          version: 1,
          kind: "computer_use",
          userId: subject.subjectId,
          orgId: row.orgId,
          resourceType: row.ordinal === 0 ? "host" : "command",
          resourceId: row.id,
          hostId: row.hostId,
          credentialDigest: row.credentialDigest,
          wasRunning: row.wasRunning,
          storageRef: storageRef(bucket),
          prefix:
            row.ordinal === 1
              ? commandPrefix(row.orgId, subject.subjectId, row.id)
              : null,
        }),
        dependencies: [],
      };
    }),
  );
  const last = rows.at(-1);
  return {
    pageKey: ref([
      "computer-use-page",
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
            "computer-use-enumeration",
            subject.subjectId,
            COMPUTER_USE_ERASURE_COLLECTOR_VERSION,
          ])
        : null,
    items,
  };
}

async function target(lease: ErasureLease, bucket: string) {
  const selector = await selected(lease);
  if (
    selector?.kind !== "computer_use" ||
    selector.storageRef !== storageRef(bucket) ||
    !safeScope(selector.orgId, selector.userId) ||
    (selector.resourceType === "host" &&
      (selector.hostId !== selector.resourceId ||
        !selector.credentialDigest ||
        selector.wasRunning)) ||
    (selector.resourceType === "command" &&
      selector.credentialDigest !== null) ||
    selector.prefix !==
      (selector.resourceType === "command"
        ? commandPrefix(selector.orgId, selector.userId, selector.resourceId)
        : null)
  ) {
    return undefined;
  }
  return selector;
}

async function erase(db: Db, lease: ErasureLease, signal: AbortSignal) {
  const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
  if (!bucket) {
    return unresolved("permission_missing");
  }
  const resource = await target(lease, bucket);
  if (!resource) {
    return unresolved("selector_missing");
  }
  if (
    resource.hostId &&
    (await otherHostReferences(db, resource.hostId, resource.userId))
  ) {
    return unresolved("ownership_unknown");
  }
  await renewErasureLease(db, lease);
  const now = nowDate();
  if (resource.resourceType === "host") {
    // No Desktop-side per-user deletion API exists. Revoke server credentials,
    // but retain an explicit remote residual even after the catalog is swept.
    await db
      .update(computerUseHosts)
      .set({ revokedAt: now, status: "offline", updatedAt: now })
      .where(
        and(
          eq(computerUseHosts.id, resource.resourceId),
          eq(computerUseHosts.userId, resource.userId),
          eq(computerUseHosts.orgId, resource.orgId),
          eq(computerUseHosts.tokenHash, resource.credentialDigest ?? ""),
        ),
      );
    return {
      requestRef: ref([
        "computer-use-host-stop",
        lease.jobId,
        lease.item.itemKey,
      ]),
    };
  }
  await db
    .update(computerUseCommands)
    .set({
      status: "failed",
      error: "account_erasure",
      completedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(computerUseCommands.id, resource.resourceId),
        eq(computerUseCommands.userId, resource.userId),
        eq(computerUseCommands.orgId, resource.orgId),
        // A completed command is already terminal; preserve its result for B1.
        inArray(computerUseCommands.status, ["queued", "running"]),
      ),
    );
  const store = createStore();
  for (let page = 0; page < MAX_DELETE_PAGES; page += 1) {
    signal.throwIfAborted();
    await renewErasureLease(db, lease);
    const listed = await settle(
      store.get(
        listS3ObjectsPage(bucket, resource.prefix ?? "", DELETE_PAGE_SIZE),
      ),
      signal,
    );
    if (!listed.ok) {
      return unresolved("verification_failed", "retryable_failure");
    }
    if (
      listed.value.objects.some((object) => {
        return !object.key.startsWith(resource.prefix ?? "");
      })
    ) {
      return unresolved("ownership_unknown");
    }
    if (listed.value.objects.length === 0) {
      if (listed.value.isTruncated) {
        return unresolved("verification_failed", "retryable_failure");
      }
      break;
    }
    const deleted = await settle(
      store.get(
        deleteS3Objects(
          bucket,
          listed.value.objects.map((object) => {
            return object.key;
          }),
          signal,
        ),
      ),
      signal,
    );
    if (!deleted.ok) {
      return unresolved("verification_failed", "retryable_failure");
    }
    if (listed.value.isTruncated && page + 1 === MAX_DELETE_PAGES) {
      return {
        ...unresolved("boundary_unproven", "pending"),
        retryAt: new Date(nowDate().getTime() + 60_000),
      };
    }
  }
  return {
    requestRef: ref([
      "computer-use-command-delete",
      lease.jobId,
      lease.item.itemKey,
    ]),
  };
}

async function verifyRemoteResource(
  db: Db,
  resource: NonNullable<Awaited<ReturnType<typeof target>>>,
  bucket: string,
  signal: AbortSignal,
): Promise<ErasureUnresolved> {
  if (
    resource.hostId &&
    (await otherHostReferences(db, resource.hostId, resource.userId))
  ) {
    return unresolved("ownership_unknown");
  }
  if (resource.resourceType === "host") {
    const [host] = await db
      .select({
        revokedAt: computerUseHosts.revokedAt,
        tokenHash: computerUseHosts.tokenHash,
      })
      .from(computerUseHosts)
      .where(eq(computerUseHosts.id, resource.resourceId))
      .limit(1);
    if (
      host &&
      (host.revokedAt === null || host.tokenHash !== resource.credentialDigest)
    ) {
      return unresolved("verification_failed", "retryable_failure");
    }
    // Revocation/DB absence does not prove Desktop-local deletion.
    return unresolved("boundary_unproven");
  }
  const [command] = await db
    .select({ status: computerUseCommands.status })
    .from(computerUseCommands)
    .where(eq(computerUseCommands.id, resource.resourceId))
    .limit(1);
  if (
    command &&
    command.status !== "failed" &&
    command.status !== "succeeded"
  ) {
    return unresolved("verification_failed", "retryable_failure");
  }
  const listed = await settle(
    createStore().get(listS3ObjectsPage(bucket, resource.prefix ?? "", 1)),
    signal,
  );
  if (!listed.ok) {
    return unresolved("verification_failed", "retryable_failure");
  }
  if (
    listed.value.objects.some((object) => {
      return !object.key.startsWith(resource.prefix ?? "");
    })
  ) {
    return unresolved("ownership_unknown");
  }
  if (listed.value.objects.length > 0 || listed.value.isTruncated) {
    return unresolved("verification_failed", "retryable_failure");
  }
  // A queued command can be claimed between inventory and closure; after
  // relational sweep its row cannot reconstruct whether Desktop ran it.
  // Object LIST absence is necessary, not a Desktop-local deletion receipt.
  return unresolved("boundary_unproven");
}

async function verify(
  db: Db,
  lease: ErasureLease,
  boundary: string,
  signal: AbortSignal,
): Promise<ErasureProof | ErasureUnresolved> {
  const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
  if (!bucket) {
    return unresolved("permission_missing");
  }
  const resource = await target(lease, bucket);
  if (!resource) {
    const subject = await selected(lease);
    if (subject?.kind !== "subject" || subject.subjectKind !== "user") {
      return unresolved("selector_missing");
    }
  } else {
    return await verifyRemoteResource(db, resource, bucket, signal);
  }
  return {
    workId: lease.workId,
    sinkId: lease.item.sinkId,
    generation: lease.generation,
    captureRevision: lease.captureRevision,
    inventoryRevision: lease.inventoryRevision,
    producerBoundaryRef: boundary,
    outcome: "verified_no_applicable_data",
    evidenceRef: ref(["computer-use-absence", lease.jobId, lease.item.itemKey]),
    authenticatedReaderRef: ref(["computer-use-reader", storageRef(bucket)]),
    enumerationRef: ref(["computer-use-item-enumeration", lease.item.itemKey]),
    observedAt: nowDate(),
  };
}

/** Narrow Computer Use capture. Other remote services are still required. */
export function createComputerUseErasureCollector(db: Db): ErasureHandler {
  return {
    version: COMPUTER_USE_ERASURE_COLLECTOR_VERSION,
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
