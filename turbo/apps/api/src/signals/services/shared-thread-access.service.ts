import { command } from "ccstate";
import {
  sharedThreadPolicyAudience,
  type SharedThreadArtifactPolicy,
} from "@okouai/api-contracts/contracts/shared-thread-artifacts";
import { clerk$, isClerkResourceNotFound } from "../external/clerk";
import { settle } from "../utils";

// Like artifact shares, recipients belong to the original organization, not
// necessarily the organization currently selected in their browser.
export const sharedThreadMember$ = command(
  async ({ get }, orgId: string, userId: string, signal: AbortSignal) => {
    const membership = await settle(
      get(clerk$).organizations.getOrganizationMembershipList(
        { organizationId: orgId, userId: [userId], limit: 1 },
        undefined,
        signal,
      ),
      signal,
    );
    if (!membership.ok) {
      if (isClerkResourceNotFound(membership.error)) {
        return null;
      }
      throw membership.error;
    }
    return (
      membership.value.data.find((member) => {
        return member.publicUserData?.userId === userId;
      }) ?? null
    );
  },
);

export const canReadSharedThreadPolicy$ = command(
  async (
    { set },
    policy: SharedThreadArtifactPolicy,
    viewerId: string | undefined,
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (policy.status !== "active") {
      return false;
    }
    const audience = sharedThreadPolicyAudience(policy);
    if (audience === "public") {
      return true;
    }
    if (!viewerId || (audience === "private" && viewerId !== policy.ownerId)) {
      return false;
    }
    return (
      (await set(sharedThreadMember$, policy.orgId, viewerId, signal)) !== null
    );
  },
);
