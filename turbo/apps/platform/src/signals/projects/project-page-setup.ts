import { command } from "ccstate";
import { toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../../i18n/index.ts";
import { projects$, hydrateProjects$ } from "./projects.ts";
import { expandProject$ } from "./project-expansion.ts";
import { selectedProjectId$ } from "./project-navigation.ts";
import { currentChatAgentId$ } from "../agent-chat.ts";
import { navigateTo$, searchParams$ } from "../route.ts";
import { rootSignal$ } from "../root-signal.ts";

// Project URLs are deep links into the chat list; Projects have no separate page.
export const setupProjectPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    await set(hydrateProjects$, signal);
    const projectId = get(selectedProjectId$);
    const available = get(projects$).some((project) => {
      return project.id === projectId;
    });
    if (projectId && available) {
      set(expandProject$, projectId, { ifUnset: true });
    } else {
      toast.error(
        i18n.t(($) => {
          return $.projects.unavailable;
        }),
      );
    }
    const agentId = await get(currentChatAgentId$);
    signal.throwIfAborted();
    const params = new URLSearchParams(get(searchParams$));
    if (projectId && available) {
      params.set("project", projectId);
    }
    // Navigation ends this route's lifetime and belongs to the app root.
    await set(
      navigateTo$,
      agentId ? "/agents/:agentId/chat" : "/agents",
      {
        pathParams: agentId ? { agentId } : undefined,
        searchParams: params,
        replace: true,
      },
      get(rootSignal$),
    );
  },
);
