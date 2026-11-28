import { canReadSharedThreadPolicy$ } from "./shared-thread-access.service";
import { randomUUID } from "node:crypto";
import { command, computed } from "ccstate";
import {
  and,
  count,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  sql,
} from "drizzle-orm";
import { artifacts } from "@okouai/db/schema/artifact";
import { files } from "@okouai/db/schema/file";
import { sharedThreads } from "@okouai/db/schema/shared-thread";
import type { ArtifactDeliveryRecord } from "@okouai/api-contracts/contracts/artifact-delivery";
import type { HostedSiteFilesResponse } from "@okouai/api-contracts/contracts/host";
import {
  sharedThreadArtifactPolicyKey,
  sharedThreadArtifactPolicySchema,
  type SharedThreadArtifactPolicy,
} from "@okouai/api-contracts/contracts/shared-thread-artifacts";
import {
  linkLayoutFromSegment,
  storedLinkLayoutSegment,
} from "@okouai/api-contracts/contracts/link-layout";
import {
  sharedThreadArtifactAuthorUserId,
  sharedThreadArtifactLogicalKey,
} from "../../lib/shared-thread-artifact";
import { db$, writeDb$ } from "../external/db";
import { clerk$, isClerkResourceNotFound } from "../external/clerk";
import {
  isS3NotFoundError,
  deleteArtifactSnapshotObjects,
  readArtifactSharePolicyObject,
  writeArtifactSharePolicyObject,
} from "../external/s3";
import { settle } from "../utils";
import { hostedLinkOrigin } from "../../lib/link-layout";
import { nowDate } from "../../lib/time";
import { signHostedSiteFiles$ } from "./hosted-site-files.service";
import { checkHostedSiteAccess$ } from "./hosted-site-access.service";
import { privateArtifactsBucket } from "./private-artifact-storage.service";
import { createHostedPreviewGrant$ } from "./private-hosted-preview.service";
import { resolveArtifactPreviewUrl$ } from "./artifact-preview-url.service";
import {
  copySharedThreadArtifacts$,
  SharedThreadArtifactUnavailable,
  sharedThreadArtifactsBucket,
  type SharedThreadArtifactPlan,
} from "./shared-thread-artifact-snapshot.service";

type SnapshotIdentity = Pick<
  typeof sharedThreads.$inferSelect,
  "id" | "userId" | "orgId" | "hasArtifactSnapshot"
> & {
  // The shared thread's stored link-layout segment. Conversation snapshots
  // created before the layout change stay under the legacy segment.
  readonly linkLayoutSegment: string;
};

interface SharedThreadHostedSnapshotArgs {
  readonly viewerId?: string;
  readonly record: Pick<
    Extract<ArtifactDeliveryRecord, { kind: "thread-resource" }>,
    "publicBrand" | "threadId" | "publicToken" | "targetKind" | "targetId"
  >;
}

/** Match the delivery Worker's authority without reopening the owner's live resource. */
export const authorizedSharedThreadHostedSnapshot$ = command(
  async (
    { get, set },
    args: SharedThreadHostedSnapshotArgs,
    signal: AbortSignal,
  ) => {
    const { record } = args;
    const stored = await settle(
      get(
        readArtifactSharePolicyObject(
          sharedThreadArtifactsBucket(),
          sharedThreadArtifactPolicyKey(record.publicBrand, record.threadId),
          signal,
        ),
      ),
      signal,
    );
    if (!stored.ok) {
      if (isS3NotFoundError(stored.error)) {
        return null;
      }
      throw stored.error;
    }
    const policy = sharedThreadArtifactPolicySchema.parse(
      JSON.parse(stored.value.buffer.toString("utf8")),
    );
    if (
      policy.status !== "active" ||
      policy.threadId !== record.threadId ||
      policy.publicBrand !== record.publicBrand ||
      !(await set(canReadSharedThreadPolicy$, policy, args.viewerId, signal))
    ) {
      return null;
    }
    const target = policy.resources[record.publicToken];
    if (
      target?.kind !== "html" ||
      record.targetKind !== "html" ||
      (record.targetId !== undefined && record.targetId !== target.id)
    ) {
      return null;
    }
    if (
      !(
        await set(
          checkHostedSiteAccess$,
          { siteId: target.siteId, userId: args.viewerId },
          signal,
        )
      ).allowed
    ) {
      return null;
    }
    return { policy, target };
  },
);

export const resolveSharedThreadHostedPreview$ = command(
  async (
    { set },
    args: SharedThreadHostedSnapshotArgs & { readonly publicSlug: string },
    signal: AbortSignal,
  ) => {
    const { record } = args;
    const snapshot = await set(
      authorizedSharedThreadHostedSnapshot$,
      { record, viewerId: args.viewerId },
      signal,
    );
    if (!snapshot) {
      return null;
    }
    const { policy, target } = snapshot;
    const preview = await set(
      createHostedPreviewGrant$,
      {
        siteId: target.siteId,
        deploymentId: target.id,
        layout: linkLayoutFromSegment(policy.publicBrand),
        snapshotId: target.snapshotId,
      },
      signal,
    );
    const cover = policy.previews?.[record.publicToken];
    const image = cover ? policy.resources[cover.token] : undefined;
    const resolvedImage =
      image?.kind === "file"
        ? await set(
            resolveArtifactPreviewUrl$,
            {
              bucket: privateArtifactsBucket(),
              key: image.key,
              signingDate: nowDate(),
            },
            signal,
          )
        : null;
    return { ...preview, previewImageUrl: resolvedImage?.url };
  },
);

export const resolveSharedThreadHostedDownload$ = command(
  async (
    { set },
    args: SharedThreadHostedSnapshotArgs & { readonly publicSlug: string },
    signal: AbortSignal,
  ): Promise<HostedSiteFilesResponse | null> => {
    const snapshot = await set(
      authorizedSharedThreadHostedSnapshot$,
      args,
      signal,
    );
    if (!snapshot) {
      return null;
    }
    return await set(
      signSharedThreadHostedDownload$,
      {
        publicSlug: args.publicSlug,
        viewerId: args.viewerId,
        layoutSegment: args.record.publicBrand,
        target: snapshot.target,
      },
      signal,
    );
  },
);

/** Call only after authorizing this exact snapshot against its live thread policy. */
export const signSharedThreadHostedDownload$ = command(
  async (
    { set },
    args: {
      readonly publicSlug: string;
      readonly viewerId?: string;
      readonly attachment?: boolean;
      readonly layoutSegment: SharedThreadArtifactPolicy["publicBrand"];
      readonly target: Extract<
        SharedThreadArtifactPolicy["resources"][string],
        { kind: "html" }
      >;
    },
    signal: AbortSignal,
  ): Promise<HostedSiteFilesResponse> => {
    const { target } = args;
    const url = `${hostedLinkOrigin(
      linkLayoutFromSegment(args.layoutSegment),
      args.publicSlug,
    )}/`;
    return await set(
      signHostedSiteFiles$,
      {
        metadata: {
          siteId: target.siteId,
          deploymentId: target.id,
          deploymentVersion: target.deploymentVersion,
          publicSlug: args.publicSlug,
          url,
          artifactUrl: url,
          aliasUrl: url,
        },
        manifest: target.manifest,
        viewerId: args.viewerId,
        attachment: args.attachment,
        prefix: `shared-artifacts/${args.layoutSegment}/${target.snapshotId}/${target.id}`,
      },
      signal,
    );
  },
);

export const readSharedThreadPolicy$ = command(
  async ({ get }, identity: SnapshotIdentity, signal: AbortSignal) => {
    const read = await settle(
      get(
        readArtifactSharePolicyObject(
          sharedThreadArtifactsBucket(),
          sharedThreadArtifactPolicyKey(
            storedLinkLayoutSegment(identity.linkLayoutSegment),
            identity.id,
          ),
          signal,
        ),
      ),
      signal,
    );
    if (!read.ok) {
      if (isS3NotFoundError(read.error)) {
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
      policy.publicBrand !== identity.linkLayoutSegment
    ) {
      throw new Error("Conversation artifact policy does not match its owner");
    }
    signal.throwIfAborted();
    return { policy, etag: read.value.etag };
  },
);

export const sharedThreadArtifactsReadable$ = command(
  async (
    { set },
    identity: SnapshotIdentity,
    viewerId: string | undefined,
    signal: AbortSignal,
  ) => {
    if (!identity.hasArtifactSnapshot) {
      return true;
    }
    const current = await set(readSharedThreadPolicy$, identity, signal);
    return (
      current !== null &&
      (await set(canReadSharedThreadPolicy$, current.policy, viewerId, signal))
    );
  },
);

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

function createSharedThreadPublication(plan: SharedThreadArtifactPlan) {
  return computed(async (get) => {
    const db = get(db$);
    const { ownerId, orgId, threadId } = plan.policy;
    const attachmentIds = [...plan.privateAttachmentIds];
    // Recheck cached attachment metadata alongside the existing publication read.
    const attachmentsAvailable =
      attachmentIds.length === 0
        ? sql`true`
        : exists(
            db
              .select({ total: count() })
              .from(files)
              .where(
                and(
                  inArray(files.id, attachmentIds),
                  eq(files.ownerUserId, ownerId),
                  eq(files.orgId, orgId),
                  isNull(files.deletedAt),
                  isNotNull(files.sizeBytes),
                ),
              )
              .having(eq(count(), attachmentIds.length)),
          );
    const [publication] = await db
      .select({
        row: sharedThreads,
        attachmentsAvailable: attachmentsAvailable.mapWith(
          sharedThreads.hasArtifactSnapshot,
        ),
      })
      .from(sharedThreads)
      .where(
        and(
          eq(sharedThreads.id, threadId),
          eq(sharedThreads.userId, ownerId),
          eq(sharedThreads.orgId, orgId),
        ),
      );
    return publication;
  });
}

const changeSharedThreadArtifactPhase$ = command(
  async (
    { get, set },
    plan: SharedThreadArtifactPlan,
    phase: "copy" | "publish",
    signal: AbortSignal,
  ) => {
    const publication = await get(createSharedThreadPublication(plan));
    signal.throwIfAborted();
    if (!publication?.row.hasArtifactSnapshot) {
      throw new Error("Conversation snapshot was removed before publication");
    }
    if (!publication.attachmentsAvailable) {
      throw new SharedThreadArtifactUnavailable();
    }
    const { row } = publication;
    const current = await set(readSharedThreadPolicy$, row, signal);
    if (!current || current.policy.status !== "preparing") {
      throw new Error("Conversation snapshot is no longer pending publication");
    }
    // Policy ETags fence publication against revocation without holding SQL locks.
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
    signal.throwIfAborted();
    await get(
      writeArtifactSharePolicyObject(
        sharedThreadArtifactsBucket(),
        sharedThreadArtifactPolicyKey(
          storedLinkLayoutSegment(row.linkLayoutSegment),
          row.id,
        ),
        JSON.stringify({ ...current.policy, status: "active" }),
        current.etag,
        signal,
      ),
    );
    signal.throwIfAborted();
    // Catalog projection is recoverable, not the public grant. Only insert
    // while the snapshot still exists. Deleting its source chat only clears
    // the catalog association; the snapshot and global catalog entry survive.
    const database = set(writeDb$);
    await database.execute(sql`
      INSERT INTO ${artifacts} (
        "id",
        "org_id",
        "author_user_id",
        "kind",
        "entity_id",
        "logical_key",
        "chat_thread_id",
        "display_kind",
        "title",
        "visibility",
        "category",
        "created_at",
        "updated_at"
      )
      SELECT
        ${randomUUID()}::uuid,
        ${current.policy.orgId},
        ${sharedThreadArtifactAuthorUserId(row.userId)},
        'file',
        ${sharedThreads.id},
        ${sharedThreadArtifactLogicalKey(row.id)},
        ${sharedThreads.sourceChatThreadId},
        'shared-thread',
        ${sharedThreads.title},
        'private',
        'other',
        ${sharedThreads.createdAt},
        ${sharedThreads.createdAt}
      FROM ${sharedThreads}
      WHERE ${sharedThreads.id} = ${row.id}
        AND ${sharedThreads.userId} = ${row.userId}
        AND ${sharedThreads.orgId} = ${current.policy.orgId}
      ON CONFLICT ("org_id", "author_user_id", "logical_key") DO NOTHING
    `);
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

const revokePolicy$ = command(
  async ({ get, set }, identity: SnapshotIdentity, signal: AbortSignal) => {
    if (!identity.hasArtifactSnapshot) {
      return null;
    }
    const current = await set(readSharedThreadPolicy$, identity, signal);
    if (!current) {
      return null;
    }
    if (current.policy.status !== "revoked") {
      await get(
        writeArtifactSharePolicyObject(
          sharedThreadArtifactsBucket(),
          sharedThreadArtifactPolicyKey(
            storedLinkLayoutSegment(identity.linkLayoutSegment),
            identity.id,
          ),
          JSON.stringify({ ...current.policy, status: "revoked" }),
          current.etag,
          signal,
        ),
      );
    }
    signal.throwIfAborted();
    return current.policy;
  },
);

/** Revoke first; storage failures keep a retryable identity and denied URLs. */
export const removeSharedThreadArtifactCopies$ = command(
  async ({ get, set }, identity: SnapshotIdentity, signal: AbortSignal) => {
    const policy = await set(revokePolicy$, identity, signal);
    if (!policy) {
      return;
    }
    const files: string[] = [];
    const siteFiles: string[] = [];
    for (const target of Object.values(policy.resources)) {
      if (target.kind === "file") {
        files.push(target.key);
      } else {
        const prefix = `shared-artifacts/${storedLinkLayoutSegment(identity.linkLayoutSegment)}/${target.snapshotId}/${target.id}`;
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
    signal.throwIfAborted();
    // Keep the revoked policy and immutable aliases as tombstones. A stale
    // alias/cache entry can never fall back to a different public object.
  },
);

export const deleteSharedThread$ = command(
  async (
    { set },
    args: {
      readonly id: string;
      readonly userId: string;
      readonly orgId: string;
    },
    signal: AbortSignal,
  ) => {
    const database = set(writeDb$);
    const [row] = await database
      .select()
      .from(sharedThreads)
      .where(
        and(
          eq(sharedThreads.id, args.id),
          eq(sharedThreads.userId, args.userId),
        ),
      );
    signal.throwIfAborted();
    if (!row || (row.orgId !== null && row.orgId !== args.orgId)) {
      return false;
    }
    await set(removeSharedThreadArtifactCopies$, row, signal);
    signal.throwIfAborted();
    const removed = database.$with("removed_shared_thread").as(
      database
        .delete(sharedThreads)
        .where(
          and(
            eq(sharedThreads.id, row.id),
            eq(sharedThreads.userId, args.userId),
          ),
        )
        .returning({ id: sharedThreads.id }),
    );
    await database
      .with(removed)
      .update(artifacts)
      .set({ deletedAt: nowDate() })
      .where(
        and(
          eq(artifacts.logicalKey, sharedThreadArtifactLogicalKey(row.id)),
          eq(
            artifacts.authorUserId,
            sharedThreadArtifactAuthorUserId(args.userId),
          ),
        ),
      );
    signal.throwIfAborted();
    return true;
  },
);
