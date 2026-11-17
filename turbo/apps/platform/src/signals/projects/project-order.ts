import { command, computed } from "ccstate";
import { chatThreadOnlyArchived$ } from "../chat-page/chat-thread-only-archived.ts";
import { chatThreadOnlyUnread$ } from "../chat-page/chat-thread-only-unread.ts";
import { chatThreadOnlyMuted$ } from "../chat-page/chat-thread-only-muted.ts";
import { projects$, projectsEnabled$, reorderProject$ } from "./projects.ts";

export const projectReorderEnabled$ = computed((get) => {
  return (
    get(projectsEnabled$) &&
    !get(chatThreadOnlyUnread$) &&
    !get(chatThreadOnlyArchived$) &&
    !get(chatThreadOnlyMuted$)
  );
});

export const stepProject$ = command(
  async (
    { get, set },
    projectId: string,
    direction: -1 | 1,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    if (!get(projectReorderEnabled$)) {
      return;
    }
    const projects = get(projects$);
    const index = projects.findIndex((project) => {
      return project.id === projectId;
    });
    if (index === -1) {
      return;
    }
    const target = projects[index + direction];
    if (target) {
      await set(
        reorderProject$,
        projectId,
        target.id,
        direction < 0 ? "before" : "after",
        signal,
      );
    }
  },
);
