import { command, computed, state } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../external/feature-switch.ts";
import {
  createWorkflowRecommendationSignals,
  type WorkflowRecommendationActions,
} from "./composer-workflow-recommendations.ts";
import type {
  ComposerCreateMode,
  ComposerCreateSignals,
} from "./composer-create.ts";
import { createComposerVisualizationSignals } from "./composer-visualization.ts";
import { onRef } from "../utils.ts";
import { observeRail, type RailTravel } from "./rail-travel.ts";

export type ComposerTask =
  | ComposerCreateMode
  | "workflow"
  | "website"
  | "visualization";
export type ComposerIdeaTask = Exclude<ComposerTask, "visualization">;
/** The tasks whose ideas render as a prompt row; workflow has its own surface. */
export type ComposerPromptRowTask = Exclude<ComposerIdeaTask, "workflow">;
/**
 * The tasks served by the shared cover shelf. Presentation has ideas but not
 * this shelf: its catalog carries uploaded decks and an import tile, so it
 * builds its own row.
 */
export type ComposerTemplateTask = Exclude<
  ComposerPromptRowTask,
  "presentation"
>;

/** A general task owns the chip row itself; the rest resolve to a create mode. */
function isComposerGeneralTask(
  task: ComposerTask | null,
): task is "workflow" | "website" | "visualization" {
  return task === "workflow" || task === "website" || task === "visualization";
}

export function createComposerTaskChipsSignals(
  create: ComposerCreateSignals,
  workflowActions: WorkflowRecommendationActions,
) {
  const enabled$ = computed((get) => {
    return get(featureSwitch$)[FeatureSwitchKey.ComposerTaskChips];
  });
  const internalGeneralTask$ = state<
    "workflow" | "website" | "visualization" | null
  >(null);
  const visualization = createComposerVisualizationSignals();
  /**
   * What the composer is on, as the footer chip states it. A create mode is
   * named by the slash panel as well as by this row, and the chip is how both
   * rollouts state it, so it carries the create mode's own switch. A general
   * task has only this row's panels to open into, so it waits for the chips.
   */
  const task$ = computed((get): ComposerTask | null => {
    return (
      get(create.mode$) ?? (get(enabled$) ? get(internalGeneralTask$) : null)
    );
  });
  const workflowVisible$ = computed((get) => {
    return get(task$) === "workflow";
  });
  const workflows = createWorkflowRecommendationSignals(
    workflowVisible$,
    workflowActions,
  );
  const applyTask$ = command(({ set }, task: ComposerTask | null) => {
    set(workflows.close$);
    if (task === null || isComposerGeneralTask(task)) {
      set(internalGeneralTask$, task);
      set(create.setMode$, null);
      return;
    }
    set(internalGeneralTask$, null);
    set(create.selectCommand$, task);
  });
  /**
   * The chip row toggles: choosing the task already showing clears it. The
   * footer chip and the composer's Backspace clear the same way, and they
   * stand wherever a task does, so this reads the create mode's switch rather
   * than the row's own.
   */
  const selectTask$ = command(({ get, set }, task: ComposerTask | null) => {
    if (!get(create.enabled$)) {
      return;
    }
    set(applyTask$, get(task$) === task ? null : task);
  });
  /**
   * Opens a task without the chip's toggle. A caller outside the row states
   * what the member has just started rather than pressing the chip, so
   * repeating it has to leave the surface the last one opened standing.
   *
   * A create mode is its own surface and carries the slash panel's own switch,
   * so it opens whether or not the chips are on. A general task has only the
   * chip row to live in, so there it waits for that switch.
   */
  const openTask$ = command(({ get, set }, task: ComposerTask) => {
    if (get(task$) === task) {
      return;
    }
    if (isComposerGeneralTask(task) && !get(enabled$)) {
      return;
    }
    set(applyTask$, task);
  });
  /**
   * How far a rail can still travel, per rail. A rail that has never reported
   * is assumed to fit, which hides both pagers until a measurement proves
   * otherwise.
   */
  const internalRailTravel$ = state<Readonly<Record<string, RailTravel>>>({});
  const railTravel$ = computed((get) => {
    return get(internalRailTravel$);
  });
  const setRailTravel$ = command(
    ({ get, set }, rail: string, travel: RailTravel) => {
      const current = get(internalRailTravel$)[rail];
      if (
        current?.canScrollBack === travel.canScrollBack &&
        current.canScrollForward === travel.canScrollForward
      ) {
        return;
      }
      set(internalRailTravel$, { ...get(internalRailTravel$), [rail]: travel });
    },
  );
  /** Owns one row's DOM lifecycle; the observers report what layout knows. */
  const bindRail$ = onRef(
    command(({ set }, element: HTMLElement, signal: AbortSignal) => {
      const rail = element.dataset.rail;
      if (!rail) {
        return;
      }
      observeRail(element, signal, (travel) => {
        set(setRailTravel$, rail, travel);
      });
    }),
  );
  return {
    enabled$,
    task$,
    selectTask$,
    openTask$,
    railTravel$,
    setRailTravel$,
    bindRail$,
    workflows,
    visualization,
  };
}

export type ComposerTaskChipsSignals = ReturnType<
  typeof createComposerTaskChipsSignals
>;
