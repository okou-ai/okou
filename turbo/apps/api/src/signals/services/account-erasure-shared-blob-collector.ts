import { createStore } from "ccstate";
import { and, asc, eq, gt, or } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { v5 as uuidv5 } from "uuid";
import { z } from "zod";

import { agentRuns } from "@okouai/db/runtime/agent-run";
import { blobs } from "@okouai/db/schema/blob";
import { conversations } from "@okouai/db/schema/conversation";
import { piMemoryStage1Candidates } from "@okouai/db/schema/pi-memory-stage1-candidate";
import {
  renewErasureLease,
  type EncryptedErasureSelector,
  type ErasureHandler,
  type ErasureInventoryPage,
  type ErasureLease,
  type ErasureProof,
  type ErasureUnresolved,
} from "@okouai/db/operations/account-erasure";

import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { s3ObjectExists } from "../external/s3";
import { safeJsonParse } from "../utils";
import {
  decryptErasureSelector,
  encryptErasureSelector,
} from "./account-erasure-selector";
import { eraseUnreferencedSharedBlob } from "./shared-blob-erasure.service";
import {
  resumeSessionHistoryBlobKey,
  SESSION_HISTORY_ENCODING_GZIP,
  SESSION_HISTORY_ENCODING_IDENTITY,
  SESSION_HISTORY_ENCODING_ZSTD,
} from "./session-history-blobs";

type Db = NodePgDatabase<Record<string, never>>;
type Cursor = readonly [0, string] | readonly [1, string, string];
interface HashRow {
  readonly cursor: Cursor;
  readonly hash: string | null;
}

const PAGE_SIZE = 100;
const NAMESPACE = "c802e32d-b6c7-43df-9f7d-824928cde17f";
export const SHARED_BLOB_ERASURE_COLLECTOR_VERSION =
  "f75fb64a-aeea-4d87-99f9-777906681095";
const cursorSchema = z.union([
  z.tuple([z.literal(0), z.uuid()]),
  z.tuple([z.literal(1), z.uuid(), z.string().min(1).max(255)]),
]);
const encodings = [
  SESSION_HISTORY_ENCODING_IDENTITY,
  SESSION_HISTORY_ENCODING_GZIP,
  SESSION_HISTORY_ENCODING_ZSTD,
] as const;

function reference(parts: readonly unknown[]): string {
  return uuidv5(JSON.stringify(parts), NAMESPACE);
}

function unresolved(
  errorCode: NonNullable<ErasureUnresolved["errorCode"]>,
  outcome: ErasureUnresolved["outcome"] = "capability_unresolved",
): ErasureUnresolved {
  return { outcome, errorCode, requestRef: null };
}

async function subjectId(lease: ErasureLease): Promise<string | undefined> {
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

async function selectedBlob(
  lease: ErasureLease,
): Promise<{ readonly subjectId: string; readonly hash: string } | undefined> {
  if (!lease.item.selectorCiphertext || !lease.item.selectorDigest) {
    return undefined;
  }
  const selector = await decryptErasureSelector({
    ciphertext: lease.item.selectorCiphertext,
    digest: lease.item.selectorDigest,
  });
  return selector.kind === "shared_blob"
    ? { subjectId: selector.subjectId, hash: selector.hash }
    : undefined;
}

/** A shared retain is safe only after this subject's own source rows have
 * committed their ref-count release. */
async function ownerReferencesRemain(
  db: Db,
  userId: string,
  hash: string,
): Promise<boolean> {
  const [run] = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .innerJoin(conversations, eq(conversations.runId, agentRuns.id))
    .where(
      and(
        eq(agentRuns.userId, userId),
        eq(conversations.cliAgentSessionHistoryHash, hash),
      ),
    )
    .limit(1);
  if (run) {
    return true;
  }
  const [candidate] = await db
    .select({ id: piMemoryStage1Candidates.memoryStorageId })
    .from(piMemoryStage1Candidates)
    .where(
      and(
        eq(piMemoryStage1Candidates.userId, userId),
        eq(piMemoryStage1Candidates.sourceHistoryHash, hash),
      ),
    )
    .limit(1);
  return candidate !== undefined;
}

async function readPage(
  db: Db,
  userId: string,
  after?: Cursor,
): Promise<HashRow[]> {
  const rows: HashRow[] = [];
  if (!after || after[0] === 0) {
    const runs = await db
      .select({
        id: agentRuns.id,
        hash: conversations.cliAgentSessionHistoryHash,
      })
      .from(agentRuns)
      .leftJoin(conversations, eq(conversations.runId, agentRuns.id))
      .where(
        and(
          eq(agentRuns.userId, userId),
          after ? gt(agentRuns.id, after[1]) : undefined,
        ),
      )
      .orderBy(asc(agentRuns.id))
      .limit(PAGE_SIZE);
    for (const row of runs) {
      rows.push({ cursor: [0, row.id], hash: row.hash });
    }
  }
  if (rows.length < PAGE_SIZE) {
    const candidates = await db
      .select({
        storageId: piMemoryStage1Candidates.memoryStorageId,
        sessionId: piMemoryStage1Candidates.piSessionId,
        hash: piMemoryStage1Candidates.sourceHistoryHash,
      })
      .from(piMemoryStage1Candidates)
      .where(
        and(
          eq(piMemoryStage1Candidates.userId, userId),
          after?.[0] === 1
            ? or(
                gt(piMemoryStage1Candidates.memoryStorageId, after[1]),
                and(
                  eq(piMemoryStage1Candidates.memoryStorageId, after[1]),
                  gt(piMemoryStage1Candidates.piSessionId, after[2]),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(
        asc(piMemoryStage1Candidates.memoryStorageId),
        asc(piMemoryStage1Candidates.piSessionId),
      )
      .limit(PAGE_SIZE - rows.length);
    for (const row of candidates) {
      rows.push({ cursor: [1, row.storageId, row.sessionId], hash: row.hash });
    }
  }
  return rows;
}

async function inventoryPage(
  db: Db,
  lease: ErasureLease,
  cursor: EncryptedErasureSelector | null,
): Promise<ErasureInventoryPage | ErasureUnresolved> {
  const userId = await subjectId(lease);
  if (!userId) {
    return unresolved("selector_missing");
  }
  await renewErasureLease(db, lease);
  let after: Cursor | undefined;
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
  const hashes = [
    ...new Set(
      rows
        .map((row) => {
          return row.hash;
        })
        .filter((hash): hash is string => {
          return hash !== null;
        }),
    ),
  ];
  const items = await Promise.all(
    hashes.map(async (hash) => {
      return {
        sinkId: lease.item.sinkId,
        itemKey: reference(["shared-blob-item", userId, hash]),
        kind: "erase" as const,
        selector: await encryptErasureSelector({
          version: 1,
          kind: "shared_blob",
          subjectId: userId,
          hash,
        }),
        dependencies: [],
      };
    }),
  );
  const last = rows.at(-1);
  const complete = rows.length < PAGE_SIZE;
  return {
    pageKey: reference([
      "shared-blob-page",
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
            after: JSON.stringify(last.cursor),
          }),
    enumerationRef: complete
      ? reference([
          "shared-blob-enumeration",
          SHARED_BLOB_ERASURE_COLLECTOR_VERSION,
          userId,
        ])
      : null,
    items,
  };
}

async function verifyHash(
  db: Db,
  lease: ErasureLease,
  producerBoundary: string,
): Promise<ErasureProof | ErasureUnresolved> {
  const selected = await selectedBlob(lease);
  const hash = selected?.hash;
  let blob: { refCount: number } | undefined;
  if (hash) {
    if (await ownerReferencesRemain(db, selected.subjectId, hash)) {
      return unresolved("boundary_unproven", "pending");
    }
    [blob] = await db
      .select({ refCount: blobs.refCount })
      .from(blobs)
      .where(eq(blobs.hash, hash))
      .limit(1);
    if (blob && blob.refCount === 0) {
      return unresolved("verification_failed", "pending");
    }
    if (!blob) {
      const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
      if (!bucket) {
        return unresolved("permission_missing");
      }
      const store = createStore();
      const found = await Promise.all(
        encodings.map(async (encoding) => {
          return await store.get(
            s3ObjectExists(bucket, resumeSessionHistoryBlobKey(hash, encoding)),
          );
        }),
      );
      if (found.includes(true)) {
        return unresolved("verification_failed", "retryable_failure");
      }
    }
  } else if (!(await subjectId(lease))) {
    return unresolved("selector_missing");
  }
  return {
    workId: lease.workId,
    sinkId: lease.item.sinkId,
    generation: lease.generation,
    captureRevision: lease.captureRevision,
    inventoryRevision: lease.inventoryRevision,
    producerBoundaryRef: producerBoundary,
    outcome: !hash || blob ? "verified_no_applicable_data" : "verified_erased",
    evidenceRef: reference([
      "shared-blob-proof",
      lease.jobId,
      lease.item.itemKey,
      lease.captureRevision,
    ]),
    authenticatedReaderRef: reference([
      "shared-blob-reader",
      SHARED_BLOB_ERASURE_COLLECTOR_VERSION,
    ]),
    enumerationRef: reference([
      "shared-blob-item-enumeration",
      lease.item.itemKey,
    ]),
    observedAt: nowDate(),
  };
}

/** Capture each account-owned retain before the relational sweep drops the
 * source row. The physical erase later follows the committed ref-count release;
 * a survivor's reference preserves the shared bytes.
 */
export function createSharedBlobErasureCollector(db: Db): ErasureHandler {
  return {
    version: SHARED_BLOB_ERASURE_COLLECTOR_VERSION,
    inventory: async (lease, cursor) => {
      return await inventoryPage(db, lease, cursor);
    },
    erase: async (lease, signal) => {
      const selected = await selectedBlob(lease);
      if (!selected) {
        return unresolved("selector_missing");
      }
      if (await ownerReferencesRemain(db, selected.subjectId, selected.hash)) {
        return unresolved("boundary_unproven", "pending");
      }
      const result = await eraseUnreferencedSharedBlob(
        db,
        selected.hash,
        signal,
      );
      if (result.outcome === "pending") {
        return {
          ...unresolved(
            result.reason === "metadata_missing"
              ? "ownership_unknown"
              : "verification_failed",
            result.reason === "metadata_missing"
              ? "capability_unresolved"
              : "pending",
          ),
          retryAt: result.retryAt,
        };
      }
      return {
        requestRef: reference([
          "shared-blob-erase",
          lease.jobId,
          lease.item.itemKey,
          lease.captureRevision,
          result.outcome,
        ]),
      };
    },
    verify: async (lease, producerBoundary) => {
      return await verifyHash(db, lease, producerBoundary);
    },
  };
}
