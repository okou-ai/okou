import { projects$ } from "../projects/projects.ts";
import { command, computed } from "ccstate";
import { chatThreadMarkAllReadContract } from "@okouai/api-contracts/client/chat-threads";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { chatThreadIndicators$ } from "./chat-thread-indicators.ts";
import { eventDrivenChatThreads$ } from "./chat-thread-event-sourcing.ts";
import { optimisticReadMarks$ } from "./optimistic-chat-thread-read-marks.ts";

/**
 * The server's unread instant for one thread, once optimistic local marks
 * are applied.
 *
 * The server watermark comes from the latest Run terminal marker. Reading it
 * here lets the open thread account for a marker before local catch-up ends.
 */
export function serverUnreadAt$(threadId: string) {
  return computed(async (get): Promise<string | undefined> => {
    const { unreadAt } = await get(chatThreadIndicators$);
    const timestamp = unreadAt[threadId];
    if (timestamp === undefined) {
      return undefined;
    }
    const markedAt = get(optimisticReadMarks$).get(threadId);
    return markedAt === undefined || Date.parse(timestamp) > markedAt
      ? timestamp
      : undefined;
  });
}

export const sidebarUnreadThreadIds$ = computed(
  async (get): Promise<ReadonlySet<string>> => {
    const { unreadAt } = await get(chatThreadIndicators$);
    const marks = get(optimisticReadMarks$);
    const projects = new Map(
      get(projects$).map((project) => {
        return [project.id, project];
      }),
    );
    const threads = new Map(
      get(eventDrivenChatThreads$).map((thread) => {
        return [thread.id, thread];
      }),
    );
    const ids = new Set<string>();
    for (const [threadId, timestamp] of Object.entries(unreadAt)) {
      const markedAt = marks.get(threadId);
      const thread = threads.get(threadId);
      const project = thread?.projectId
        ? projects.get(thread.projectId)
        : undefined;
      if (
        !thread?.muted &&
        !project?.archived &&
        (!project?.lastArchivedAt ||
          Date.parse(timestamp) > Date.parse(project.lastArchivedAt)) &&
        (markedAt === undefined || Date.parse(timestamp) > markedAt)
      ) {
        ids.add(threadId);
      }
    }
    return ids;
  },
);

export const workspaceHasUnreadChats$ = computed(
  async (get): Promise<boolean> => {
    return (await get(sidebarUnreadThreadIds$)).size > 0;
  },
);

export const markWorkspaceThreadsRead$ = command(
  async ({ get }, signal: AbortSignal) => {
    const client = get(apiClient$)(chatThreadMarkAllReadContract);
    await accept(
      client.markAllRead({
        body: {},
        fetchOptions: { signal },
      }),
      [204],
    );
    signal.throwIfAborted();
  },
);
