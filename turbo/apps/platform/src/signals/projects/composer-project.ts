import { command, computed, type Command, type Computed } from "ccstate";
import { defaultAgentId$ } from "../agent.ts";
import { navigateToAgentChat$ } from "../okou-page/agent-chat-navigation.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { projectsEnabled$ } from "./projects.ts";

/**
 * Which Project a new chat starts in, as the composer shows and changes it.
 *
 * The page decides the Project: a Project's page starts its chats inside it,
 * the default Agent's new-chat page outside any. Choosing another Project
 * opens that Project's page, and leaving one returns to the new-chat page.
 * Both pages compose the default Agent's draft, so the message comes along,
 * and the left column marks the destination the way it marks any page.
 */
export interface ComposerProjectSignals {
  /** The Project a message sent from here starts its chat in. */
  readonly projectId: string | null;
  /**
   * Project chats belong to the default Agent, so only its new chat can pick
   * one; another Agent's composer keeps its menu as it was.
   */
  readonly available$: Computed<Promise<boolean>>;
  /** Start this chat in another Project, or `null` for none. */
  readonly select$: Command<void, [string | null]>;
}

export function createComposerProjectSignals(
  agentId: string,
  projectId: string | null,
): ComposerProjectSignals {
  return {
    projectId,
    available$: computed(async (get) => {
      if (!get(projectsEnabled$)) {
        return false;
      }
      return agentId === (await get(defaultAgentId$));
    }),
    select$: command(({ set }, next: string | null) => {
      if (next === projectId) {
        return;
      }
      if (next === null) {
        set(navigateToAgentChat$, agentId);
        return;
      }
      set(detachedNavigateTo$, ROUTES.project, {
        pathParams: { projectId: next },
      });
    }),
  };
}

const unavailable$ = computed(() => {
  return Promise.resolve(false);
});

/** Whether a composer, which may not belong to a new chat, can pick a Project. */
export function composerProjectAvailable(
  project: ComposerProjectSignals | undefined,
): Computed<Promise<boolean>> {
  return project?.available$ ?? unavailable$;
}
