import type { ClerkClient } from "../external/clerk";

/**
 * The member's current Clerk membership generation.
 *
 * Ordinary request authentication may answer from the 60-second role cache, and
 * `org_members_cache` is a read-through cache rather than a tombstone, so any
 * path that acts on a member's behalf repeats this exact-member lookup and pins
 * the immutable membership id. A removal and rejoin issues a new id, which is
 * what stops a new membership from speaking for work the old one started.
 *
 * Shared by the Morning Brief collection executor and the shared connector
 * reader so both admit on the same authority.
 */
export async function loadCurrentMembershipId(
  clerk: ClerkClient,
  owner: { readonly orgId: string; readonly userId: string },
  signal: AbortSignal,
): Promise<string | null> {
  const memberships = await clerk.organizations.getOrganizationMembershipList(
    { organizationId: owner.orgId, userId: [owner.userId], limit: 1 },
    undefined,
    signal,
  );
  signal.throwIfAborted();
  const membership = memberships.data.find((entry) => {
    return (
      entry.publicUserData?.userId === owner.userId &&
      entry.organization.id === owner.orgId
    );
  });
  return membership?.id ?? null;
}
