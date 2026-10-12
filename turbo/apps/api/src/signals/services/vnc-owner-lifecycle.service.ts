import { vncConnections } from "@okouai/db/schema/vnc-connection";
import { vncCredentials } from "@okouai/db/schema/vnc-credential";
import { and, count, eq, gte } from "drizzle-orm";

import { command } from "ccstate";
import { isClerkResourceNotFound, type ClerkClient } from "../external/clerk";
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

/** Erase VNC connections before their RESTRICT-referenced credentials. */
export const eraseVncOwnerData$ = command(
  async (
    { set },
    scope: VncCleanupScope,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
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
    const removedConnections = db
      .$with("removed_vnc_connections")
      .as(
        db
          .delete(vncConnections)
          .where(connectionCondition)
          .returning({ id: vncConnections.id }),
      );
    await db
      .with(removedConnections)
      .delete(vncCredentials)
      .where(
        and(
          credentialCondition,
          // Consume the entire child deletion before RESTRICT checks on parents.
          // The aggregate also permits unused credentials when no hosts exist.
          gte(db.select({ count: count() }).from(removedConnections), 0),
        ),
      );
    signal.throwIfAborted();
  },
);
