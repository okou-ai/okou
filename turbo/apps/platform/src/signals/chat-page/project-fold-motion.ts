import { command } from "ccstate";
import { endProjectFold$ } from "../projects/project-expansion.ts";
import { onRef } from "../utils.ts";

/**
 * A chat list mounts a marker after its rows for each Project fold it moves
 * them through. The rows' own transitions are the fold's whole duration, so it
 * ends once they finish, and at once when nothing moves, as under reduced
 * motion or with the Project scrolled away. A later fold remounts the marker,
 * which abandons the earlier wait.
 */
export const endProjectFoldOnRef$ = onRef(
  command(async ({ set }, marker: HTMLElement, signal: AbortSignal) => {
    const id = Number(marker.dataset.projectFoldId);
    const rows = [...(marker.parentElement?.children ?? [])].filter((row) => {
      return row !== marker;
    });
    // Reading the animations resolves the rows' styles, which starts their
    // transitions to the layout this fold just rendered. A row frame animates
    // nothing else.
    const transitions = rows.flatMap((row) => {
      return row.getAnimations();
    });
    // With nothing moving, the rows already rest in the same commit.
    if (transitions.length > 0) {
      await Promise.allSettled(
        transitions.map((transition) => {
          return transition.finished;
        }),
      );
      signal.throwIfAborted();
    }
    set(endProjectFold$, id);
  }),
);
