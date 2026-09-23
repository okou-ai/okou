import { createStore } from "ccstate";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { v5 as uuidv5 } from "uuid";
import { z } from "zod";

import { storages, storageVersions } from "@okouai/db/schema/storage";
import type {
  EncryptedErasureSelector,
  ErasureHandler,
  ErasureInventoryPage,
  ErasureLease,
  ErasureProof,
  ErasureSubject,
  ErasureUnresolved,
} from "@okouai/db/operations/account-erasure";

import { env } from "../../lib/env";
import { executeRawRows } from "../../lib/db-raw-rows";
import { nowDate } from "../../lib/time";
import { safeJsonParse } from "../utils";
import { deleteS3Objects, listS3ObjectsUnderPrefix } from "../external/s3";
import {
  decryptErasureSelector,
  encryptErasureSelector,
} from "./account-erasure-selector";

type Db = NodePgDatabase<Record<string, never>>;

/** Capture both roots that the relational sweep can remove. Deleting a user's
 * storage cascades to its versions, including versions written by another
 * member. Conversely, a version created by the user can live below someone
 * else's storage. The storage prefix covers the former and the version key
 * covers the latter, without touching sibling versions.
 */
const STORAGE_SOURCES = ["storages", "storage_versions"] as const;

const MAX_INVENTORY_PAGE = 100;

// Immutable v1 namespace. Names are JSON tuples, never concatenation, so two
// different reference inputs cannot collide on one string.
const STORAGE_OBJECT_NAMESPACE = "0c9ba03d-923d-4607-8fd0-3487b7a34321";

/** The sink's collector version. `executeErasureWork` refuses to run a handler
 * whose version does not equal the registered sink's `collectorVersion`, so
 * this changes whenever the sweep's observable behaviour changes.
 */
export const STORAGE_OBJECT_ERASURE_COLLECTOR_VERSION =
  "d9d9bcb5-2bc7-4f7a-a52f-498c754d65e6";

function reference(parts: readonly unknown[]): string {
  return uuidv5(JSON.stringify(parts), STORAGE_OBJECT_NAMESPACE);
}

const unresolved = (
  errorCode: NonNullable<ErasureUnresolved["errorCode"]>,
  outcome: ErasureUnresolved["outcome"] = "capability_unresolved",
): ErasureUnresolved => {
  return { outcome, errorCode, requestRef: null };
};

/** The bucket, or the reason this storage cannot erase bytes at all.
 *
 * An unconfigured bucket is a capability this process does not have. It is
 * reported as an unresolved capability rather than treated as "no objects", so
 * the job records an explicit residual instead of counting the account clean.
 */
function storageBucket(): string | undefined {
  return env("R2_USER_STORAGES_BUCKET_NAME");
}

/** One durable name for the user storages bucket.
 *
 * The selector vocabulary keys a storage by uuid rather than by bucket name so
 * a captured locator does not carry bucket configuration, and so renaming
 * a bucket does not silently repoint a captured selector at a different one.
 */
function storageReference(): string {
  return reference(["user-storages-bucket", 1]);
}

const cursorSchema = z
  .tuple([z.number().int().min(0).max(1), z.string().min(1).max(64)])
  .readonly();

function encodeCursor(ordinal: number, id: string): string {
  return JSON.stringify([ordinal, id]);
}

function decodeCursor(
  after: string,
): { readonly ordinal: number; readonly id: string } | undefined {
  const cursor = cursorSchema.safeParse(safeJsonParse(after));
  return cursor.success
    ? { ordinal: cursor.data[0], id: cursor.data[1] }
    : undefined;
}

/** The subject a lease names, when its selector is the subject itself. */
async function leaseSubject(
  lease: ErasureLease,
): Promise<ErasureSubject | undefined> {
  if (!lease.item.selectorCiphertext || !lease.item.selectorDigest) {
    return undefined;
  }
  const selector = await decryptErasureSelector({
    ciphertext: lease.item.selectorCiphertext,
    digest: lease.item.selectorDigest,
  });
  return selector.kind === "subject"
    ? { subjectKind: selector.subjectKind, subjectId: selector.subjectId }
    : undefined;
}

/** The prefix an erase item names, or nothing when the item is not one. */
async function leasePrefix(lease: ErasureLease): Promise<string | undefined> {
  if (!lease.item.selectorCiphertext || !lease.item.selectorDigest) {
    return undefined;
  }
  const selector = await decryptErasureSelector({
    ciphertext: lease.item.selectorCiphertext,
    digest: lease.item.selectorDigest,
  });
  return selector.kind === "object_prefix" &&
    selector.storageRef === storageReference()
    ? selector.prefix
    : undefined;
}

interface StorageObjectRow {
  readonly ordinal: number;
  readonly relation: string;
  readonly id: string;
  readonly prefix: string;
  readonly parentPrefix?: string | null;
}

/** One bounded, ordered page of the subject's storage prefixes.
 *
 * Ordered by `(source ordinal, id)` and resumed strictly after the last row of
 * the previous page, so the enumeration is a total order over both tables and
 * a resumed page cannot repeat or skip a row. The two predicates match the
 * relational sweep's roots: `storages.user_id` and
 * `storage_versions.created_by`.
 */
async function readStorageObjectPage(
  db: Db,
  subjectId: string,
  cursor: { readonly ordinal: number; readonly id: string } | undefined,
): Promise<StorageObjectRow[]> {
  const rows: StorageObjectRow[] = [];
  if (!cursor || cursor.ordinal === 0) {
    const page = await db
      .select({ id: storages.id, prefix: storages.s3Prefix })
      .from(storages)
      .where(
        and(
          eq(storages.userId, subjectId),
          cursor ? gt(storages.id, cursor.id) : undefined,
        ),
      )
      .orderBy(asc(storages.id))
      .limit(MAX_INVENTORY_PAGE);
    for (const row of page) {
      rows.push({ ordinal: 0, relation: "storages", ...row });
    }
  }
  if (rows.length < MAX_INVENTORY_PAGE) {
    const page = await db
      .select({
        id: storageVersions.id,
        prefix: storageVersions.s3Key,
        parentPrefix: storages.s3Prefix,
      })
      .from(storageVersions)
      .leftJoin(storages, eq(storageVersions.storageId, storages.id))
      .where(
        and(
          eq(storageVersions.createdBy, subjectId),
          cursor?.ordinal === 1 ? gt(storageVersions.id, cursor.id) : undefined,
        ),
      )
      .orderBy(asc(storageVersions.id))
      .limit(MAX_INVENTORY_PAGE - rows.length);
    for (const row of page) {
      rows.push({ ordinal: 1, relation: "storage_versions", ...row });
    }
  }
  return rows;
}

function enumerationReference(subject: ErasureSubject): string {
  return reference([
    "storage-object-enumeration",
    STORAGE_OBJECT_ERASURE_COLLECTOR_VERSION,
    subject.subjectKind,
    subject.subjectId,
    STORAGE_SOURCES,
  ]);
}

function requestReference(
  lease: ErasureLease,
  outcome: "erased" | "empty",
): string {
  return reference([
    "storage-object-erase",
    lease.jobId,
    lease.item.sinkId,
    lease.item.itemKey,
    lease.captureRevision,
    outcome,
  ]);
}

async function inventoryPage(
  db: Db,
  lease: ErasureLease,
  cursor: EncryptedErasureSelector | null,
): Promise<ErasureInventoryPage | ErasureUnresolved> {
  const subject = await leaseSubject(lease);
  if (!subject || subject.subjectKind !== "user") {
    return unresolved("selector_missing");
  }
  if (storageBucket() === undefined) {
    return unresolved("permission_missing");
  }
  let resume: { readonly ordinal: number; readonly id: string } | undefined;
  if (cursor !== null) {
    const decoded = await decryptErasureSelector(cursor);
    const after =
      decoded.kind === "cursor" ? decodeCursor(decoded.after) : undefined;
    if (!after) {
      return unresolved("selector_missing");
    }
    resume = after;
  }
  const rows = await readStorageObjectPage(db, subject.subjectId, resume);
  // The writer stores a version at exactly `${storage.s3Prefix}/${versionId}`.
  // A mismatched persisted key could otherwise erase a sibling or another
  // member's resource. Refuse the capture instead of trusting that locator.
  if (
    rows.some((row) => {
      return (
        row.relation === "storage_versions" &&
        row.prefix !== `${row.parentPrefix}/${row.id}`
      );
    })
  ) {
    return unresolved("ownership_unknown");
  }
  // Historical storage prefixes predate the immutable storage-id segment and
  // can overlap across members. A prefix is safe to erase only when no other
  // storage names that exact prefix, one of its descendants, or one of its
  // ancestors. A descendant would be deleted by this prefix; an ancestor
  // could delete this prefix in another job. Check version parents too, so a
  // version below another member's storage cannot claim an ambiguous prefix.
  const prefixes = [
    ...new Set(
      rows.map((row) => {
        return row.relation === "storages" ? row.prefix : row.parentPrefix;
      }),
    ),
  ].filter((prefix): prefix is string => {
    return prefix !== null && prefix !== undefined;
  });
  if (prefixes.length > 0) {
    const values = sql.join(
      prefixes.map((prefix) => {
        return sql`(${prefix}::text)`;
      }),
      sql`, `,
    );
    const overlaps = await executeRawRows(
      db,
      sql`
      SELECT 1 AS overlap FROM storages AS candidate
      JOIN (VALUES ${values}) AS sought(prefix)
        ON candidate.s3_prefix = sought.prefix
          OR left(candidate.s3_prefix, length(sought.prefix) + 1) = sought.prefix || '/'
          OR left(sought.prefix, length(candidate.s3_prefix) + 1) = candidate.s3_prefix || '/'
      GROUP BY sought.prefix
      HAVING count(DISTINCT candidate.id) > 1
      LIMIT 1
    `,
      z.object({ overlap: z.number() }),
    );
    if (overlaps.length > 0) {
      return unresolved("ownership_unknown");
    }
  }
  const last = rows[rows.length - 1];
  const storageRef = storageReference();
  const items = await Promise.all(
    rows.map(async (row) => {
      return {
        sinkId: lease.item.sinkId,
        // Keyed by the row, not by the prefix: two rows must never collapse
        // into one work item even if they were published to the same prefix.
        itemKey: reference(["storage-object-item", row.relation, row.id]),
        kind: "erase" as const,
        selector: await encryptErasureSelector({
          version: 1,
          kind: "object_prefix",
          storageRef,
          prefix: row.prefix,
        }),
        dependencies: [],
      };
    }),
  );
  // A full page may still have more rows behind it, so it advances the cursor.
  // A short page is the end of the enumeration and may claim it.
  const complete = last === undefined || rows.length < MAX_INVENTORY_PAGE;
  return {
    pageKey: reference([
      "storage-object-page",
      lease.jobId,
      lease.captureRevision,
      resume ? [resume.ordinal, resume.id] : null,
    ]),
    inputCursorDigest: lease.item.cursorDigest,
    nextCursor:
      complete || !last
        ? null
        : await encryptErasureSelector({
            version: 1,
            kind: "cursor",
            after: encodeCursor(last.ordinal, last.id),
          }),
    enumerationRef: complete ? enumerationReference(subject) : null,
    items,
  };
}

/** Deletes every object under one captured storage or version prefix.
 *
 * The prefix comes from the captured selector rather than from a row read now.
 * By the time this runs the relational sweep may already have deleted the
 * catalog row. Storage prefixes include all versions that cascade with their
 * owner; a version prefix in another member's storage covers only that
 * version.
 */
async function erasePrefix(
  lease: ErasureLease,
  signal: AbortSignal,
): Promise<{ readonly requestRef: string } | ErasureUnresolved> {
  const prefix = await leasePrefix(lease);
  if (prefix === undefined) {
    return unresolved("selector_missing");
  }
  const bucket = storageBucket();
  if (bucket === undefined) {
    return unresolved("permission_missing");
  }
  const store = createStore();
  const objects = await store.get(listS3ObjectsUnderPrefix(bucket, prefix));
  if (objects.length === 0) {
    return { requestRef: requestReference(lease, "empty") };
  }
  // Batching belongs to `deleteS3Objects`, which already caps a
  // request at `S3_DELETE_OBJECTS_LIMIT` and stops at the first failed batch.
  await store.get(
    deleteS3Objects(
      bucket,
      objects.map((object) => {
        return object.key;
      }),
      signal,
    ),
  );
  return { requestRef: requestReference(lease, "erased") };
}

/** Absence, read back from the provider rather than inferred from the delete.
 *
 * A row count proves nothing here: the catalog row may already be gone. What
 * this asserts is that listing the captured prefix returns no object. The
 * relational sweep owns catalog deletion; this sink owns storage bytes.
 *
 * An erase item owns one captured prefix. The collector's own item is keyed by
 * the subject and owns the enumeration instead, so it reads no object at all.
 * That is not a weaker completion claim: `finalizeErasureJob` already requires
 * every erase item to carry a terminal proof, so no prefix can go unproven,
 * and `assertCaptureComplete` already requires this item to have reached
 * `captureComplete` with an enumeration reference before the capture could
 * seal. Making it re-list the account's prefixes instead would assert a fact
 * the erase items already own, and would only be true if those items ran
 * first — an ordering `claimErasureWork` does not provide, since it orders by
 * `available_at` and then by row id. That is a coin flip, not a check.
 */
async function verifyPrefixAbsent(
  lease: ErasureLease,
  producerBoundary: string,
): Promise<ErasureProof | ErasureUnresolved> {
  const prefix = await leasePrefix(lease);
  const bucket = storageBucket();
  if (bucket === undefined) {
    return unresolved("permission_missing");
  }
  if (prefix === undefined) {
    // The collector's own item. Its selector must still be this sink's
    // subject, or the lease does not belong here.
    const subject = await leaseSubject(lease);
    if (!subject || subject.subjectKind !== "user") {
      return unresolved("selector_missing");
    }
  } else {
    const remaining = await createStore().get(
      listS3ObjectsUnderPrefix(bucket, prefix),
    );
    if (remaining.length > 0) {
      return unresolved("verification_failed", "retryable_failure");
    }
  }
  return {
    workId: lease.workId,
    sinkId: lease.item.sinkId,
    generation: lease.generation,
    captureRevision: lease.captureRevision,
    inventoryRevision: lease.inventoryRevision,
    producerBoundaryRef: producerBoundary,
    outcome:
      lease.item.requestRef === requestReference(lease, "erased")
        ? "verified_erased"
        : "verified_no_applicable_data",
    evidenceRef: reference([
      "storage-object-absence",
      lease.jobId,
      lease.item.itemKey,
      lease.captureRevision,
    ]),
    authenticatedReaderRef: reference([
      "storage-object-reader",
      STORAGE_OBJECT_ERASURE_COLLECTOR_VERSION,
      storageReference(),
    ]),
    enumerationRef: reference([
      "storage-object-item-enumeration",
      STORAGE_OBJECT_ERASURE_COLLECTOR_VERSION,
      lease.item.itemKey,
    ]),
    observedAt: nowDate(),
  };
}

/** The storage-object sink.
 *
 * Same shape as `createRelationalErasureCollector`, different resource: the
 * inventory phase captures every storage and version prefix the subject owns.
 * Only after `sealErasureCapture` does any erase run. That ordering is the
 * contract's, not this sink's — `claimErasureWork` refuses the verification
 * phase while the capture is unsealed and the inventory phase once it is
 * sealed — and it is what guarantees a locator is durably captured before the
 * catalog row that held it can disappear.
 *
 * Unlike the relational sink this one really paginates, so its driver matters.
 * A page commit keeps the lease: `commitErasureInventoryPage` does not clear
 * `lease_id` the way `commitResult` does, and `claimErasureWork` skips a row
 * whose lease is still live. That is deliberate — it makes one worker the only
 * owner of a capture, so two cannot interleave pages and break the cursor
 * chain `cursor_mismatch` enforces. A caller therefore claims once and calls
 * `executeErasureWork` again for each page; claiming again per page yields
 * nothing after the first, and the capture never reaches `captureComplete`.
 */
export function createStorageObjectErasureCollector(db: Db): ErasureHandler {
  return {
    version: STORAGE_OBJECT_ERASURE_COLLECTOR_VERSION,
    inventory: async (lease, cursor) => {
      return await inventoryPage(db, lease, cursor);
    },
    erase: async (lease, signal) => {
      return await erasePrefix(lease, signal);
    },
    verify: async (lease, producerBoundary) => {
      return await verifyPrefixAbsent(lease, producerBoundary);
    },
  };
}
