import { parseMessageTarget } from "../../../lib/command/message-target";

export type TeamsDestination =
  | { readonly conversationId: string; readonly activityId?: string }
  | { readonly user: string };

export function isTeamsUserId(id: string): boolean {
  return id.startsWith("29:");
}

/**
 * Conversation IDs (19:…) post into that conversation; user IDs (29:… or
 * me) open a personal conversation, which cannot carry a thread reply.
 */
export function resolveTeamsDestination(
  to: string,
  replyTo: string | undefined,
): TeamsDestination {
  const target = parseMessageTarget(to, isTeamsUserId);
  if (target.kind === "chat") {
    return {
      conversationId: target.id,
      ...(replyTo ? { activityId: replyTo } : {}),
    };
  }
  if (replyTo) {
    throw new Error("--reply-to requires a conversation --to target", {
      cause: new Error("Thread replies require an existing Teams conversation"),
    });
  }
  return { user: target.kind === "me" ? "me" : target.id };
}
