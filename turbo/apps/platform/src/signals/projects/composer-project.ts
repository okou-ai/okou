import { command, computed, type Command, type Computed } from "ccstate";

import { detachedNavigateTo$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { unconfirmedProjectIds$ } from "./projects.ts";

/**
 * Which Project a new chat starts in, as the composer shows and changes it.
 *
 * The page decides the Project: a Project's page starts its chats inside it,
 * the home composer outside any. Choosing another Project
 * opens that Project's page, and leaving one returns to the new-chat page.
 * Both pages share the workspace draft, so the message comes along,
 * and the left column marks the destination the way it marks any page.
 */
export interface ComposerProjectSignals {
  /** The Project a message sent from here starts its chat in. */
  readonly projectId: string | null;
  /** Whether this composer can pick a Project. */
  readonly available$: Computed<Promise<boolean>>;
  /**
   * The Project was created a moment ago and the server has not persisted it
   * yet, so a chat cannot start inside it.
   */
  readonly pending$: Computed<boolean>;
  /** Start this chat in another Project, or `null` for none. */
  readonly select$: Command<void, [string | null, AbortSignal]>;
}

export function createComposerProjectSignals(
  projectId: string | null,
): ComposerProjectSignals {
  return {
    projectId,
    available$: computed(() => {
      return Promise.resolve(true);
    }),
    pending$: computed((get) => {
      return projectId !== null && get(unconfirmedProjectIds$).has(projectId);
    }),
    select$: command(({ set }, next: string | null, signal: AbortSignal) => {
      signal.throwIfAborted();
      if (next === projectId) {
        return;
      }
      if (next === null) {
        set(detachedNavigateTo$, ROUTES.home);
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
