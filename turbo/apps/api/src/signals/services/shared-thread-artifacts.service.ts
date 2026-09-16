import { command, computed } from "ccstate";
import { and, eq } from "drizzle-orm";
import { artifacts } from "@okouai/db/schema/artifact";
import { integrationArtifactDeliveries } from "@okouai/db/schema/integration-artifact-delivery";
import { sharedThreads } from "@okouai/db/schema/shared-thread";
import {
  sharedThreadArtifactPolicyKey,
  sharedThreadArtifactPolicySchema,
} from "@okouai/api-contracts/contracts/shared-thread-artifacts";
import {
  sharedThreadArtifactAuthorUserId,
  sharedThreadArtifactLogicalKey,
} from "../../lib/shared-thread-artifact";
import { writeDb$ } from "../external/db";
import { clerk$, isClerkResourceNotFound } from "../external/clerk";
import {
  deleteArtifactSnapshotObjects,
  readArtifactSharePolicyObject,
  writeArtifactSharePolicyObject,
} from "../external/s3";
import { settle } from "../utils";
import {
  privateArtifactCreationEnabled,
  privateArtifactsBucket,
} from "./private-artifact-storage.service";
import {
  copySharedThreadArtifacts$,
  SharedThreadArtifactUnavailable,
  sharedThreadArtifactsBucket,
  type SharedThreadArtifactPlan,
} from "./shared-thread-artifact-snapshot.service";

type SnapshotIdentity = Pick<
  typeof sharedThreads.$inferSelect,
  "id" | "userId" | "orgId" | "publicBrand" | "hasArtifactSnapshot"
>;

export function readSharedThreadArtifactPolicy(
  identity: SnapshotIdentity,
  signal: AbortSignal,
) {
  return computed(async (get) => {
    const read = await settle(
      get(
        readArtifactSharePolicyObject(
          sharedThreadArtifactsBucket(),
          sharedThreadArtifactPolicyKey(identity.publicBrand, identity.id),
          signal,
        ),
      ),
      signal,
    );
    if (!read.ok) {
      if (read.error instanceof Error && read.error.name === "NoSuchKey") {
        return null;
      }
      throw read.error;
    }
    const policy = sharedThreadArtifactPolicySchema.parse(
      JSON.parse(read.value.buffer.toString("utf8")),
    );
    if (
      policy.threadId !== identity.id ||
      policy.ownerId !== identity.userId ||
      policy.orgId !== identity.orgId ||
      policy.publicBrand !== identity.publicBrand
    ) {
      throw new Error("Conversation artifact policy does not match its owner");
    }
    return { policy, etag: read.value.etag };
  });
}

export function sharedThreadArtifactsReadable(
  identity: SnapshotIdentity,
  signal: AbortSignal,
) {
  return computed(async (get) => {
    return (
      !identity.hasArtifactSnapshot ||
      (await get(readSharedThreadArtifactPolicy(identity, signal)))?.policy
        .status === "active"
    );
  });
}

export const initializeSharedThreadArtifacts$ = command(
  async ({ get }, plan: SharedThreadArtifactPlan, signal: AbortSignal) => {
    const body = JSON.stringify(plan.policy);
    if (Buffer.byteLength(body) > 2 * 1024 * 1024) {
      throw new Error("Conversation artifact policy is too large");
    }
    await get(
      writeArtifactSharePolicyObject(
        sharedThreadArtifactsBucket(),
        sharedThreadArtifactPolicyKey(
          plan.policy.publicBrand,
          plan.policy.threadId,
        ),
        body,
        null,
        signal,
      ),
    );
  },
);

const changeSharedThreadArtifactPhase$ = command(
  async (
    { get, set },
    plan: SharedThreadArtifactPlan,
    phase: "copy" | "publish",
    signal: AbortSignal,
  ) => {
    await set(writeDb$).transaction(async (tx) => {
      // The same row lock serializes publication with owner/account deletion.
      const [row] = await tx
        .select()
        .from(sharedThreads)
        .where(eq(sharedThreads.id, plan.policy.threadId))
        .for("update");
      if (!row?.hasArtifactSnapshot) {
        throw new Error("Conversation snapshot was removed before publication");
      }
      const current = await get(readSharedThreadArtifactPolicy(row, signal));
      if (!current || current.policy.status !== "preparing") {
        throw new Error(
          "Conversation snapshot is no longer pending publication",
        );
      }
      // Check the external owner after the durable identity exists. A deletion
      // webhook either sees and locks this identity, or this fresh membership
      // check rejects the owner already deleted before its enumeration.
      const membership = await settle(
        get(clerk$).organizations.getOrganizationMembershipList(
          {
            organizationId: current.policy.orgId,
            userId: [row.userId],
            limit: 1,
          },
          undefined,
          signal,
        ),
        signal,
      );
      if (!membership.ok) {
        if (isClerkResourceNotFound(membership.error)) {
          throw new SharedThreadArtifactUnavailable();
        }
        throw membership.error;
      }
      if (
        !membership.value.data.some((member) => {
          return member.publicUserData?.userId === row.userId;
        })
      ) {
        throw new SharedThreadArtifactUnavailable();
      }
      if (phase === "copy") {
        await set(copySharedThreadArtifacts$, plan, signal);
        return;
      }
      const [integrationDelivery] = await tx
        .select({ snapshotId: integrationArtifactDeliveries.snapshotId })
        .from(integrationArtifactDeliveries)
        .where(eq(integrationArtifactDeliveries.snapshotId, row.id))
        .limit(1);
      signal.throwIfAborted();
      await get(
        writeArtifactSharePolicyObject(
          sharedThreadArtifactsBucket(),
          sharedThreadArtifactPolicyKey(row.publicBrand, row.id),
          JSON.stringify({ ...current.policy, status: "active" }),
          current.etag,
          signal,
        ),
      );
      signal.throwIfAborted();
      // Delivery snapshots share publication/erasure locking with manual
      // shares, but their durable identity keeps them out of the catalog.
      if (integrationDelivery) {
        return;
      }
      await tx.insert(artifacts).values({
        orgId: current.policy.orgId,
        authorUserId: sharedThreadArtifactAuthorUserId(row.userId),
        kind: "file",
        entityId: row.id,
        logicalKey: sharedThreadArtifactLogicalKey(row.id),
        projectionFileId: null,
        projectionCreatedAt: row.createdAt,
        title: row.title,
        thumbnail: null,
        createdAt: row.createdAt,
        updatedAt: row.createdAt,
      });
      signal.throwIfAborted();
    });
    signal.throwIfAborted();
  },
);

export const prepareSharedThreadArtifactCopies$ = command(
  ({ set }, plan: SharedThreadArtifactPlan, signal: AbortSignal) => {
    return set(changeSharedThreadArtifactPhase$, plan, "copy", signal);
  },
);

export const publishSharedThreadArtifacts$ = command(
  ({ set }, plan: SharedThreadArtifactPlan, signal: AbortSignal) => {
    return set(changeSharedThreadArtifactPhase$, plan, "publish", signal);
  },
);

function revokePolicy(identity: SnapshotIdentity, signal: AbortSignal) {
  return computed(async (get) => {
    if (!identity.hasArtifactSnapshot) {
      return null;
    }
    const current = await get(readSharedThreadArtifactPolicy(identity, signal));
    if (!current) {
      return null;
    }
    if (current.policy.status !== "revoked") {
      await get(
        writeArtifactSharePolicyObject(
          sharedThreadArtifactsBucket(),
          sharedThreadArtifactPolicyKey(identity.publicBrand, identity.id),
          JSON.stringify({ ...current.policy, status: "revoked" }),
          current.etag,
          signal,
        ),
      );
    }
    return current.policy;
  });
}

/** Revoke first; storage failures keep a retryable identity and denied URLs. */
export function removeSharedThreadArtifactCopies(
  identity: SnapshotIdentity,
  signal: AbortSignal,
) {
  return computed(async (get) => {
    const policy = await get(revokePolicy(identity, signal));
    if (!policy) {
      return;
    }
    const files: string[] = [];
    const siteFiles: string[] = [];
    for (const target of Object.values(policy.resources)) {
      if (target.kind === "file") {
        files.push(target.key);
      } else {
        const prefix = `shared-artifacts/${identity.publicBrand}/${target.snapshotId}/${target.id}`;
        siteFiles.push(
          `${prefix}/manifest.json`,
          ...Object.keys(target.manifest.files).map((path) => {
            return `${prefix}${path}`;
          }),
        );
      }
    }
    if (files.length) {
      await get(
        deleteArtifactSnapshotObjects(
          privateArtifactsBucket(),
          files,
          false,
          signal,
        ),
      );
    }
    if (siteFiles.length) {
      await get(
        deleteArtifactSnapshotObjects(
          sharedThreadArtifactsBucket(),
          siteFiles,
          true,
          signal,
        ),
      );
    }
    // Keep the revoked policy and immutable aliases as tombstones. A stale
    // alias/cache entry can never fall back to a different public object.
  });
}

export const deleteSharedThread$ = command(
  async (
    { get, set },
    args: {
      readonly id: string;
      readonly userId: string;
      readonly orgId: string;
    },
    signal: AbortSignal,
  ) => {
    return await set(writeDb$).transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(sharedThreads)
        .where(
          and(
            eq(sharedThreads.id, args.id),
            eq(sharedThreads.userId, args.userId),
          ),
        )
        .for("update");
      if (!row || (row.orgId !== null && row.orgId !== args.orgId)) {
        return false;
      }
      if (
        !row.hasArtifactSnapshot &&
        !(await get(privateArtifactCreationEnabled(args.orgId, args.userId)))
      ) {
        return false;
      }
      await get(removeSharedThreadArtifactCopies(row, signal));
      signal.throwIfAborted();
      await tx
        .delete(artifacts)
        .where(
          eq(artifacts.logicalKey, sharedThreadArtifactLogicalKey(row.id)),
        );
      await tx.delete(sharedThreads).where(eq(sharedThreads.id, row.id));
      return true;
    });
  },
);

function manageSharedThreadArtifacts(removeCopies: boolean) {
  return command(
    async (
      { get, set },
      owner:
        | { readonly kind: "organization"; readonly orgId: string }
        | { readonly kind: "user"; readonly userId: string },
      signal: AbortSignal,
    ) => {
      const db = set(writeDb$);
      const rows = await db
        .select()
        .from(sharedThreads)
        .where(
          and(
            eq(sharedThreads.hasArtifactSnapshot, true),
            owner.kind === "organization"
              ? eq(sharedThreads.orgId, owner.orgId)
              : eq(sharedThreads.userId, owner.userId),
          ),
        );
      signal.throwIfAborted();
      for (const candidate of rows) {
        await db.transaction(async (tx) => {
          const [row] = await tx
            .select()
            .from(sharedThreads)
            .where(eq(sharedThreads.id, candidate.id))
            .for("update");
          if (!row) {
            return;
          }
          if (removeCopies) {
            await get(removeSharedThreadArtifactCopies(row, signal));
          } else {
            await get(revokePolicy(row, signal));
          }
        });
        signal.throwIfAborted();
      }
    },
  );
}

export const revokeSharedThreadArtifacts$ = manageSharedThreadArtifacts(false);
export const cleanupSharedThreadArtifacts$ = manageSharedThreadArtifacts(true);
