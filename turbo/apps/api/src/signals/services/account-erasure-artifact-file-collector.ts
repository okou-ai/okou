import { createStore } from "ccstate";
import { and, asc, eq, gt } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { v5 as uuidv5 } from "uuid";
import { z } from "zod";

import { runUploadedFiles } from "@okouai/db/schema/run-uploaded-file";
import {
  artifactDeliveryKey,
  artifactDeliveryRecordSchema,
} from "@okouai/api-contracts/contracts/artifact-delivery";
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
import {
  buildFileUrlFromKey,
  OKOU_CDN_ARTIFACTS_ORIGIN,
  OKOU_SHORT_ARTIFACTS_ORIGIN,
  publicArtifactsBaseUrlForBrand,
} from "../../lib/file-url";
import { nowDate } from "../../lib/time";
import {
  safeJsonParse,
  safeUriComponentDecode,
  safeUrlParse,
  settle,
} from "../utils";
import {
  deleteArtifactSnapshotObjects,
  deleteS3Objects,
  hostedSitesObjectExists,
  isS3NotFoundError,
  readArtifactSharePolicyObject,
  s3ObjectExists,
} from "../external/s3";
import {
  decryptErasureSelector,
  encryptErasureSelector,
} from "./account-erasure-selector";
import {
  publicArtifactKeyFromUrl,
  resolveOwnedPublicArtifactKey$,
} from "./artifact-storage.service";

type Db = NodePgDatabase<Record<string, never>>;
type FileRow = Pick<
  typeof runUploadedFiles.$inferSelect,
  "id" | "userId" | "storageKey" | "url" | "previewImageUrl" | "metadata"
>;
interface ObjectLocator {
  readonly bucket: string;
  readonly key: string;
}

const PAGE_SIZE = 20;
const NAMESPACE = "e413c361-9811-490e-a21d-f48689204f0c";
export const ARTIFACT_FILE_ERASURE_COLLECTOR_VERSION =
  "4c292141-c9fd-40c7-9673-82826c13d37b";

function reference(parts: readonly unknown[]): string {
  return uuidv5(JSON.stringify(parts), NAMESPACE);
}

function storageReference(bucket: string): string {
  // A storage configuration change cannot turn a different location's empty
  // listing into proof that captured bytes disappeared.
  return reference([
    "artifact-object-bucket",
    2,
    bucket,
    env("R2_ACCOUNT_ID"),
    env("S3_ENDPOINT") ?? null,
  ]);
}

const unresolved = (
  errorCode: NonNullable<ErasureUnresolved["errorCode"]>,
  outcome: ErasureUnresolved["outcome"] = "capability_unresolved",
): ErasureUnresolved => {
  return { outcome, errorCode, requestRef: null };
};

async function leaseSubject(lease: ErasureLease): Promise<string | undefined> {
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

async function leaseObjects(
  lease: ErasureLease,
): Promise<
  { readonly bucket: string; readonly keys: readonly string[] } | undefined
> {
  if (!lease.item.selectorCiphertext || !lease.item.selectorDigest) {
    return undefined;
  }
  const selector = await decryptErasureSelector({
    ciphertext: lease.item.selectorCiphertext,
    digest: lease.item.selectorDigest,
  });
  if (selector.kind !== "object_batch") {
    return undefined;
  }
  const buckets = [
    env("R2_USER_ARTIFACTS_BUCKET_NAME"),
    env("R2_PRIVATE_ARTIFACTS_BUCKET_NAME"),
    env("R2_HOSTED_SITES_BUCKET_NAME"),
  ];
  const bucket = buckets.find((candidate) => {
    return candidate && selector.storageRef === storageReference(candidate);
  });
  return bucket ? { bucket, keys: selector.keys } : undefined;
}

function firstPartyPublicUrl(value: string): boolean {
  const url = safeUrlParse(value);
  if (!url) {
    return false;
  }
  return [
    OKOU_SHORT_ARTIFACTS_ORIGIN,
    OKOU_CDN_ARTIFACTS_ORIGIN,
    new URL(publicArtifactsBaseUrlForBrand("vm0")).origin,
    new URL(publicArtifactsBaseUrlForBrand("okou")).origin,
  ].includes(url.origin);
}

function legacyFileKeyFromRegistryKey(registryKey: string): string | undefined {
  const prefix = "artifact-delivery/files/";
  if (!registryKey.startsWith(prefix) || !registryKey.endsWith(".json")) {
    return undefined;
  }
  const encodedAlias = registryKey.slice(prefix.length, -".json".length);
  const alias = safeUriComponentDecode(encodedAlias);
  if (alias === undefined) {
    return undefined;
  }
  return artifactDeliveryKey(null, "file", alias) === registryKey
    ? `artifacts/${alias}`
    : undefined;
}

async function registryIsOwned(
  bucket: string,
  key: string,
  signal: AbortSignal,
): Promise<boolean> {
  const expectedKey = legacyFileKeyFromRegistryKey(key);
  if (!expectedKey) {
    return false;
  }
  const result = await settle(
    createStore().get(readArtifactSharePolicyObject(bucket, key, signal)),
    signal,
  );
  if (!result.ok) {
    if (isS3NotFoundError(result.error)) {
      return !(await createStore().get(hostedSitesObjectExists(bucket, key)));
    }
    throw result.error;
  }
  const record = artifactDeliveryRecordSchema.safeParse(
    safeJsonParse(result.value.buffer.toString("utf8")),
  );
  return (
    record.success &&
    record.data.kind === "legacy-file" &&
    record.data.key === expectedKey
  );
}

async function publicUrlLocator(
  value: string | null,
  userId: string,
  bucket: string,
  signal: AbortSignal,
): Promise<ObjectLocator | ErasureUnresolved | undefined> {
  if (!value || !firstPartyPublicUrl(value)) {
    return undefined;
  }
  const candidate = publicArtifactKeyFromUrl(value);
  if (!candidate) {
    return unresolved("ownership_unknown");
  }
  const store = createStore();
  const owned = await store.set(
    resolveOwnedPublicArtifactKey$,
    { userId, url: value },
    signal,
  );
  if (
    owned !== candidate &&
    (await store.get(s3ObjectExists(bucket, candidate)))
  ) {
    return unresolved("ownership_unknown");
  }
  return { bucket, key: candidate };
}

/** A row may precede canonical storage_key. Resolve old public URLs using the
 * same ownership check as provider input: legacy paths carry the user id;
 * compact v2 keys require the object's owner metadata. External URLs own no
 * Okou object, while an unresolvable first-party URL is an explicit residual.
 */
async function rowLocators(
  row: FileRow,
  signal: AbortSignal,
): Promise<readonly ObjectLocator[] | ErasureUnresolved> {
  const publicBucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");
  const privateBucket = env("R2_PRIVATE_ARTIFACTS_BUCKET_NAME");
  const store = createStore();
  const locations: ObjectLocator[] = [];
  if (row.storageKey?.startsWith("private-artifacts/")) {
    if (!privateBucket || privateBucket === publicBucket) {
      return unresolved("permission_missing");
    }
    if (
      row.metadata.storage !== "private-artifact-v1" ||
      row.metadata.bucket !== privateBucket ||
      !row.storageKey.startsWith("private-artifacts/" + row.id + "/")
    ) {
      return unresolved("ownership_unknown");
    }
    locations.push({ bucket: privateBucket, key: row.storageKey });
  } else if (row.storageKey !== null) {
    if (
      row.metadata.storage === "private-artifact-v1" ||
      !row.storageKey.startsWith("artifacts/")
    ) {
      return unresolved("ownership_unknown");
    }
    const resolved = await store.set(
      resolveOwnedPublicArtifactKey$,
      {
        userId: row.userId,
        url: buildFileUrlFromKey(row.storageKey, "vm0"),
      },
      signal,
    );
    if (
      resolved !== row.storageKey &&
      (await store.get(s3ObjectExists(publicBucket, row.storageKey)))
    ) {
      return unresolved("ownership_unknown");
    }
    // A vanished v2 object has no owner metadata left to read. Capture its
    // catalog key anyway and prove absence later; a live object whose metadata
    // belongs to someone else still blocks capture above.
    locations.push({ bucket: publicBucket, key: row.storageKey });
  } else if (row.metadata.storage === "private-artifact-v1") {
    return unresolved("ownership_unknown");
  }

  for (const value of [row.url, row.previewImageUrl]) {
    const location = await publicUrlLocator(
      value,
      row.userId,
      publicBucket,
      signal,
    );
    if (!location) {
      continue;
    }
    if ("outcome" in location) {
      return location;
    }
    if (
      !locations.some((existing) => {
        return (
          existing.bucket === location.bucket && existing.key === location.key
        );
      })
    ) {
      locations.push(location);
    }
  }
  return withLegacyRegistryLocators(locations, publicBucket, privateBucket);
}

function withLegacyRegistryLocators(
  locations: readonly ObjectLocator[],
  publicBucket: string,
  privateBucket: string | undefined,
): readonly ObjectLocator[] | ErasureUnresolved {
  const publicLocations = locations.filter((location) => {
    return location.bucket === publicBucket;
  });
  if (publicLocations.length === 0) {
    return locations;
  }
  const registryBucket = env("R2_HOSTED_SITES_BUCKET_NAME");
  if (
    !registryBucket ||
    registryBucket === publicBucket ||
    registryBucket === privateBucket
  ) {
    return unresolved("permission_missing");
  }
  return [
    ...locations,
    ...publicLocations.map((location) => {
      return {
        bucket: registryBucket,
        key: artifactDeliveryKey(
          null,
          "file",
          location.key.slice("artifacts/".length),
        ),
      };
    }),
  ];
}

function objectBatches(
  locations: readonly ObjectLocator[],
): readonly { readonly bucket: string; readonly keys: readonly string[] }[] {
  const ordered = [...locations].sort((left, right) => {
    return (
      left.bucket.localeCompare(right.bucket) ||
      left.key.localeCompare(right.key)
    );
  });
  const batches: { bucket: string; keys: string[] }[] = [];
  const seen = new Set<string>();
  for (const location of ordered) {
    const identity = `${location.bucket}\u0000${location.key}`;
    if (seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    const last = batches.at(-1);
    const candidate =
      last?.bucket === location.bucket
        ? [...last.keys, location.key]
        : [location.key];
    const selectorSize = Buffer.byteLength(
      JSON.stringify({
        version: 1,
        kind: "object_batch",
        storageRef: storageReference(location.bucket),
        keys: candidate,
      }),
    );
    if (
      last?.bucket === location.bucket &&
      candidate.length <= 20 &&
      selectorSize <= 4096
    ) {
      last.keys.push(location.key);
    } else {
      batches.push({ bucket: location.bucket, keys: [location.key] });
    }
  }
  return batches;
}

function requestReference(
  lease: ErasureLease,
  outcome: "erased" | "empty",
): string {
  return reference([
    "artifact-object-erase",
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
  signal: AbortSignal,
): Promise<ErasureInventoryPage | ErasureUnresolved> {
  const subjectId = await leaseSubject(lease);
  if (!subjectId) {
    return unresolved("selector_missing");
  }
  // A 60,000-file account needs many pages. Renew the same worker's lease
  // before each one without allowing another worker to interleave cursors.
  await renewErasureLease(db, lease);
  let after: string | undefined;
  if (cursor) {
    const decoded = await decryptErasureSelector(cursor);
    if (
      decoded.kind !== "cursor" ||
      !z.uuid().safeParse(decoded.after).success
    ) {
      return unresolved("selector_missing");
    }
    after = decoded.after;
  }
  const rows = await db
    .select({
      id: runUploadedFiles.id,
      userId: runUploadedFiles.userId,
      storageKey: runUploadedFiles.storageKey,
      url: runUploadedFiles.url,
      previewImageUrl: runUploadedFiles.previewImageUrl,
      metadata: runUploadedFiles.metadata,
    })
    .from(runUploadedFiles)
    .where(
      and(
        eq(runUploadedFiles.userId, subjectId),
        after ? gt(runUploadedFiles.id, after) : undefined,
      ),
    )
    .orderBy(asc(runUploadedFiles.id))
    .limit(PAGE_SIZE);
  const resolved = await Promise.all(
    rows.map(async (row) => {
      return await rowLocators(row, signal);
    }),
  );
  const collected: ObjectLocator[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const rowLocations = resolved[index];
    if (!row || !rowLocations) {
      throw new Error("Artifact inventory result length mismatch");
    }
    if ("outcome" in rowLocations) {
      return rowLocations;
    }
    collected.push(...rowLocations);
  }
  const batches = objectBatches(collected);
  const items = await Promise.all(
    batches.map(async (batch, index) => {
      return {
        sinkId: lease.item.sinkId,
        itemKey: reference([
          "artifact-object-batch-item",
          lease.jobId,
          lease.captureRevision,
          after ?? null,
          index,
          batch.bucket,
          batch.keys,
        ]),
        kind: "erase" as const,
        selector: await encryptErasureSelector({
          version: 1,
          kind: "object_batch",
          storageRef: storageReference(batch.bucket),
          keys: batch.keys,
        }),
        dependencies: [],
      };
    }),
  );
  const last = rows[rows.length - 1];
  const complete = rows.length < PAGE_SIZE;
  return {
    pageKey: reference([
      "artifact-object-page",
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
            after: last.id,
          }),
    enumerationRef: complete
      ? reference([
          "artifact-object-enumeration",
          ARTIFACT_FILE_ERASURE_COLLECTOR_VERSION,
          subjectId,
          "run_uploaded_files.user_id",
        ])
      : null,
    items,
  };
}

async function eraseObject(
  lease: ErasureLease,
  signal: AbortSignal,
): Promise<{ readonly requestRef: string } | ErasureUnresolved> {
  const objects = await leaseObjects(lease);
  if (!objects) {
    return unresolved("selector_missing");
  }
  const store = createStore();
  const hosted = objects.bucket === env("R2_HOSTED_SITES_BUCKET_NAME");
  if (hosted) {
    for (const key of objects.keys) {
      if (!(await registryIsOwned(objects.bucket, key, signal))) {
        return unresolved("ownership_unknown");
      }
    }
  }
  const present = await Promise.all(
    objects.keys.map(async (key) => {
      const exists = hosted
        ? hostedSitesObjectExists(objects.bucket, key)
        : s3ObjectExists(objects.bucket, key);
      return (await store.get(exists)) ? key : null;
    }),
  );
  const keys = present.filter((key): key is string => {
    return key !== null;
  });
  if (keys.length === 0) {
    return { requestRef: requestReference(lease, "empty") };
  }
  // Reuse the existing DeleteObjects primitive, including its 1000-key bound
  // and per-object provider error handling.
  await store.get(
    hosted
      ? deleteArtifactSnapshotObjects(objects.bucket, keys, true, signal)
      : deleteS3Objects(objects.bucket, keys, signal),
  );
  return { requestRef: requestReference(lease, "erased") };
}

async function verifyObjectAbsent(
  lease: ErasureLease,
  producerBoundary: string,
): Promise<ErasureProof | ErasureUnresolved> {
  const objects = await leaseObjects(lease);
  if (objects) {
    const store = createStore();
    const hosted = objects.bucket === env("R2_HOSTED_SITES_BUCKET_NAME");
    const remaining = await Promise.all(
      objects.keys.map(async (key) => {
        return await store.get(
          hosted
            ? hostedSitesObjectExists(objects.bucket, key)
            : s3ObjectExists(objects.bucket, key),
        );
      }),
    );
    if (remaining.includes(true)) {
      return unresolved("verification_failed", "retryable_failure");
    }
  } else if (!(await leaseSubject(lease))) {
    return unresolved("selector_missing");
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
      "artifact-object-absence",
      lease.jobId,
      lease.item.itemKey,
      lease.captureRevision,
    ]),
    authenticatedReaderRef: reference([
      "artifact-object-reader",
      ARTIFACT_FILE_ERASURE_COLLECTOR_VERSION,
      objects?.bucket ?? null,
    ]),
    enumerationRef: reference([
      "artifact-object-item-enumeration",
      ARTIFACT_FILE_ERASURE_COLLECTOR_VERSION,
      lease.item.itemKey,
    ]),
    observedAt: nowDate(),
  };
}

/** A dormant byte sink for run_uploaded_files. The relational sweep owns the
 * catalog row; this sink captures every owned exact key while that row exists,
 * then verifies S3 absence after capture sealing. Policy, alias and edge-cache
 * revocation are separate obligations and are not implied by this proof.
 */
export function createArtifactFileErasureCollector(db: Db): ErasureHandler {
  return {
    version: ARTIFACT_FILE_ERASURE_COLLECTOR_VERSION,
    inventory: async (lease, cursor, signal) => {
      return await inventoryPage(db, lease, cursor, signal);
    },
    erase: async (lease, signal) => {
      return await eraseObject(lease, signal);
    },
    verify: async (lease, boundary) => {
      return await verifyObjectAbsent(lease, boundary);
    },
  };
}
