import { command, computed } from "ccstate";
import { chatThreadFilter$ } from "../okou-page/chat-thread-filter.ts";
import { projects$, reorderProject$ } from "./projects.ts";

export const projectReorderEnabled$ = computed((get) => {
  return get(chatThreadFilter$) === "unarchived";
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
    signal.throwIfAborted();
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
