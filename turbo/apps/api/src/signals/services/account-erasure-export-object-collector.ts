import { createStore } from "ccstate";
import { and, asc, eq, gt, notExists } from "drizzle-orm";
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
import { backgroundJobs } from "@okouai/db/schema/background-job";
import { exportJobs } from "@okouai/db/schema/export-job";

import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import {
  deleteS3Objects,
  listMultipartS3UploadsPage,
  listUserExportStagingPage,
  s3ObjectExists,
} from "../external/s3";
import { safeJsonParse } from "../utils";
import {
  decryptErasureSelector,
  encryptErasureSelector,
} from "./account-erasure-selector";
import { cleanupDurableUserExports$ } from "./user-export-cleanup.service";

const NAMESPACE = "7f2fe103-58c7-4750-b815-eb20199dc1fe";
const PAGE_SIZE = 100;
const RETRY_MS = 60_000;
const cursorSchema = z.tuple([z.number().int().min(0).max(1), z.uuid()]);

export const EXPORT_OBJECT_ERASURE_COLLECTOR_VERSION =
  "d09b3bfc-b0c2-4a9a-9961-827699e67f2a";

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
    "export-bucket",
    name,
    env("R2_ACCOUNT_ID"),
    env("S3_ENDPOINT") ?? null,
  ]);
}

async function subjectOf(lease: ErasureLease): Promise<string | undefined> {
  if (!lease.item.selectorCiphertext || !lease.item.selectorDigest) {
    return undefined;
  }
  const selector = await decryptErasureSelector({
    ciphertext: lease.item.selectorCiphertext,
    digest: lease.item.selectorDigest,
  });
  return selector.kind === "subject" && selector.subjectKind === "user"
    ? selector.subjectId
    : undefined;
}

async function exportOf(lease: ErasureLease) {
  if (!lease.item.selectorCiphertext || !lease.item.selectorDigest) {
    return undefined;
  }
  const selector = await decryptErasureSelector({
    ciphertext: lease.item.selectorCiphertext,
    digest: lease.item.selectorDigest,
  });
  const name = bucket();
  if (
    !name ||
    selector.kind !== "export_object" ||
    selector.storageRef !== storageRef(name) ||
    selector.resultKey !==
      `exports/${selector.subjectId}/${selector.jobId}.zip` ||
    selector.stagingPrefix !==
      `exports/${selector.subjectId}/${selector.jobId}/staging/` ||
    (selector.legacyKey !== undefined &&
      !selector.legacyKey.startsWith(`exports/${selector.subjectId}/`))
  ) {
    return undefined;
  }
  return { ...selector, bucket: name };
}

interface ExportRow {
  readonly ordinal: number;
  readonly id: string;
  readonly s3Key: string | null;
  readonly legacyActive: boolean;
}

async function readPage(
  db: Db,
  userId: string,
  cursor: readonly [number, string] | undefined,
): Promise<ExportRow[]> {
  const rows: ExportRow[] = [];
  if (!cursor || cursor[0] === 0) {
    const exports = await db
      .select({
        id: exportJobs.id,
        s3Key: exportJobs.s3Key,
        status: exportJobs.status,
        executionMode: exportJobs.executionMode,
      })
      .from(exportJobs)
      .where(
        and(
          eq(exportJobs.userId, userId),
          cursor ? gt(exportJobs.id, cursor[1]) : undefined,
        ),
      )
      .orderBy(asc(exportJobs.id))
      .limit(PAGE_SIZE);
    for (const item of exports) {
      rows.push({
        ordinal: 0,
        id: item.id,
        s3Key: item.s3Key,
        legacyActive:
          item.executionMode === null &&
          (item.status === "pending" || item.status === "running"),
      });
    }
  }
  if (rows.length < PAGE_SIZE) {
    const orphans = await db
      .select({ id: backgroundJobs.id })
      .from(backgroundJobs)
      .where(
        and(
          eq(backgroundJobs.kind, "user-export"),
          eq(backgroundJobs.handlerVersion, 1),
          eq(backgroundJobs.userId, userId),
          cursor?.[0] === 1 ? gt(backgroundJobs.id, cursor[1]) : undefined,
          notExists(
            db
              .select({ id: exportJobs.id })
              .from(exportJobs)
              .where(eq(exportJobs.id, backgroundJobs.id)),
          ),
        ),
      )
      .orderBy(asc(backgroundJobs.id))
      .limit(PAGE_SIZE - rows.length);
    for (const item of orphans) {
      rows.push({ ordinal: 1, id: item.id, s3Key: null, legacyActive: false });
    }
  }
  return rows;
}

async function inventory(
  db: Db,
  lease: ErasureLease,
  cursor: EncryptedErasureSelector | null,
): Promise<ErasureInventoryPage | ErasureUnresolved> {
  const userId = await subjectOf(lease);
  const name = bucket();
  if (!userId) {
    return unresolved("selector_missing");
  }
  if (!name) {
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
  const rows = await readPage(db, userId, after);
  if (
    rows.some((row) => {
      return (
        row.legacyActive ||
        (row.s3Key !== null && !row.s3Key.startsWith(`exports/${userId}/`))
      );
    })
  ) {
    // A pre-durable running export has no cooperative lease to quiesce.
    // Unknown historical keys likewise cannot be deleted by account prefix.
    return unresolved("ownership_unknown");
  }
  const items = await Promise.all(
    rows.map(async (row) => {
      const resultKey = `exports/${userId}/${row.id}.zip`;
      return {
        sinkId: lease.item.sinkId,
        itemKey: ref(["export-object", row.id]),
        kind: "erase" as const,
        selector: await encryptErasureSelector({
          version: 1,
          kind: "export_object",
          storageRef: storageRef(name),
          subjectId: userId,
          jobId: row.id,
          resultKey,
          stagingPrefix: `exports/${userId}/${row.id}/staging/`,
          ...(row.s3Key && row.s3Key !== resultKey
            ? { legacyKey: row.s3Key }
            : {}),
        }),
        dependencies: [],
      };
    }),
  );
  const last = rows.at(-1);
  const complete = rows.length < PAGE_SIZE;
  return {
    pageKey: ref([
      "export-page",
      lease.jobId,
      lease.captureRevision,
      after ?? null,
    ]),
    inputCursorDigest: lease.item.cursorDigest,
    nextCursor:
      complete || !last
        ? null
        : await encryptErasureSelector({
            version: 1,
            kind: "cursor",
            after: JSON.stringify([last.ordinal, last.id]),
          }),
    enumerationRef: complete
      ? ref([
          "export-enumeration",
          userId,
          EXPORT_OBJECT_ERASURE_COLLECTOR_VERSION,
        ])
      : null,
    items,
  };
}

async function erase(
  db: Db,
  lease: ErasureLease,
  signal: AbortSignal,
): Promise<{ readonly requestRef: string } | ErasureUnresolved> {
  const target = await exportOf(lease);
  if (!target) {
    return unresolved("selector_missing");
  }
  const store = createStore();
  await renewErasureLease(db, lease);
  const [durable] = await db
    .select({ id: backgroundJobs.id })
    .from(backgroundJobs)
    .where(
      and(
        eq(backgroundJobs.id, target.jobId),
        eq(backgroundJobs.kind, "user-export"),
        eq(backgroundJobs.userId, target.subjectId),
      ),
    );
  if (durable) {
    await store.set(cleanupDurableUserExports$, { jobId: durable.id }, signal);
    const [remaining] = await db
      .select({ id: backgroundJobs.id })
      .from(backgroundJobs)
      .where(eq(backgroundJobs.id, durable.id));
    if (remaining) {
      return {
        outcome: "pending",
        errorCode: "boundary_unproven",
        requestRef: null,
        retryAt: new Date(nowDate().getTime() + RETRY_MS),
      };
    }
  }
  await renewErasureLease(db, lease);
  await store.get(
    deleteS3Objects(
      target.bucket,
      [target.resultKey, ...(target.legacyKey ? [target.legacyKey] : [])],
      signal,
    ),
  );
  signal.throwIfAborted();
  const staged = await store.get(
    listUserExportStagingPage(target.bucket, target.stagingPrefix, signal),
  );
  await store.get(deleteS3Objects(target.bucket, staged.keys, signal));
  signal.throwIfAborted();
  if (staged.isTruncated) {
    return {
      outcome: "pending",
      errorCode: "boundary_unproven",
      requestRef: null,
      retryAt: new Date(nowDate().getTime() + RETRY_MS),
    };
  }
  return {
    requestRef: ref(["export-delete", lease.jobId, lease.item.itemKey]),
  };
}

async function verify(
  db: Db,
  lease: ErasureLease,
  boundary: string,
  signal: AbortSignal,
): Promise<ErasureProof | ErasureUnresolved> {
  const target = await exportOf(lease);
  if (!target) {
    const subject = await subjectOf(lease);
    if (!subject) {
      return unresolved("selector_missing");
    }
  } else {
    const [remaining] = await db
      .select({ id: backgroundJobs.id })
      .from(backgroundJobs)
      .where(eq(backgroundJobs.id, target.jobId));
    if (remaining) {
      return unresolved("boundary_unproven", "pending");
    }
    const store = createStore();
    const keys = [
      target.resultKey,
      ...(target.legacyKey ? [target.legacyKey] : []),
    ];
    for (const key of keys) {
      signal.throwIfAborted();
      if (await store.get(s3ObjectExists(target.bucket, key))) {
        return unresolved("verification_failed", "retryable_failure");
      }
    }
    const staged = await store.get(
      listUserExportStagingPage(target.bucket, target.stagingPrefix, signal),
    );
    const uploads = await store.get(
      listMultipartS3UploadsPage(target.bucket, target.resultKey, signal),
    );
    signal.throwIfAborted();
    if (
      staged.keys.length > 0 ||
      staged.isTruncated ||
      uploads.isTruncated ||
      uploads.uploads.some((upload) => {
        return upload.key === target.resultKey;
      })
    ) {
      return unresolved("verification_failed", "retryable_failure");
    }
  }
  const name = bucket();
  if (!name) {
    return unresolved("permission_missing");
  }
  return {
    workId: lease.workId,
    sinkId: lease.item.sinkId,
    generation: lease.generation,
    captureRevision: lease.captureRevision,
    inventoryRevision: lease.inventoryRevision,
    producerBoundaryRef: boundary,
    outcome: target ? "verified_erased" : "verified_no_applicable_data",
    evidenceRef: ref(["export-absence", lease.jobId, lease.item.itemKey]),
    authenticatedReaderRef: ref(["export-reader", storageRef(name)]),
    enumerationRef: ref(["export-item-enumeration", lease.item.itemKey]),
    observedAt: nowDate(),
  };
}

export function createExportObjectErasureCollector(db: Db): ErasureHandler {
  return {
    version: EXPORT_OBJECT_ERASURE_COLLECTOR_VERSION,
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
