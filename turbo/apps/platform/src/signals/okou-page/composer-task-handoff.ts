import { command, state } from "ccstate";
import type { PresentationSlideCount } from "./composer-create.ts";
import type { ComposerSignals } from "./composer-signals.ts";
import type { ComposerTask } from "./composer-task-chips.ts";
import type {
  ComposerVisualizationSignals,
  VisualizationPreferences,
  VisualizationSubmission,
} from "./composer-visualization.ts";

/**
 * The sticky task and retained parameters for the next draft.
 *
 * A send from the start page opens a different composer, so it receives the
 * next draft's selection rather than reading parameters from the sent message.
 */
export interface ComposerTaskSelection {
  readonly task: ComposerTask | null;
  readonly presentationSlideCount: PresentationSlideCount;
  readonly visualization: VisualizationPreferences;
  readonly visualizationSubmission?: {
    readonly source: ComposerVisualizationSignals;
    readonly snapshot: VisualizationSubmission;
  };
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
 * Applies the next draft's selection to the thread composer, once, through
 * the same commands the controls use.
 */
export const adoptComposerTaskHandoff$ = command(
  ({ get, set }, threadId: string, composer: ComposerSignals): void => {
    const pending = get(pendingSelection$);
    if (pending === null || pending.threadId !== threadId) {
      return;
    }
    set(pendingSelection$, null);
    const { task, presentationSlideCount, visualizationSubmission } =
      pending.selection;
    const visualization = visualizationSubmission
      ? get(visualizationSubmission.source.preferences$)
      : pending.selection.visualization;
    if (task === null) {
      return;
    }
    // The task chips own the three general tasks and gate them on their own
    // switch; a create mode is also what a slash command leaves behind when
    // the chips are off.
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
      if (
        visualizationSubmission &&
        get(visualizationSubmission.source.revision$) ===
          visualizationSubmission.snapshot.revision
      ) {
        const target = composer.taskChips.visualization;
        set(
          visualizationSubmission.source.registerHandoff$,
          visualizationSubmission.snapshot,
          {
            revision: get(target.revision$),
            clearIfUnchanged$: target.clearIfUnchanged$,
          },
        );
      }
    }
  },
);
