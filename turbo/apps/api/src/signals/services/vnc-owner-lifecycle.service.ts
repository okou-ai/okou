import { vncConnections } from "@okouai/db/schema/vnc-connection";
import { vncCredentials } from "@okouai/db/schema/vnc-credential";
import { and, asc, eq, sql } from "drizzle-orm";

import { command } from "ccstate";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { pgTextDecoder } from "../../lib/db-structured-result";
import {
  clerk$,
  isClerkResourceNotFound,
  type ClerkClient,
} from "../external/clerk";
import { writeDb$ } from "../external/db";
import { settle } from "../utils";
import { loadCurrentMembershipId } from "./morning-brief-membership.service";

export interface VncOwner {
  readonly orgId: string;
  readonly userId: string;
}

/** Deleted external identities deny access; dependency failures stay visible. */
export async function hasCurrentVncMembership(
  clerk: ClerkClient,
  owner: VncOwner,
  signal: AbortSignal,
): Promise<boolean> {
  const result = await settle(
    loadCurrentMembershipId(clerk, owner, signal),
    signal,
  );
  if (result.ok) {
    return result.value !== null;
  }
  if (!isClerkResourceNotFound(result.error)) {
    throw result.error;
  }
  return false;
}

type VncCleanupScope =
  | { readonly kind: "user"; readonly userId: string }
  | { readonly kind: "organization"; readonly orgId: string }
  | (VncOwner & { readonly kind: "owner" });

/** Capture a real member row before the live Clerk lookup. Cleanup removes it. */
export const admitVncOwner$ = command(
  async (
    { get, set },
    owner: VncOwner,
    signal: AbortSignal,
  ): Promise<{
    readonly owner: VncOwner;
    readonly memberCreatedAt: string;
  } | null> => {
    const db = set(writeDb$);
    await db.insert(orgMembersMetadata).values(owner).onConflictDoNothing();
    signal.throwIfAborted();
    const [member] = await db
      .select({
        createdAt: sql`${orgMembersMetadata.createdAt}::text`.mapWith(
          pgTextDecoder,
        ),
      })
      .from(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, owner.orgId),
          eq(orgMembersMetadata.userId, owner.userId),
        ),
      );
    signal.throwIfAborted();
    if (
      !member ||
      !(await hasCurrentVncMembership(get(clerk$), owner, signal))
    ) {
      return null;
    }
    return { owner, memberCreatedAt: member.createdAt };
  },
);

export function vncMemberIdentityWhere(args: {
  readonly owner: VncOwner;
  readonly memberCreatedAt: string;
}) {
  return and(
    eq(orgMembersMetadata.orgId, args.owner.orgId),
    eq(orgMembersMetadata.userId, args.owner.userId),
    eq(sql`${orgMembersMetadata.createdAt}::text`, args.memberCreatedAt),
  );
}

/** Erasure and the existing member identity disappear in one local commit. */
export const eraseVncOwnerData$ = command(
  async (
    { set },
    scope: VncCleanupScope,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const memberCondition =
      scope.kind === "user"
        ? eq(orgMembersMetadata.userId, scope.userId)
        : scope.kind === "organization"
          ? eq(orgMembersMetadata.orgId, scope.orgId)
          : and(
              eq(orgMembersMetadata.orgId, scope.orgId),
              eq(orgMembersMetadata.userId, scope.userId),
            );
    const connectionCondition =
      scope.kind === "user"
        ? eq(vncConnections.userId, scope.userId)
        : scope.kind === "organization"
          ? eq(vncConnections.orgId, scope.orgId)
          : and(
              eq(vncConnections.orgId, scope.orgId),
              eq(vncConnections.userId, scope.userId),
            );
    const credentialCondition =
      scope.kind === "user"
        ? eq(vncCredentials.userId, scope.userId)
        : scope.kind === "organization"
          ? eq(vncCredentials.orgId, scope.orgId)
          : and(
              eq(vncCredentials.orgId, scope.orgId),
              eq(vncCredentials.userId, scope.userId),
            );
    await db.transaction(async (tx) => {
      await tx
        .select({ orgId: orgMembersMetadata.orgId })
        .from(orgMembersMetadata)
        .where(memberCondition)
        .orderBy(asc(orgMembersMetadata.orgId), asc(orgMembersMetadata.userId))
        .for("update");
      await tx
        .select({ id: vncConnections.id })
        .from(vncConnections)
        .where(connectionCondition)
        .orderBy(asc(vncConnections.id))
        .for("update");
      await tx
        .select({ id: vncCredentials.id })
        .from(vncCredentials)
        .where(credentialCondition)
        .orderBy(asc(vncCredentials.id))
        .for("update");
      await tx.delete(vncConnections).where(connectionCondition);
      await tx.delete(vncCredentials).where(credentialCondition);
      // This is the existing preference-row lifecycle, not a new authority flag.
      // A late admission must match the captured exact database timestamp; it
      // cannot create this parent after its external membership lookup.
      await tx.delete(orgMembersMetadata).where(memberCondition);
      signal.throwIfAborted();
    });
  },
);
