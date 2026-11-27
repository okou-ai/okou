import { computed, type Computed } from "ccstate";
import type { HostedSiteShareAccount } from "@okouai/api-contracts/contracts/hosted-site-sharing";
import { clerk$, type ClerkUser } from "../external/clerk";

function account(
  user: ClerkUser,
  requestedEmail?: string,
): HostedSiteShareAccount | null {
  if (user.banned) {
    return null;
  }
  const address = user.emailAddresses.find((entry) => {
    return (
      entry.verification?.status === "verified" &&
      (requestedEmail === undefined
        ? entry.id === user.primaryEmailAddressId
        : entry.emailAddress.trim().toLowerCase() === requestedEmail)
    );
  });
  return address
    ? {
        userId: user.id,
        email: address.emailAddress.trim().toLowerCase(),
        name: [user.firstName, user.lastName].filter(Boolean).join(" ") || null,
      }
    : null;
}

interface WorkspaceAccountLookup {
  readonly orgId: string;
  readonly query?: string;
  readonly emailAddress?: string[];
  readonly userId?: string[];
}

/** Resolve profiles only after the current organization's live membership filter. */
export function hostedSiteWorkspaceAccounts(
  input$: Computed<WorkspaceAccountLookup | Promise<WorkspaceAccountLookup>>,
) {
  return computed(async (get) => {
    const { orgId, ...filter } = await get(input$);
    const client = get(clerk$);
    const members = await client.organizations.getOrganizationMembershipList({
      organizationId: orgId,
      ...filter,
      limit: 10,
    });
    const memberIds = new Set(
      members.data.flatMap((member) => {
        return member.organization.id === orgId && member.publicUserData
          ? [member.publicUserData.userId]
          : [];
      }),
    );
    if (memberIds.size === 0) {
      return [];
    }
    const users = await client.users.getUserList({
      userId: [...memberIds],
      limit: 10,
    });
    return users.data.flatMap((user) => {
      const candidate = memberIds.has(user.id)
        ? account(user, filter.emailAddress?.[0])
        : null;
      const query = filter.query?.toLowerCase();
      const matches =
        !query ||
        [candidate?.name, candidate?.email, user.username].some((value) => {
          return value?.toLowerCase().includes(query);
        });
      return candidate && matches ? [candidate] : [];
    });
  });
}
