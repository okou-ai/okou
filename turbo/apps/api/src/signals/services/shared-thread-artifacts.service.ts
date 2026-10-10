import { randomUUID } from "node:crypto";
import { command } from "ccstate";
import { and, desc, eq, sql } from "drizzle-orm";
import { artifacts } from "@okouai/db/schema/artifact";
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
import { nullableDriverValueDecoder } from "../../lib/db-structured-result";
import { signHostedSiteFiles$ } from "./hosted-site-files.service";
import {
  privateArtifactCreationEnabled$,
  privateArtifactsBucket,
} from "./private-artifact-storage.service";
import {
  copySharedThreadArtifacts$,
  prepareSharedThreadMarkdownCovers$,
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

/** Match the delivery Worker's authority without reopening the owner's live resource. */
export const resolveSharedThreadHostedDownload$ = command(
  async (
    { get, set },
    args: {
      readonly publicSlug: string;
      readonly record: Pick<
        Extract<ArtifactDeliveryRecord, { kind: "thread-resource" }>,
        "publicBrand" | "threadId" | "publicToken" | "targetKind" | "targetId"
      >;
    },
    signal: AbortSignal,
  ): Promise<HostedSiteFilesResponse | null> => {
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
      policy.publicBrand !== record.publicBrand
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
    return await set(
      signSharedThreadHostedDownload$,
      {
        publicSlug: args.publicSlug,
        layoutSegment: record.publicBrand,
        target,
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
        prefix: `shared-artifacts/${args.layoutSegment}/${target.snapshotId}/${target.id}`,
      },
      signal,
    );
  },
);

const readPolicy$ = command(
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
      policy.publicBrand !== identity.linkLayoutSegment
    ) {
      throw new Error("Conversation artifact policy does not match its owner");
    }
    signal.throwIfAborted();
    return { policy, etag: read.value.etag };
  },
);

export const sharedThreadArtifactsReadable$ = command(
  async ({ set }, identity: SnapshotIdentity, signal: AbortSignal) => {
    return (
      !identity.hasArtifactSnapshot ||
      (await set(readPolicy$, identity, signal))?.policy.status === "active"
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

const changeSharedThreadArtifactPhase$ = command(
  async (
    { get, set },
    plan: SharedThreadArtifactPlan,
    phase: "copy" | "publish",
    signal: AbortSignal,
  ) => {
    const [row] = await get(db$)
      .select()
      .from(sharedThreads)
      .where(
        and(
          eq(sharedThreads.id, plan.policy.threadId),
          eq(sharedThreads.userId, plan.policy.ownerId),
          eq(sharedThreads.orgId, plan.policy.orgId),
        ),
      );
    signal.throwIfAborted();
    if (!row?.hasArtifactSnapshot) {
      throw new Error("Conversation snapshot was removed before publication");
    }
    const current = await set(readPolicy$, row, signal);
    if (!current || current.policy.status !== "preparing") {
      throw new Error("Conversation snapshot is no longer pending publication");
    }
    // The durable denied identity is discoverable by owner cleanup. Policy
    // ETags fence publication against revocation without holding SQL locks.
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
    // while the owned thread still exists; deletion removes both SQL records.
    const database = set(writeDb$);
    await database
      .insert(artifacts)
      .select(
        database
          .select({
            id: sql`${randomUUID()}::uuid`.mapWith(artifacts.id).as("id"),
            orgId: sql`${current.policy.orgId}`
              .mapWith(artifacts.orgId)
              .as("org_id"),
            authorUserId: sql`${sharedThreadArtifactAuthorUserId(row.userId)}`
              .mapWith(artifacts.authorUserId)
              .as("author_user_id"),
            kind: sql`'file'`.mapWith(artifacts.kind).as("kind"),
            entityId: sharedThreads.id,
            logicalKey: sql`${sharedThreadArtifactLogicalKey(row.id)}`
              .mapWith(artifacts.logicalKey)
              .as("logical_key"),
            projectionFileId: sql`NULL::uuid`
              .mapWith(nullableDriverValueDecoder(artifacts.projectionFileId))
              .as("projection_file_id"),
            projectionCreatedAt: sharedThreads.createdAt,
            title: sharedThreads.title,
            thumbnail: sql`NULL::jsonb`
              .mapWith(nullableDriverValueDecoder(artifacts.thumbnail))
              .as("thumbnail"),
            createdAt: sharedThreads.createdAt,
            updatedAt: sharedThreads.createdAt,
          })
          .from(sharedThreads)
          .where(
            and(
              eq(sharedThreads.id, row.id),
              eq(sharedThreads.userId, row.userId),
              eq(sharedThreads.orgId, current.policy.orgId),
            ),
          ),
      )
      .onConflictDoNothing({
        target: [artifacts.orgId, artifacts.authorUserId, artifacts.logicalKey],
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

export const renderSharedThreadMarkdownCovers$ = command(
  async (
    { get, set },
    args: {
      readonly threadId: string;
      readonly userId: string;
      readonly orgId: string;
    },
    signal: AbortSignal,
  ) => {
    const [row] = await get(db$)
      .select()
      .from(sharedThreads)
      .where(
        and(
          eq(sharedThreads.id, args.threadId),
          eq(sharedThreads.userId, args.userId),
          eq(sharedThreads.orgId, args.orgId),
          eq(sharedThreads.hasArtifactSnapshot, true),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!row) {
      return;
    }
    const current = await set(readPolicy$, row, signal);
    if (!current || current.policy.status !== "active") {
      return;
    }
    const prepared = await set(
      prepareSharedThreadMarkdownCovers$,
      current.policy,
      signal,
    );
    if (!prepared) {
      return;
    }
    await get(
      writeArtifactSharePolicyObject(
        sharedThreadArtifactsBucket(),
        sharedThreadArtifactPolicyKey(
          storedLinkLayoutSegment(row.linkLayoutSegment),
          row.id,
        ),
        JSON.stringify(prepared),
        current.etag,
        signal,
      ),
    );
    signal.throwIfAborted();
  },
);

export const renderOwnedSharedThreadMarkdownCovers$ = command(
  async (
    { get, set },
    args: { readonly userId: string; readonly orgId: string },
    signal: AbortSignal,
  ) => {
    const rows = await get(db$)
      .select({ id: sharedThreads.id })
      .from(sharedThreads)
      .where(
        and(
          eq(sharedThreads.userId, args.userId),
          eq(sharedThreads.orgId, args.orgId),
          eq(sharedThreads.hasArtifactSnapshot, true),
        ),
      )
      .orderBy(desc(sharedThreads.createdAt))
      .limit(4);
    signal.throwIfAborted();
    for (const row of rows) {
      await set(
        renderSharedThreadMarkdownCovers$,
        { ...args, threadId: row.id },
        signal,
      );
    }
  },
);

const revokePolicy$ = command(
  async ({ get, set }, identity: SnapshotIdentity, signal: AbortSignal) => {
    if (!identity.hasArtifactSnapshot) {
      return null;
    }
    const current = await set(readPolicy$, identity, signal);
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
    if (
      !row.hasArtifactSnapshot &&
      !(await set(
        privateArtifactCreationEnabled$,
        args.orgId,
        args.userId,
        signal,
      ))
    ) {
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
      .delete(artifacts)
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

function manageSharedThreadArtifacts(removeCopies: boolean) {
  return command(
    async (
      { set },
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
      for (const row of rows) {
        if (removeCopies) {
          await set(removeSharedThreadArtifactCopies$, row, signal);
        } else {
          await set(revokePolicy$, row, signal);
        }
        signal.throwIfAborted();
      }
    },
  );
}

export const revokeSharedThreadArtifacts$ = manageSharedThreadArtifacts(false);
export const cleanupSharedThreadArtifacts$ = manageSharedThreadArtifacts(true);
