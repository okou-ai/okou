import type { BrowserClerk } from "@clerk/shared/types";
import { computed } from "ccstate";
import { chatThreadMetadataContract } from "@okouai/api-contracts/client/chat-threads";
import { accept } from "../../lib/accept.ts";
import { apiClient$, type ApiClientFactory } from "../api-client.ts";
import { authenticatedSessionKey$, clerk$, currentOrgInfo$ } from "../auth.ts";
import { chatActionIdMatches } from "../chat-page/chat-action-context.ts";
import type { PermissionActionOwner } from "../chat-page/permission-action-owner.ts";

function assertPermissionMember(
  clerk: BrowserClerk,
  owner: PermissionActionOwner,
) {
  if (
    !clerk.session ||
    clerk.user?.id !== owner.userId ||
    clerk.organization?.id !== owner.orgId
  ) {
    throw new Error(
      "Permission request belongs to a different workspace member",
    );
  }
}

export function memberPermissionClientOptions(
  clerk: BrowserClerk,
  owner: PermissionActionOwner,
) {
  return {
    getTokenGuard: () => {
      return () => {
        assertPermissionMember(clerk, owner);
      };
    },
  };
}

export async function verifyPermissionCallbackThread(
  createClient: ApiClientFactory,
  threadId: string,
  signal?: AbortSignal,
) {
  const result = await accept(
    createClient(chatThreadMetadataContract).get({
      params: { id: threadId },
      fetchOptions: { signal },
    }),
    [200],
    signal,
  );
  if (!chatActionIdMatches(result.body.id, threadId)) {
    throw new Error("Permission callback thread does not match");
  }
}

export function permissionActionTarget(
  owner: PermissionActionOwner,
  threadId: string | null,
) {
  return computed(async (get) => {
    get(authenticatedSessionKey$);
    if (threadId) {
      await verifyPermissionCallbackThread(get(apiClient$), threadId);
    }
    const [clerk, org] = await Promise.all([get(clerk$), get(currentOrgInfo$)]);
    assertPermissionMember(clerk, owner);
    if (!org || org.id !== owner.orgId) {
      throw new Error("Permission workspace does not match");
    }
    return {
      id: JSON.stringify([owner.orgId, owner.userId]),
      displayName: org.name,
      avatarUrl: org.hasImage ? org.imageUrl : null,
    };
  });
}
