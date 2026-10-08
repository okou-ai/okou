import { computed } from "ccstate";

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
    const mutedAgents = new Set(
      unreadIds.flatMap((id) => {
        const thread = metadata.get(id);
        return thread?.muted ? [thread.agentId] : [];
      }),
    );
    const unmutedAgents = new Set(
      unreadIds.flatMap((id) => {
        const thread = metadata.get(id);
        return thread && !thread.muted ? [thread.agentId] : [];
      }),
    );
    return new Set(
      Object.entries(indicators.agents).flatMap(([agentId, indicator]) => {
        const suppressed =
          !hasUnknownThread &&
          mutedAgents.has(agentId) &&
          !unmutedAgents.has(agentId);
        return indicator === "unread" && !suppressed ? [agentId] : [];
      }),
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
