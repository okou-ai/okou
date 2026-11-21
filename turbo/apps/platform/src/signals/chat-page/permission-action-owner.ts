import {
  chatActionIdMatches,
  type ChatActionContext,
} from "./chat-action-context.ts";

// Keep Agent links readable until supported clients and saved approvals no longer need them.
// Retirement is tracked in https://github.com/okou-ai/okou/issues/45476.
export type PermissionActionOwner =
  | { readonly kind: "agent"; readonly agentId: string }
  | {
      readonly kind: "member";
      readonly orgId: string;
      readonly userId: string;
    };

export function memberPermissionOwner(
  params: URLSearchParams,
): PermissionActionOwner | null {
  const orgIds = params.getAll("orgId");
  const userIds = params.getAll("userId");
  const orgId = orgIds[0];
  const userId = userIds[0];
  if (
    orgIds.length !== 1 ||
    userIds.length !== 1 ||
    !orgId ||
    orgId !== orgId.trim() ||
    !userId ||
    userId !== userId.trim()
  ) {
    return null;
  }
  return { kind: "member", orgId, userId };
}

export function permissionActionOwner(
  url: URL,
  legacyAgentId: string | undefined,
  context: ChatActionContext,
): PermissionActionOwner | null {
  if (legacyAgentId === undefined) {
    return memberPermissionOwner(url.searchParams);
  }
  return context.agentId && chatActionIdMatches(legacyAgentId, context.agentId)
    ? { kind: "agent", agentId: context.agentId }
    : null;
}
