import { createStore } from "ccstate";
import { and, asc, eq, gt } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { v5 as uuidv5 } from "uuid";
import { z } from "zod";

import {
  hostedDeployments,
  privateHostedDeployments,
} from "@okouai/db/schema/hosted-site";
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
import { nowDate } from "../../lib/time";
import { safeJsonParse } from "../utils";
import {
  deleteArtifactSnapshotObjects,
  listHostedSitesObjectsUnderPrefix,
} from "../external/s3";
import {
  decryptErasureSelector,
  encryptErasureSelector,
} from "./account-erasure-selector";

type Db = NodePgDatabase<Record<string, never>>;

/** The deployment tables this sink erases bytes for.
 *
 * Both are `user_root` in `ACCOUNT_OWNERSHIP_INVENTORY` and both are keyed by
 * `user_id`, so this sink reads a row by exactly the predicate the relational
 * sweep deletes it by. That equality is the whole point: a row the sweep will
 * delete is a row whose prefix this sink has already captured.
 *
 * `private_hosted_deployments` exists as separate rows so that an older API
 * binary cannot publish a private deployment. For erasure the two are the same
 * resource, so they are one ordered enumeration rather than two sinks.
 */
const DEPLOYMENT_SOURCES = [
  { ordinal: 0, table: hostedDeployments, relation: "hosted_deployments" },
  {
    ordinal: 1,
    table: privateHostedDeployments,
    relation: "private_hosted_deployments",
  },
] as const;

const MAX_INVENTORY_PAGE = 100;

// Immutable v1 namespace. Names are JSON tuples, never concatenation, so two
// different reference inputs cannot collide on one string.
const HOSTED_SITE_NAMESPACE = "9a1c7f36-58d2-4ee0-9b47-0f6a2d5c8e14";

/** The sink's collector version. `executeErasureWork` refuses to run a handler
 * whose version does not equal the registered sink's `collectorVersion`, so
 * this changes whenever the sweep's observable behaviour changes.
 */
export const HOSTED_SITE_ERASURE_COLLECTOR_VERSION =
  "5c2e84b1-70df-4a93-8c16-3b9d0e57af22";

function reference(parts: readonly unknown[]): string {
  return uuidv5(JSON.stringify(parts), HOSTED_SITE_NAMESPACE);
}

const unresolved = (
  errorCode: NonNullable<ErasureUnresolved["errorCode"]>,
  outcome: ErasureUnresolved["outcome"] = "capability_unresolved",
): ErasureUnresolved => {
  return { outcome, errorCode, requestRef: null };
};

/** The bucket, or the reason this deployment cannot erase bytes at all.
 *
 * An unconfigured bucket is a capability this deployment does not have. It is
 * reported as an unresolved capability rather than treated as "no objects", so
 * the job records an explicit residual instead of counting the account clean.
 */
function hostedSitesBucket(): string | undefined {
  return env("R2_HOSTED_SITES_BUCKET_NAME");
}

/** One durable name for the hosted-sites bucket.
 *
 * The selector vocabulary keys a storage by uuid rather than by bucket name so
 * a captured locator does not carry deployment configuration, and so renaming
 * a bucket does not silently repoint a captured selector at a different one.
 */
function storageReference(): string {
  return reference(["hosted-sites-storage", 1]);
}

const cursorSchema = z
  .tuple([z.number().int().min(0).max(1), z.uuid()])
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

interface DeploymentRow {
  readonly ordinal: number;
  readonly relation: string;
  readonly id: string;
  readonly r2Prefix: string;
}

/** One bounded, ordered page of the subject's deployment prefixes.
 *
 * Ordered by `(source ordinal, id)` and resumed strictly after the last row of
 * the previous page, so the enumeration is a total order over both tables and
 * a resumed page cannot repeat or skip a row. The read is indexed on the
 * `user_id` predicate each table already carries.
 */
async function readDeploymentPage(
  db: Db,
  subjectId: string,
  cursor: { readonly ordinal: number; readonly id: string } | undefined,
): Promise<DeploymentRow[]> {
  const rows: DeploymentRow[] = [];
  for (const source of DEPLOYMENT_SOURCES) {
    if (rows.length >= MAX_INVENTORY_PAGE) {
      break;
    }
    if (cursor && source.ordinal < cursor.ordinal) {
      continue;
    }
    const after =
      cursor && cursor.ordinal === source.ordinal
        ? gt(source.table.id, cursor.id)
        : undefined;
    const page = await db
      .select({ id: source.table.id, r2Prefix: source.table.r2Prefix })
      .from(source.table)
      .where(and(eq(source.table.userId, subjectId), after))
      .orderBy(asc(source.table.id))
      .limit(MAX_INVENTORY_PAGE - rows.length);
    for (const row of page) {
      rows.push({
        ordinal: source.ordinal,
        relation: source.relation,
        id: row.id,
        r2Prefix: row.r2Prefix,
      });
    }
  }
  return rows;
}

/** Every prefix this sink would capture for a subject, in enumeration order.
 *
 * Exposed so a caller can state what the capture covers without driving the
 * job. It reads the same rows by the same predicate the paged inventory does.
 */
export async function hostedSiteErasurePrefixes(
  db: Db,
  subject: ErasureSubject,
): Promise<{ readonly relation: string; readonly prefix: string }[]> {
  const prefixes: { relation: string; prefix: string }[] = [];
  let cursor: { readonly ordinal: number; readonly id: string } | undefined;
  for (;;) {
    const page = await readDeploymentPage(db, subject.subjectId, cursor);
    const last = page[page.length - 1];
    if (!last) {
      return prefixes;
    }
    for (const row of page) {
      prefixes.push({ relation: row.relation, prefix: row.r2Prefix });
    }
    cursor = { ordinal: last.ordinal, id: last.id };
  }
}

function enumerationReference(subject: ErasureSubject): string {
  return reference([
    "hosted-site-enumeration",
    HOSTED_SITE_ERASURE_COLLECTOR_VERSION,
    subject.subjectKind,
    subject.subjectId,
    DEPLOYMENT_SOURCES.map((source) => {
      return source.relation;
    }),
  ]);
}

function requestReference(
  lease: ErasureLease,
  outcome: "erased" | "empty",
): string {
  return reference([
    "hosted-site-erase",
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
  if (!subject) {
    return unresolved("selector_missing");
  }
  if (hostedSitesBucket() === undefined) {
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
  const rows = await readDeploymentPage(db, subject.subjectId, resume);
  const last = rows[rows.length - 1];
  const storageRef = storageReference();
  const items = await Promise.all(
    rows.map(async (row) => {
      return {
        sinkId: lease.item.sinkId,
        // Keyed by the row, not by the prefix: two rows must never collapse
        // into one work item even if they were published to the same prefix.
        itemKey: reference(["hosted-site-item", row.relation, row.id]),
        kind: "erase" as const,
        selector: await encryptErasureSelector({
          version: 1,
          kind: "object_prefix",
          storageRef,
          prefix: row.r2Prefix,
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
      "hosted-site-page",
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

/** Deletes every object under one captured deployment prefix.
 *
 * The prefix comes from the captured selector rather than from a row read now.
 * By the time this runs the relational sweep may already have deleted the
 * deployment row, and that is exactly the case this sink exists for: bytes
 * must not outlive the catalog row that named them.
 */
async function erasePrefix(
  lease: ErasureLease,
  signal: AbortSignal,
): Promise<{ readonly requestRef: string } | ErasureUnresolved> {
  const prefix = await leasePrefix(lease);
  if (prefix === undefined) {
    return unresolved("selector_missing");
  }
  const bucket = hostedSitesBucket();
  if (bucket === undefined) {
    return unresolved("permission_missing");
  }
  const store = createStore();
  const objects = await store.get(
    listHostedSitesObjectsUnderPrefix(bucket, prefix),
  );
  if (objects.length === 0) {
    return { requestRef: requestReference(lease, "empty") };
  }
  // Batching belongs to `deleteArtifactSnapshotObjects`, which already caps a
  // request at `S3_DELETE_OBJECTS_LIMIT` and stops at the first failed batch.
  await store.get(
    deleteArtifactSnapshotObjects(
      bucket,
      objects.map((object) => {
        return object.key;
      }),
      true,
      signal,
    ),
  );
  return { requestRef: requestReference(lease, "erased") };
}

/** The prefixes one lease is answerable for.
 *
 * An erase item owns the single prefix its selector captured. The collector's
 * own item is keyed by the subject, and `executeErasureWork` sends it straight
 * to verification once its capture is complete, so it is answerable for every
 * prefix still readable for that subject. After the relational sweep that set
 * is empty, and the per-prefix proofs carry the evidence; before it, a
 * surviving deployment whose bytes are still there fails here rather than
 * passing on the strength of the items alone.
 */
async function verifiablePrefixes(
  db: Db,
  lease: ErasureLease,
): Promise<readonly string[] | undefined> {
  const prefix = await leasePrefix(lease);
  if (prefix !== undefined) {
    return [prefix];
  }
  const subject = await leaseSubject(lease);
  if (!subject) {
    return undefined;
  }
  const rows = await hostedSiteErasurePrefixes(db, subject);
  return rows.map((row) => {
    return row.prefix;
  });
}

/** Absence, read back from the provider rather than inferred from the delete.
 *
 * A row count proves nothing here: the catalog row may already be gone. What
 * this asserts is that listing the captured prefix returns no object, which is
 * also what revokes serving, because the hosted origin resolves a request by
 * reading an object under that prefix.
 */
async function verifyPrefixAbsent(
  db: Db,
  lease: ErasureLease,
  producerBoundary: string,
): Promise<ErasureProof | ErasureUnresolved> {
  const prefixes = await verifiablePrefixes(db, lease);
  if (prefixes === undefined) {
    return unresolved("selector_missing");
  }
  const bucket = hostedSitesBucket();
  if (bucket === undefined) {
    return unresolved("permission_missing");
  }
  const store = createStore();
  for (const prefix of prefixes) {
    const remaining = await store.get(
      listHostedSitesObjectsUnderPrefix(bucket, prefix),
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
      "hosted-site-absence",
      lease.jobId,
      lease.item.itemKey,
      lease.captureRevision,
    ]),
    authenticatedReaderRef: reference([
      "hosted-site-reader",
      HOSTED_SITE_ERASURE_COLLECTOR_VERSION,
      storageReference(),
    ]),
    enumerationRef: reference([
      "hosted-site-item-enumeration",
      HOSTED_SITE_ERASURE_COLLECTOR_VERSION,
      lease.item.itemKey,
    ]),
    observedAt: nowDate(),
  };
}

/** The hosted-site object sink.
 *
 * Same shape as `createRelationalErasureCollector`, different resource: the
 * inventory phase captures every deployment prefix the subject owns, and only
 * after `sealErasureCapture` does any erase run. That ordering is the
 * contract's, not this sink's — `claimErasureWork` refuses the verification
 * phase while the capture is unsealed and the inventory phase once it is
 * sealed — and it is what guarantees a locator is durably captured before the
 * catalog row that held it can disappear.
 */
export function createHostedSiteErasureCollector(db: Db): ErasureHandler {
  return {
    version: HOSTED_SITE_ERASURE_COLLECTOR_VERSION,
    inventory: async (lease, cursor) => {
      return await inventoryPage(db, lease, cursor);
    },
    erase: async (lease, signal) => {
      return await erasePrefix(lease, signal);
    },
    verify: async (lease, producerBoundary) => {
      return await verifyPrefixAbsent(db, lease, producerBoundary);
    },
  };
}
