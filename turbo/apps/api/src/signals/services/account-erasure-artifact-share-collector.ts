import { createStore } from "ccstate";
import { and, asc, eq, gt } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { v5 as uuidv5 } from "uuid";
import { z } from "zod";

import {
  artifactDeliveryKey,
  artifactDeliveryRecordSchema,
  artifactFilenameExtension,
} from "@okouai/api-contracts/contracts/artifact-delivery";
import { artifactSharePolicySchema } from "@okouai/api-contracts/contracts/artifact-shares";
import {
  renewErasureLease,
  type EncryptedErasureSelector,
  type ErasureHandler,
  type ErasureInventoryItem,
  type ErasureInventoryPage,
  type ErasureLease,
  type ErasureProof,
  type ErasureUnresolved,
} from "@okouai/db/operations/account-erasure";
import { artifactShares } from "@okouai/db/schema/artifact-share";

import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import {
  deleteArtifactSnapshotObjects,
  deleteS3Objects,
  hostedSitesObjectExists,
  isS3NotFoundError,
  listHostedSitesObjectsPage,
  readArtifactSharePolicyObject,
  s3ObjectExists,
} from "../external/s3";
import { safeJsonParse, settle } from "../utils";
import {
  decryptErasureSelector,
  encryptErasureSelector,
} from "./account-erasure-selector";

type Db = NodePgDatabase<Record<string, never>>;
type ShareRow = Pick<
  typeof artifactShares.$inferSelect,
  "id" | "userId" | "orgId" | "publicBrand" | "targetKind" | "targetId"
>;
type Policy = z.infer<typeof artifactSharePolicySchema>;

const PAGE_SIZE = 20;
const SNAPSHOT_DELETE_PAGE_SIZE = 1000;
const MAX_SNAPSHOT_DELETE_PAGES_PER_LEASE = 10;
const NAMESPACE = "2cd6e1b4-583b-4abf-8520-b8936b2bd311";
export const ARTIFACT_SHARE_ERASURE_COLLECTOR_VERSION =
  "a87f7dc9-36ab-4284-901c-1b0fc0593818";

function reference(parts: readonly unknown[]): string {
  return uuidv5(JSON.stringify(parts), NAMESPACE);
}

function storageReference(bucket: string): string {
  return reference([
    "artifact-share-storage",
    1,
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

async function leaseShare(lease: ErasureLease, bucket: string) {
  if (!lease.item.selectorCiphertext || !lease.item.selectorDigest) {
    return undefined;
  }
  const selector = await decryptErasureSelector({
    ciphertext: lease.item.selectorCiphertext,
    digest: lease.item.selectorDigest,
  });
  return selector.kind === "artifact_share" &&
    selector.storageRef === storageReference(bucket)
    ? selector
    : undefined;
}

function policyKey(row: ShareRow): string {
  return `artifact-shares/${row.publicBrand}/${row.id}.json`;
}

async function readPolicy(
  row: ShareRow,
  bucket: string,
  signal: AbortSignal,
): Promise<Policy | ErasureUnresolved> {
  const stored = await settle(
    createStore().get(
      readArtifactSharePolicyObject(bucket, policyKey(row), signal),
    ),
    signal,
  );
  if (!stored.ok) {
    if (isS3NotFoundError(stored.error)) {
      // Alias registration can precede policy publication. Without the
      // policy's token there is no justified selector for that alias.
      return unresolved("ownership_unknown");
    }
    throw stored.error;
  }
  const parsed = artifactSharePolicySchema.safeParse(
    safeJsonParse(stored.value.buffer.toString("utf8")),
  );
  if (!parsed.success) {
    return unresolved("ownership_unknown");
  }
  const policy = parsed.data;
  const targetId = policy.target.id;
  if (
    policy.shareId !== row.id ||
    policy.ownerId !== row.userId ||
    policy.orgId !== row.orgId ||
    policy.publicBrand !== row.publicBrand ||
    policy.target.kind !== row.targetKind ||
    targetId !== row.targetId
  ) {
    return unresolved("ownership_unknown");
  }
  return policy;
}

function aliasKeys(policy: Policy): readonly string[] | ErasureUnresolved {
  if (!policy.delivery || !policy.publicToken) {
    return [];
  }
  if (policy.target.kind === "file") {
    return [
      artifactDeliveryKey(
        null,
        "file",
        policy.publicToken + artifactFilenameExtension(policy.target.filename),
      ),
    ];
  }
  if (!policy.publicSlug) {
    return unresolved("ownership_unknown");
  }
  // The durable token URL and the allocated slug are separate registry keys.
  return [
    artifactDeliveryKey(policy.publicBrand, "html", policy.publicToken),
    artifactDeliveryKey(policy.publicBrand, "html", policy.publicSlug),
  ];
}

async function aliasBelongsToShare(
  bucket: string,
  key: string,
  share: Pick<Policy, "shareId" | "publicBrand"> & {
    readonly targetKind: "file" | "html";
  },
  signal: AbortSignal,
): Promise<boolean> {
  const stored = await settle(
    createStore().get(readArtifactSharePolicyObject(bucket, key, signal)),
    signal,
  );
  if (!stored.ok) {
    if (isS3NotFoundError(stored.error)) {
      return !(await createStore().get(hostedSitesObjectExists(bucket, key)));
    }
    throw stored.error;
  }
  const record = artifactDeliveryRecordSchema.safeParse(
    safeJsonParse(stored.value.buffer.toString("utf8")),
  );
  return (
    record.success &&
    record.data.kind === "publication" &&
    record.data.shareId === share.shareId &&
    record.data.publicBrand === share.publicBrand &&
    record.data.targetKind === share.targetKind
  );
}

async function referenceBelongsToShare(
  bucket: string,
  key: string,
  share: {
    readonly shareId: string;
    readonly targetKind: "file" | "html";
    readonly targetId: string;
  },
  signal: AbortSignal,
): Promise<boolean> {
  const stored = await settle(
    createStore().get(readArtifactSharePolicyObject(bucket, key, signal)),
    signal,
  );
  if (!stored.ok) {
    if (isS3NotFoundError(stored.error)) {
      return !(await createStore().get(hostedSitesObjectExists(bucket, key)));
    }
    throw stored.error;
  }
  const value = safeJsonParse(stored.value.buffer.toString("utf8"));
  const reference = z
    .discriminatedUnion("version", [
      z.object({ version: z.literal(1), shareId: z.uuid() }),
      z.object({
        version: z.literal(2),
        target: z.object({ kind: z.enum(["file", "html"]), id: z.uuid() }),
      }),
    ])
    .safeParse(value);
  return (
    reference.success &&
    (reference.data.version === 1
      ? reference.data.shareId === share.shareId
      : reference.data.target.kind === share.targetKind &&
        reference.data.target.id === share.targetId)
  );
}

async function shareItems(
  row: ShareRow,
  bucket: string,
  sinkId: string,
  signal: AbortSignal,
): Promise<readonly ErasureInventoryItem[] | ErasureUnresolved> {
  const policy = await readPolicy(row, bucket, signal);
  if ("outcome" in policy) {
    return policy;
  }
  const aliases = aliasKeys(policy);
  if ("outcome" in aliases) {
    return aliases;
  }
  for (const alias of aliases) {
    if (
      !(await aliasBelongsToShare(
        bucket,
        alias,
        {
          shareId: row.id,
          publicBrand: row.publicBrand,
          targetKind: row.targetKind,
        },
        signal,
      ))
    ) {
      return unresolved("ownership_unknown");
    }
  }
  const keys = [policyKey(row), ...aliases];
  if (policy.organizationReference) {
    const referenceKey = `artifact-references/${policy.organizationReference}.json`;
    if (
      !(await referenceBelongsToShare(
        bucket,
        referenceKey,
        {
          shareId: row.id,
          targetKind: row.targetKind,
          targetId: row.targetId,
        },
        signal,
      ))
    ) {
      return unresolved("ownership_unknown");
    }
    keys.push(referenceKey);
  }
  const snapshotPrefix =
    policy.target.kind === "html"
      ? `shared-artifacts/${policy.publicBrand}/${policy.target.snapshotId}/${policy.target.id}`
      : undefined;
  return [
    {
      sinkId,
      itemKey: reference(["artifact-share-item", row.id]),
      kind: "erase",
      selector: await encryptErasureSelector({
        version: 1,
        kind: "artifact_share",
        storageRef: storageReference(bucket),
        shareId: row.id,
        targetKind: row.targetKind,
        targetId: row.targetId,
        publicBrand: row.publicBrand,
        keys,
        ...(policy.target.kind === "file"
          ? { privateKey: policy.target.key }
          : {}),
        ...(snapshotPrefix ? { snapshotPrefix } : {}),
      }),
      dependencies: [],
    },
    // Earlier updates can replace the selected snapshot while the previous
    // copy remains in R2 without a share or owner key. Keep that history as an
    // explicit residual until it can be discovered and verified.
    {
      sinkId,
      itemKey: reference(["artifact-share-history", row.id]),
      kind: "erase",
      selector: await encryptErasureSelector({
        version: 1,
        kind: "artifact_share_history",
        shareId: row.id,
      }),
      dependencies: [],
    },
  ];
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
  const bucket = env("R2_HOSTED_SITES_BUCKET_NAME");
  if (!bucket) {
    return unresolved("permission_missing");
  }
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
      id: artifactShares.id,
      userId: artifactShares.userId,
      orgId: artifactShares.orgId,
      publicBrand: artifactShares.publicBrand,
      targetKind: artifactShares.targetKind,
      targetId: artifactShares.targetId,
    })
    .from(artifactShares)
    .where(
      and(
        eq(artifactShares.userId, subjectId),
        after ? gt(artifactShares.id, after) : undefined,
      ),
    )
    .orderBy(asc(artifactShares.id))
    .limit(PAGE_SIZE);
  const items: ErasureInventoryItem[] = [];
  for (const row of rows) {
    const captured = await shareItems(row, bucket, lease.item.sinkId, signal);
    if ("outcome" in captured) {
      return captured;
    }
    items.push(...captured);
  }
  const last = rows[rows.length - 1];
  const complete = rows.length < PAGE_SIZE;
  return {
    pageKey: reference([
      "artifact-share-page",
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
          "artifact-share-enumeration",
          ARTIFACT_SHARE_ERASURE_COLLECTOR_VERSION,
          subjectId,
        ])
      : null,
    items,
  };
}

function requestReference(
  lease: ErasureLease,
  outcome: "erased" | "empty",
): string {
  return reference([
    "artifact-share-erase",
    lease.jobId,
    lease.item.itemKey,
    lease.captureRevision,
    outcome,
  ]);
}

async function eraseShare(
  lease: ErasureLease,
  signal: AbortSignal,
): Promise<{ readonly requestRef: string } | ErasureUnresolved> {
  if (lease.item.selectorCiphertext && lease.item.selectorDigest) {
    const selector = await decryptErasureSelector({
      ciphertext: lease.item.selectorCiphertext,
      digest: lease.item.selectorDigest,
    });
    if (selector.kind === "artifact_share_history") {
      return unresolved("ownership_unknown");
    }
  }
  const bucket = env("R2_HOSTED_SITES_BUCKET_NAME");
  if (!bucket) {
    return unresolved("permission_missing");
  }
  const share = await leaseShare(lease, bucket);
  if (!share) {
    return unresolved("selector_missing");
  }
  for (const key of share.keys) {
    if (
      key.startsWith("artifact-delivery/") &&
      !(await aliasBelongsToShare(bucket, key, share, signal))
    ) {
      return unresolved("ownership_unknown");
    }
    if (
      key.startsWith("artifact-references/") &&
      !(await referenceBelongsToShare(bucket, key, share, signal))
    ) {
      return unresolved("ownership_unknown");
    }
  }
  const store = createStore();
  const present = await Promise.all(
    share.keys.map(async (key) => {
      return (await store.get(hostedSitesObjectExists(bucket, key)))
        ? key
        : null;
    }),
  );
  const keys = present.filter((key): key is string => {
    return key !== null;
  });
  if (keys.length > 0) {
    await store.get(deleteArtifactSnapshotObjects(bucket, keys, true, signal));
  }
  let snapshotDeleted = false;
  if (share.snapshotPrefix) {
    for (
      let pageNumber = 0;
      pageNumber < MAX_SNAPSHOT_DELETE_PAGES_PER_LEASE;
      pageNumber += 1
    ) {
      signal.throwIfAborted();
      const page = await store.get(
        listHostedSitesObjectsPage(
          bucket,
          share.snapshotPrefix,
          SNAPSHOT_DELETE_PAGE_SIZE,
        ),
      );
      if (page.objects.length === 0) {
        break;
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
      snapshotDeleted = true;
      if (!page.isTruncated) {
        break;
      }
      if (pageNumber === MAX_SNAPSHOT_DELETE_PAGES_PER_LEASE - 1) {
        return {
          outcome: "pending",
          errorCode: "boundary_unproven",
          requestRef: requestReference(lease, "erased"),
          retryAt: new Date(nowDate().getTime() + 60_000),
        };
      }
    }
  }
  let privateObject = false;
  if (share.privateKey) {
    const privateBucket = env("R2_PRIVATE_ARTIFACTS_BUCKET_NAME");
    if (!privateBucket) {
      return unresolved("permission_missing");
    }
    privateObject = await store.get(
      s3ObjectExists(privateBucket, share.privateKey),
    );
    if (privateObject) {
      await store.get(
        deleteS3Objects(privateBucket, [share.privateKey], signal),
      );
    }
  }
  return {
    requestRef: requestReference(
      lease,
      keys.length > 0 ||
        snapshotDeleted ||
        privateObject ||
        lease.item.requestRef === requestReference(lease, "erased")
        ? "erased"
        : "empty",
    ),
  };
}

async function verifyShareAbsent(
  lease: ErasureLease,
  producerBoundary: string,
): Promise<ErasureProof | ErasureUnresolved> {
  if (lease.item.selectorCiphertext && lease.item.selectorDigest) {
    const selector = await decryptErasureSelector({
      ciphertext: lease.item.selectorCiphertext,
      digest: lease.item.selectorDigest,
    });
    if (selector.kind === "artifact_share_history") {
      return unresolved("ownership_unknown");
    }
  }
  const bucket = env("R2_HOSTED_SITES_BUCKET_NAME");
  if (!bucket) {
    return unresolved("permission_missing");
  }
  const share = await leaseShare(lease, bucket);
  if (share) {
    const store = createStore();
    const remaining = await Promise.all(
      share.keys.map(async (key) => {
        return await store.get(hostedSitesObjectExists(bucket, key));
      }),
    );
    const copy = share.snapshotPrefix
      ? await store.get(
          listHostedSitesObjectsPage(bucket, share.snapshotPrefix, 1),
        )
      : null;
    const privateBucket = env("R2_PRIVATE_ARTIFACTS_BUCKET_NAME");
    if (share.privateKey && !privateBucket) {
      return unresolved("permission_missing");
    }
    const privateObject =
      share.privateKey && privateBucket
        ? await store.get(s3ObjectExists(privateBucket, share.privateKey))
        : false;
    if (
      remaining.includes(true) ||
      (copy && (copy.objects.length > 0 || copy.isTruncated)) ||
      privateObject
    ) {
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
      "artifact-share-absence",
      lease.jobId,
      lease.item.itemKey,
      lease.captureRevision,
    ]),
    authenticatedReaderRef: reference([
      "artifact-share-reader",
      ARTIFACT_SHARE_ERASURE_COLLECTOR_VERSION,
      storageReference(bucket),
    ]),
    enumerationRef: reference([
      "artifact-share-item-enumeration",
      ARTIFACT_SHARE_ERASURE_COLLECTOR_VERSION,
      lease.item.itemKey,
    ]),
    observedAt: nowDate(),
  };
}

/** A dormant sink for owner-scoped share policies, aliases, organization
 * references and selected hosted copies. Revocation is proved by R2 absence;
 * the Worker reads policy before serving even warm content caches.
 */
export function createArtifactShareErasureCollector(db: Db): ErasureHandler {
  return {
    version: ARTIFACT_SHARE_ERASURE_COLLECTOR_VERSION,
    inventory: async (lease, cursor, signal) => {
      return await inventoryPage(db, lease, cursor, signal);
    },
    erase: async (lease, signal) => {
      return await eraseShare(lease, signal);
    },
    verify: async (lease, boundary) => {
      return await verifyShareAbsent(lease, boundary);
    },
  };
}
