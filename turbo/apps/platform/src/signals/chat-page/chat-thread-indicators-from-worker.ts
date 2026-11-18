import { computed } from "ccstate";

import { currentChatAgentId$ } from "../agent-chat.ts";
import { chatThreadIndicatorsFromWorker$ } from "../shared-database.ts";
import { eventDrivenChatThreads$ } from "./chat-thread-event-sourcing.ts";

export const unreadAgentIds$ = computed(
  async (get): Promise<ReadonlySet<string>> => {
    const indicators = await get(chatThreadIndicatorsFromWorker$);
    const metadata = new Map(
      get(eventDrivenChatThreads$).map((thread) => {
        return [thread.id, thread];
      }),
    );
    const unreadIds = Object.entries(indicators.threads)
      .filter(([, indicator]) => {
        return indicator === "unread";
      })
      .map(([id]) => {
        return id;
      });
    const hasUnknownThread = unreadIds.some((id) => {
      return !metadata.has(id);
    });
    const suppressedAgents = new Set(
      unreadIds.flatMap((id) => {
        const thread = metadata.get(id);
        return thread && (thread.muted || thread.archived)
          ? [thread.agentId]
          : [];
      }),
    );
    const attentionAgents = new Set(
      unreadIds.flatMap((id) => {
        const thread = metadata.get(id);
        return thread && !thread.muted && !thread.archived
          ? [thread.agentId]
          : [];
      }),
    );
    return new Set(
      Object.entries(indicators.agents).flatMap(([agentId, indicator]) => {
        const suppressed =
          !hasUnknownThread &&
          suppressedAgents.has(agentId) &&
          !attentionAgents.has(agentId);
        return indicator === "unread" && !suppressed ? [agentId] : [];
      }),
    );
  },
);

export const currentChatAgentHasUnread$ = computed(
  async (get): Promise<boolean> => {
    const [agentId, indicators, unreadAgentIds] = await Promise.all([
      get(currentChatAgentId$),
      get(chatThreadIndicatorsFromWorker$),
      get(unreadAgentIds$),
    ]);
    // Explicit read actions still apply to archived unread chats.
    return (
      agentId !== null &&
      (unreadAgentIds.has(agentId) ||
        get(eventDrivenChatThreads$).some((thread) => {
          return (
            thread.agentId === agentId &&
            !thread.muted &&
            indicators.threads[thread.id] === "unread"
          );
        }))
    );
  },
);

export const sidebarActiveThreadIds$ = computed(
  async (get): Promise<ReadonlySet<string>> => {
    const indicators = await get(chatThreadIndicatorsFromWorker$);
    return new Set(
      Object.entries(indicators.threads).flatMap(([threadId, indicator]) => {
        return indicator === "active" ? [threadId] : [];
      }),
    );
  },
);
