import { randomUUID } from "node:crypto";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { sharedThreads } from "@okouai/db/schema/shared-thread";
import {
  sharedThreadArtifactPolicyKey,
  sharedThreadArtifactPolicySchema,
  sharedThreadPolicyAudience,
} from "@okouai/api-contracts/contracts/shared-thread-artifacts";
import type { SharedThreadAudience } from "@okouai/api-contracts/contracts/shared-thread-visibility";
import { storedLinkLayoutSegment } from "@okouai/api-contracts/contracts/link-layout";
import { db$, writeDb$ } from "../external/db";
import { writeArtifactSharePolicyObject } from "../external/s3";
import { settle } from "../utils";
import { sharedThreadArtifactsBucket } from "./shared-thread-artifact-snapshot.service";
import { sharedThreadMember$ } from "./shared-thread-access.service";
import {
  readSharedThreadPolicy$,
  removeSharedThreadArtifactCopies$,
} from "./shared-thread-artifacts.service";

interface Owner {
  readonly id: string;
  readonly userId: string;
  readonly orgId: string;
}

const ownedSharedThreadVisibility$ = command(
  async ({ get, set }, owner: Owner, signal: AbortSignal) => {
    const [row] = await get(db$)
      .select({
        id: sharedThreads.id,
        userId: sharedThreads.userId,
        orgId: sharedThreads.orgId,
        hasArtifactSnapshot: sharedThreads.hasArtifactSnapshot,
        linkLayoutSegment: sharedThreads.linkLayoutSegment,
        messageAttachments: sharedThreads.messageAttachments,
      })
      .from(sharedThreads)
      .where(
        and(
          eq(sharedThreads.id, owner.id),
          eq(sharedThreads.userId, owner.userId),
          eq(sharedThreads.orgId, owner.orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!row) {
      return null;
    }
    const member = await set(
      sharedThreadMember$,
      owner.orgId,
      owner.userId,
      signal,
    );
    if (!member) {
      return null;
    }
    const current = await set(readSharedThreadPolicy$, row, signal);
    if (
      (row.hasArtifactSnapshot && !current) ||
      (current && current.policy.status !== "active")
    ) {
      return null;
    }
    return {
      row,
      current,
      organization: { id: owner.orgId, name: member.organization.name },
    };
  },
);

export const readSharedThreadVisibility$ = command(
  async ({ set }, owner: Owner, signal: AbortSignal) => {
    const owned = await set(ownedSharedThreadVisibility$, owner, signal);
    if (!owned) {
      return null;
    }
    const policy = owned.current?.policy;
    return {
      id: owned.row.id,
      audience:
        owned.row.hasArtifactSnapshot && policy
          ? sharedThreadPolicyAudience(policy)
          : ("public" as const),
      revision: policy?.version === 2 ? policy.revision : null,
      organization: owned.organization,
    };
  },
);

export const updateSharedThreadVisibility$ = command(
  async (
    { get, set },
    args: Owner & {
      readonly audience: SharedThreadAudience;
      readonly expectedRevision: string | null;
    },
    signal: AbortSignal,
  ) => {
    const owned = await set(ownedSharedThreadVisibility$, args, signal);
    if (!owned) {
      return { kind: "not-found" } as const;
    }
    if (
      args.audience !== "public" &&
      Object.values(owned.row.messageAttachments).some((attachments) => {
        return attachments?.some((attachment) => {
          return (
            URL.canParse(attachment.url) &&
            new URL(attachment.url).pathname.startsWith(
              `/shared-threads/${owned.row.id}/`,
            )
          );
        });
      })
    ) {
      return { kind: "public-attachments" } as const;
    }
    const previous = owned.current?.policy;
    if (
      (previous?.version === 2 ? previous.revision : null) !==
      args.expectedRevision
    ) {
      return { kind: "conflict" } as const;
    }
    const policy = sharedThreadArtifactPolicySchema.parse({
      ...(previous ?? {
        threadId: owned.row.id,
        ownerId: args.userId,
        orgId: args.orgId,
        publicBrand: storedLinkLayoutSegment(owned.row.linkLayoutSegment),
        status: "active",
        resources: {},
      }),
      version: 2,
      audience: args.audience,
      revision: randomUUID(),
    });
    const written = await settle(
      get(
        writeArtifactSharePolicyObject(
          sharedThreadArtifactsBucket(),
          sharedThreadArtifactPolicyKey(policy.publicBrand, policy.threadId),
          JSON.stringify(policy),
          owned.current?.etag ?? null,
          signal,
        ),
      ),
      signal,
    );
    if (!written.ok) {
      if (
        written.error instanceof Error &&
        written.error.name === "PreconditionFailed"
      ) {
        return { kind: "conflict" } as const;
      }
      throw written.error;
    }
    // Legacy text-only shares need the same policy-read marker as resource
    // shares. Acknowledge only after both authorities fail closed for old APIs.
    const [updated] = await set(writeDb$)
      .update(sharedThreads)
      .set({ hasArtifactSnapshot: true })
      .where(
        and(
          eq(sharedThreads.id, args.id),
          eq(sharedThreads.userId, args.userId),
          eq(sharedThreads.orgId, args.orgId),
        ),
      )
      .returning({ id: sharedThreads.id });
    signal.throwIfAborted();
    if (!updated) {
      await set(
        removeSharedThreadArtifactCopies$,
        { ...owned.row, hasArtifactSnapshot: true },
        signal,
      );
      return { kind: "not-found" } as const;
    }
    return {
      kind: "updated",
      body: {
        id: updated.id,
        audience: args.audience,
        revision: policy.version === 2 ? policy.revision : null,
        organization: owned.organization,
      },
    } as const;
  },
);
