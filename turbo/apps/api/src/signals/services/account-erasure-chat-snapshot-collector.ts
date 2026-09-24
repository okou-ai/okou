import { createStore } from "ccstate";
import { and, eq, inArray, like, sql } from "drizzle-orm";
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
import { chatThreadSnapshots } from "@okouai/db/schema/chat-thread-snapshot";
import { exportJobs } from "@okouai/db/schema/export-job";
import { userExportEntries } from "@okouai/db/schema/user-export-entry";

import { executeRawRows } from "../../lib/db-raw-rows";
import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import { deleteS3Objects, listS3ObjectsPage } from "../external/s3";
import { safeJsonParse } from "../utils";
import {
  decryptErasureSelector,
  encryptErasureSelector,
} from "./account-erasure-selector";
import {
  chatThreadSnapshotObjectPrefix,
  isOwnedChatThreadSnapshotObjectKey,
} from "./chat-thread-snapshot-object";

const NAMESPACE = "a3de0364-d613-42a4-8a74-b41d58bf39ac";
const PAGE_SIZE = 100;
const DELETE_PAGE_SIZE = 1000;
const DELETE_PAGES_PER_LEASE = 10;
export const CHAT_SNAPSHOT_ERASURE_COLLECTOR_VERSION =
  "467232ca-1844-4153-ad33-e8574fc7e723";

function ref(parts: readonly unknown[]): string {
  return uuidv5(JSON.stringify(parts), NAMESPACE);
}

function unresolved(
  errorCode: NonNullable<ErasureUnresolved["errorCode"]>,
  outcome: ErasureUnresolved["outcome"] = "capability_unresolved",
): ErasureUnresolved {
  return { outcome, errorCode, requestRef: null };
}

function bucket(): string | undefined {
  return env("R2_USER_STORAGES_BUCKET_NAME");
}

function storageRef(name: string): string {
  return ref([
    "chat-snapshot-bucket",
    name,
    env("R2_ACCOUNT_ID"),
    env("S3_ENDPOINT") ?? null,
  ]);
}

async function selectorOf(lease: ErasureLease) {
  if (!lease.item.selectorCiphertext || !lease.item.selectorDigest) {
    return undefined;
  }
  return await decryptErasureSelector({
    ciphertext: lease.item.selectorCiphertext,
    digest: lease.item.selectorDigest,
  });
}

async function snapshotOf(lease: ErasureLease, name: string) {
  const selector = await selectorOf(lease);
  return selector?.kind === "chat_snapshot" &&
    selector.storageRef === storageRef(name) &&
    selector.prefix ===
      chatThreadSnapshotObjectPrefix(selector.subjectId, selector.orgId)
    ? selector
    : undefined;
}

async function readPage(db: Db, userId: string, after?: string) {
  return await executeRawRows(
    db,
    sql`
      SELECT scoped.org_id AS "orgId"
      FROM (
        SELECT org_id FROM chat_thread_snapshots WHERE user_id = ${userId}
        UNION
        SELECT org_id FROM chat_thread_event_sequences WHERE user_id = ${userId}
        UNION
        SELECT org_id FROM chat_thread_events WHERE user_id = ${userId}
      ) AS scoped
      WHERE ${after ? sql`scoped.org_id > ${after}` : sql`true`}
      ORDER BY scoped.org_id
      LIMIT ${PAGE_SIZE}
    `,
    z.object({ orgId: z.string() }),
  );
}

async function inventory(
  db: Db,
  lease: ErasureLease,
  cursor: EncryptedErasureSelector | null,
): Promise<ErasureInventoryPage | ErasureUnresolved> {
  const subject = await selectorOf(lease);
  const name = bucket();
  if (subject?.kind !== "subject" || subject.subjectKind !== "user") {
    return unresolved("selector_missing");
  }
  if (!name) {
    return unresolved("permission_missing");
  }
  await renewErasureLease(db, lease);
  let after: string | undefined;
  if (cursor) {
    const decoded = await decryptErasureSelector(cursor);
    const parsed =
      decoded.kind === "cursor"
        ? z.string().min(1).max(192).safeParse(safeJsonParse(decoded.after))
        : undefined;
    if (!parsed?.success) {
      return unresolved("selector_missing");
    }
    after = parsed.data;
  }
  const rows = await readPage(db, subject.subjectId, after);
  if (rows.length > 0) {
    const pointers = await db
      .select({
        orgId: chatThreadSnapshots.orgId,
        key: chatThreadSnapshots.objectKey,
        seqId: chatThreadSnapshots.latestEventSeqId,
      })
      .from(chatThreadSnapshots)
      .where(
        and(
          eq(chatThreadSnapshots.userId, subject.subjectId),
          inArray(
            chatThreadSnapshots.orgId,
            rows.map((row) => {
              return row.orgId;
            }),
          ),
        ),
      );
    if (
      pointers.some((row) => {
        return (
          row.key !== null &&
          !isOwnedChatThreadSnapshotObjectKey(
            row.key,
            subject.subjectId,
            row.orgId,
            row.seqId,
          )
        );
      })
    ) {
      return unresolved("ownership_unknown");
    }
  }
  const items = await Promise.all(
    rows.map(async (row) => {
      return {
        sinkId: lease.item.sinkId,
        itemKey: ref(["chat-snapshot-scope", subject.subjectId, row.orgId]),
        kind: "erase" as const,
        selector: await encryptErasureSelector({
          version: 1,
          kind: "chat_snapshot",
          subjectId: subject.subjectId,
          orgId: row.orgId,
          storageRef: storageRef(name),
          prefix: chatThreadSnapshotObjectPrefix(subject.subjectId, row.orgId),
        }),
        dependencies: [],
      };
    }),
  );
  const last = rows.at(-1);
  return {
    pageKey: ref([
      "chat-snapshot-page",
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
            after: JSON.stringify(last.orgId),
          }),
    enumerationRef:
      rows.length < PAGE_SIZE
        ? ref([
            "chat-snapshot-enumeration",
            subject.subjectId,
            CHAT_SNAPSHOT_ERASURE_COLLECTOR_VERSION,
          ])
        : null,
    items,
  };
}

/** A user-export reader may have captured this source key before its owner
 * row disappeared. Never remove its bytes while that copy still needs them. */
async function exportReferences(db: Db, prefix: string, ownerId: string) {
  const [reference] = await db
    .select({ userId: exportJobs.userId })
    .from(userExportEntries)
    .innerJoin(exportJobs, eq(exportJobs.id, userExportEntries.jobId))
    .where(like(userExportEntries.sourceKey, `${prefix}%`))
    .limit(1);
  if (!reference) {
    return undefined;
  }
  return reference.userId === ownerId
    ? {
        ...unresolved("boundary_unproven", "pending"),
        retryAt: new Date(nowDate().getTime() + 60_000),
      }
    : unresolved("ownership_unknown");
}

async function erase(
  db: Db,
  lease: ErasureLease,
  signal: AbortSignal,
): Promise<{ readonly requestRef: string } | ErasureUnresolved> {
  const name = bucket();
  if (!name) {
    return unresolved("permission_missing");
  }
  const target = await snapshotOf(lease, name);
  if (!target) {
    return unresolved("selector_missing");
  }
  const referenced = await exportReferences(
    db,
    target.prefix,
    target.subjectId,
  );
  if (referenced) {
    return referenced;
  }
  const store = createStore();
  for (let page = 0; page < DELETE_PAGES_PER_LEASE; page += 1) {
    signal.throwIfAborted();
    await renewErasureLease(db, lease);
    const listed = await store.get(
      listS3ObjectsPage(name, target.prefix, DELETE_PAGE_SIZE),
    );
    if (listed.objects.length === 0) {
      break;
    }
    await store.get(
      deleteS3Objects(
        name,
        listed.objects.map((object) => {
          return object.key;
        }),
        signal,
      ),
    );
    if (listed.isTruncated && page + 1 === DELETE_PAGES_PER_LEASE) {
      return {
        ...unresolved("boundary_unproven", "pending"),
        retryAt: new Date(nowDate().getTime() + 60_000),
      };
    }
  }
  return {
    requestRef: ref(["chat-snapshot-delete", lease.jobId, lease.item.itemKey]),
  };
}

async function verify(
  db: Db,
  lease: ErasureLease,
  boundary: string,
  signal: AbortSignal,
): Promise<ErasureProof | ErasureUnresolved> {
  const name = bucket();
  if (!name) {
    return unresolved("permission_missing");
  }
  const target = await snapshotOf(lease, name);
  if (!target) {
    const subject = await selectorOf(lease);
    if (subject?.kind !== "subject" || subject.subjectKind !== "user") {
      return unresolved("selector_missing");
    }
  } else {
    const referenced = await exportReferences(
      db,
      target.prefix,
      target.subjectId,
    );
    if (referenced) {
      return referenced;
    }
    signal.throwIfAborted();
    const listed = await createStore().get(
      listS3ObjectsPage(name, target.prefix, 1),
    );
    if (listed.objects.length > 0 || listed.isTruncated) {
      return unresolved("verification_failed", "retryable_failure");
    }
  }
  return {
    workId: lease.workId,
    sinkId: lease.item.sinkId,
    generation: lease.generation,
    captureRevision: lease.captureRevision,
    inventoryRevision: lease.inventoryRevision,
    producerBoundaryRef: boundary,
    outcome: target ? "verified_erased" : "verified_no_applicable_data",
    evidenceRef: ref([
      "chat-snapshot-absence",
      lease.jobId,
      lease.item.itemKey,
    ]),
    authenticatedReaderRef: ref(["chat-snapshot-reader", storageRef(name)]),
    enumerationRef: ref(["chat-snapshot-item-enumeration", lease.item.itemKey]),
    observedAt: nowDate(),
  };
}

/** Erases every immutable snapshot version in a captured user/org scope, not
 * just the current pointer. Full recovery-copy purging remains a distinct
 * required B1 sink; this R2 object sink must not count as that proof. */
export function createChatSnapshotErasureCollector(db: Db): ErasureHandler {
  return {
    version: CHAT_SNAPSHOT_ERASURE_COLLECTOR_VERSION,
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
