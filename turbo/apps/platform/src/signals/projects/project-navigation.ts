import { toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../../i18n/index.ts";
import { projects$ } from "./projects.ts";
import { expandProject$ } from "./project-expansion.ts";
import { showChatSidebar$ } from "../okou-page/nav.ts";
import { command, computed } from "ccstate";
import { pathParams$ } from "../route.ts";
import { activeRoute$ } from "../active-route.ts";
import { setChatThreadArchivedFilter$ } from "../okou-page/chat-thread-filter.ts";
/** The Project whose page is open. */
export const selectedProjectId$ = computed((get) => {
  const id =
    get(activeRoute$) === "project" ? get(pathParams$)?.projectId : null;
  return typeof id === "string" ? id : null;
});

export const locateProject$ = command(({ get, set }, projectId: string) => {
  const project = get(projects$).find((item) => {
    return item.id === projectId;
  });
  if (!project) {
    toast.error(
      i18n.t(($) => {
        return $.projects.unavailable;
      }),
    );
    return;
  }
  if (project.archivedAt) {
    // A mention reveals its archived parent without navigating away from
    // the conversation that contains it.
    set(setChatThreadArchivedFilter$);
  }
  set(expandProject$, projectId);
  set(showChatSidebar$);
});
