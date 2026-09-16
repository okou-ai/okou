import { command, state } from "ccstate";
import type { PresentationSlideCount } from "./composer-create.ts";
import type { ComposerSignals } from "./composer-signals.ts";
import type { ComposerTask } from "./composer-task-chips.ts";
import type { VisualizationPreferences } from "./composer-visualization.ts";

/**
 * What the composer was set to make when it sent a message.
 *
 * The type is composer state rather than message content: inside a thread it
 * survives a send, and the chip that states it stays. A send from the start
 * page ends in a different composer, so that one has to be handed the same
 * selection or the first send reads as having silently cleared it.
 */
export interface ComposerTaskSelection {
  readonly task: ComposerTask | null;
  readonly presentationSlideCount: PresentationSlideCount;
  readonly visualization: VisualizationPreferences;
}

/**
 * One slot. Only the newest send can still be waiting for the thread it
 * created to open, and the composer that opens takes the slot with it.
 */
const pendingSelection$ = state<{
  readonly threadId: string;
  readonly selection: ComposerTaskSelection;
} | null>(null);

/** Names the thread a send just minted as the selection's destination. */
export const rememberComposerTaskForThread$ = command(
  ({ set }, threadId: string, selection: ComposerTaskSelection): void => {
    set(
      pendingSelection$,
      selection.task === null ? null : { threadId, selection },
    );
  },
);

/**
 * Applies the selection to the thread composer, once, through the same
 * commands the controls use, so the thread carries the type and its parameters
 * into every message the user sends next.
 */
export const adoptComposerTaskHandoff$ = command(
  ({ get, set }, threadId: string, composer: ComposerSignals): void => {
    const pending = get(pendingSelection$);
    if (pending === null || pending.threadId !== threadId) {
      return;
    }
    set(pendingSelection$, null);
    const { task, presentationSlideCount, visualization } = pending.selection;
    if (task === null) {
      return;
    }
    // Each surface gates itself on its own switch: the task chips own the
    // three general tasks, and a create mode is also what a slash command
    // leaves behind when the chips are off.
    if (task === "workflow" || task === "website" || task === "visualization") {
      set(composer.taskChips.selectTask$, task);
    } else {
      set(composer.create.setMode$, task);
    }
    if (task === "presentation") {
      set(composer.create.setPresentationSlideCount$, presentationSlideCount);
    }
    if (task === "visualization") {
      if (visualization.output !== null) {
        set(composer.taskChips.visualization.setOutput$, visualization.output);
      }
      for (const chart of visualization.charts) {
        set(composer.taskChips.visualization.toggleChart$, chart);
      }
    }
  },
);
