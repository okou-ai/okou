import { toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../../i18n/index.ts";
import { projects$ } from "./projects.ts";
import { expandProject$ } from "./project-expansion.ts";
import { showChatSidebar$ } from "../okou-page/nav.ts";
import { command, computed } from "ccstate";
import { pathParams$, searchParams$ } from "../route.ts";
import { activeRoute$ } from "../active-route.ts";
export const selectedProjectId$ = computed((get) => {
  const id =
    get(activeRoute$) === "project"
      ? get(pathParams$)?.projectId
      : get(searchParams$).get("project");
  return typeof id === "string" ? id : null;
});

export const locateProject$ = command(({ get, set }, projectId: string) => {
  if (
    !get(projects$).some((project) => {
      return project.id === projectId;
    })
  ) {
    toast.error(
      i18n.t(($) => {
        return $.projects.unavailable;
      }),
    );
    return;
  }
  set(expandProject$, projectId);
  set(showChatSidebar$);
});
