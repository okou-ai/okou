import type { MouseEvent } from "react";
import { toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../../i18n/index.ts";
import { shouldHandleLinkClick } from "../../views/router/link-click.ts";
import { projects$ } from "./projects.ts";
import { expandProject$, toggleProject$ } from "./project-expansion.ts";
import { showChatSidebar$ } from "../okou-page/nav.ts";
import { command, computed } from "ccstate";
import { pathParams$ } from "../route.ts";
import { activeRoute$ } from "../active-route.ts";
/** The Project whose page is open. */
export const selectedProjectId$ = computed((get) => {
  const id =
    get(activeRoute$) === "project" ? get(pathParams$)?.projectId : null;
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

/**
 * A click on a Project's name in the chat list. Elsewhere, the link opens the
 * Project's page and the click unfolds its chats. On that page the click folds
 * or unfolds them instead and cancels the link: navigating to the open page
 * again would push a duplicate history entry and rerun the page's setup.
 */
export const clickProjectName$ = command(
  ({ get, set }, projectId: string, event: MouseEvent<HTMLAnchorElement>) => {
    // A new tab, window or modified click keeps the browser's behaviour.
    if (!shouldHandleLinkClick(event)) {
      return;
    }
    const open = get(selectedProjectId$) === projectId;
    if (open) {
      event.preventDefault();
    }
    // The second click of a rename double-click leaves the fold alone.
    if (event.detail > 1) {
      return;
    }
    if (open) {
      set(toggleProject$, projectId);
    } else {
      set(expandProject$, projectId);
    }
  },
);
