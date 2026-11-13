import { command, state } from "ccstate";
import { timeout } from "signal-timers";
import { onRef } from "../utils.ts";

interface MountedProjectList {
  readonly animate: (projectId: string, expanded: boolean) => void;
}

const mountedLists$ = state<ReadonlyMap<HTMLElement, MountedProjectList>>(
  new Map(),
);

/**
 * Only an explicit fold may animate row positions. Scrolling must always place
 * newly virtualized rows immediately, including when it interrupts a fold.
 */
export const projectListMotionRef$ = onRef(
  command(({ get, set }, root: HTMLElement, signal: AbortSignal) => {
    const viewport = root.closest<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let revision = 0;
    function stop() {
      revision += 1;
      delete root.dataset.projectFoldMotion;
    }
    const list: MountedProjectList = {
      animate(projectId, expanded) {
        if (
          reducedMotion.matches ||
          !root.querySelector(
            `[data-project-row-id="${CSS.escape(projectId)}"]`,
          )
        ) {
          return;
        }
        revision += 1;
        const currentRevision = revision;
        root.dataset.projectFoldMotion = expanded ? "expand" : "collapse";
        // Match --duration-disclosure's 500ms spring settling window, allowing
        // one frame for the commit.
        // No business state or virtual-list measurement waits for this timer.
        timeout(
          () => {
            if (revision === currentRevision) {
              stop();
            }
          },
          540,
          { signal },
        );
      },
    };
    set(mountedLists$, new Map(get(mountedLists$)).set(root, list));
    viewport?.addEventListener("scroll", stop, { passive: true, signal });
    viewport?.addEventListener("wheel", stop, { passive: true, signal });
    viewport?.addEventListener("touchmove", stop, { passive: true, signal });
    window.addEventListener("resize", stop, { signal });
    reducedMotion.addEventListener("change", stop, { signal });
    signal.addEventListener(
      "abort",
      () => {
        stop();
        const remaining = new Map(get(mountedLists$));
        remaining.delete(root);
        set(mountedLists$, remaining);
      },
      { once: true },
    );
  }),
);

export const animateProjectFold$ = command(
  ({ get }, projectId: string, expanded: boolean) => {
    for (const list of get(mountedLists$).values()) {
      list.animate(projectId, expanded);
    }
  },
);
