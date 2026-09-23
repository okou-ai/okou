import { createStore } from "ccstate";
import { and, asc, eq, gt } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { v5 as uuidv5 } from "uuid";
import { z } from "zod";

import {
  hostedDeployments,
  privateHostedDeployments,
} from "@okouai/db/schema/hosted-site";
import {
  renewErasureLease,
  type EncryptedErasureSelector,
  type ErasureHandler,
  type ErasureInventoryPage,
  type ErasureLease,
  type ErasureProof,
  type ErasureSubject,
  type ErasureUnresolved,
} from "@okouai/db/operations/account-erasure";

import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { safeJsonParse } from "../utils";
import {
  deleteArtifactSnapshotObjects,
  listHostedSitesObjectsPage,
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
const OBJECT_DELETE_PAGE_SIZE = 1000;
const MAX_OBJECT_DELETE_PAGES_PER_LEASE = 10;

// Immutable v1 namespace. Names are JSON tuples, never concatenation, so two
// different reference inputs cannot collide on one string.
const HOSTED_SITE_NAMESPACE = "9a1c7f36-58d2-4ee0-9b47-0f6a2d5c8e14";

/** The sink's collector version. `executeErasureWork` refuses to run a handler
 * whose version does not equal the registered sink's `collectorVersion`, so
 * this changes whenever the sweep's observable behaviour changes.
 */
export const HOSTED_SITE_ERASURE_COLLECTOR_VERSION =
  "c7ba982a-3865-4830-8367-f97d72ba820e";

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

/** Bind the selector to the bucket, account and endpoint without exposing
 * them in plaintext. A later storage configuration switch fails closed.
 */
function storageReference(bucket: string): string {
  return reference([
    "hosted-sites-storage",
    3,
    bucket,
    env("R2_ACCOUNT_ID"),
    env("S3_ENDPOINT") ?? null,
  ]);
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
async function leasePrefix(
  lease: ErasureLease,
  bucket: string,
): Promise<string | undefined> {
  if (!lease.item.selectorCiphertext || !lease.item.selectorDigest) {
    return undefined;
  }
  const selector = await decryptErasureSelector({
    ciphertext: lease.item.selectorCiphertext,
    digest: lease.item.selectorDigest,
  });
  return selector.kind === "object_prefix" &&
    selector.storageRef === storageReference(bucket)
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

/** The first bounded page of prefixes this sink would capture for a subject.
 *
 * One page, not the whole account. A caller that wants every prefix wants the
 * job's captured items, which is what the erase items are; this reads the same
 * rows by the same predicate so a caller can state what a capture starts from
 * without driving the job, and so verification owes a bounded number of
 * provider round trips.
 */
export async function hostedSiteErasurePrefixPage(
  db: Db,
  subject: ErasureSubject,
): Promise<{ readonly relation: string; readonly prefix: string }[]> {
  const page = await readDeploymentPage(db, subject.subjectId, undefined);
  return page.map((row) => {
    return { relation: row.relation, prefix: row.r2Prefix };
  });
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
  const bucket = hostedSitesBucket();
  if (bucket === undefined) {
    return unresolved("permission_missing");
  }
  await renewErasureLease(db, lease);
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
  const storageRef = storageReference(bucket);
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
  const bucket = hostedSitesBucket();
  if (bucket === undefined) {
    return unresolved("permission_missing");
  }
  const prefix = await leasePrefix(lease, bucket);
  if (prefix === undefined) {
    return unresolved("selector_missing");
  }
  const store = createStore();
  for (
    let pageNumber = 0;
    pageNumber < MAX_OBJECT_DELETE_PAGES_PER_LEASE;
    pageNumber += 1
  ) {
    signal.throwIfAborted();
    const page = await store.get(
      listHostedSitesObjectsPage(bucket, prefix, OBJECT_DELETE_PAGE_SIZE),
    );
    if (page.objects.length === 0) {
      return {
        requestRef:
          lease.item.requestRef === requestReference(lease, "erased")
            ? requestReference(lease, "erased")
            : requestReference(lease, "empty"),
      };
    }
    await store.get(
      deleteArtifactSnapshotObjects(
        bucket,
        page.objects.map((object) => {
          return object.key;
        }),
        true,
        signal,
      ),
    );
    if (!page.isTruncated) {
      return { requestRef: requestReference(lease, "erased") };
    }
  }
  return {
    outcome: "pending",
    errorCode: "boundary_unproven",
    requestRef: requestReference(lease, "erased"),
    retryAt: new Date(nowDate().getTime() + 60_000),
  };
}

/** Absence, read back from the provider rather than inferred from the delete.
 *
 * A row count proves nothing here: the catalog row may already be gone. What
 * this asserts is that listing the captured prefix returns no object, which is
 * what stops the hosted origin serving a request, because it resolves one by
 * reading an object under that prefix. Retiring the publication itself is the
 * relational sweep deleting `hosted_sites`; this sink owns the bytes.
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
  const bucket = hostedSitesBucket();
  if (bucket === undefined) {
    return unresolved("permission_missing");
  }
  const prefix = await leasePrefix(lease, bucket);
  if (prefix === undefined) {
    // The collector's own item. Its selector must still be this sink's
    // subject, or the lease does not belong here.
    const subject = await leaseSubject(lease);
    if (!subject) {
      return unresolved("selector_missing");
    }
  } else {
    const remaining = await createStore().get(
      listHostedSitesObjectsPage(bucket, prefix, 1),
    );
    if (remaining.objects.length > 0 || remaining.isTruncated) {
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
      storageReference(bucket),
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
      return await verifyPrefixAbsent(lease, producerBoundary);
    },
  };
}
