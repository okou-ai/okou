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

/** What a row reports after laying out: whether either pager has anywhere to go. */
export interface RailTravel {
  readonly canScrollBack: boolean;
  readonly canScrollForward: boolean;
}

/** How far the rail can still travel in each direction, right now. */
export function measureRail(element: HTMLElement): RailTravel {
  // A scroll position is fractional under zoom, so a whole pixel of slack
  // keeps a rail that is visually at its end from claiming otherwise.
  const remaining =
    element.scrollWidth - element.clientWidth - element.scrollLeft;
  return {
    canScrollBack: element.scrollLeft > 1,
    canScrollForward: remaining > 1,
  };
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
  const task$ = computed((get): ComposerTask | null => {
    if (!get(enabled$) || get(create.choosing$)) {
      return null;
    }
    return get(create.mode$) ?? get(internalGeneralTask$);
  });
  const workflowVisible$ = computed((get) => {
    return get(task$) === "workflow";
  });
  const workflows = createWorkflowRecommendationSignals(
    workflowVisible$,
    workflowActions,
  );
  const selectTask$ = command(({ get, set }, task: ComposerTask | null) => {
    if (!get(enabled$)) {
      return;
    }
    set(workflows.close$);
    const next = get(task$) === task ? null : task;
    set(
      internalGeneralTask$,
      next === "workflow" || next === "website" || next === "visualization"
        ? next
        : null,
    );
    if (
      next === null ||
      next === "workflow" ||
      next === "website" ||
      next === "visualization"
    ) {
      set(create.setMode$, null);
    } else {
      set(create.selectCommand$, next);
    }
  });
  const internalIdeaPages$ = state({
    image: 0,
    workflow: 0,
    video: 0,
    website: 0,
    presentation: 0,
  });
  const ideaPages$ = computed((get) => {
    return get(internalIdeaPages$);
  });
  const nextIdeas$ = command(
    ({ get, set }, task: ComposerIdeaTask, pageCount: number) => {
      const pages = get(internalIdeaPages$);
      set(internalIdeaPages$, {
        ...pages,
        [task]: (pages[task] + 1) % pageCount,
      });
    },
  );
  /**
   * How far a rail can still travel, per rail. A rail packs its items
   * continuously and pages by one visible width, so how many fit on a page is
   * a layout outcome rather than a constant; only the row itself can report
   * it. A rail that has never reported is assumed to fit, which hides both
   * pagers until the first measurement proves otherwise.
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
  /**
   * Owns one row's DOM lifecycle. The row reports its own travel because only
   * layout knows it: the rail's width and its items' widths both move the end,
   * and neither is settled until the browser has laid them out. The size
   * observer covers a resized column and an item that changes width; the child
   * observer covers a catalog that finishes loading after the row mounted, such
   * as a presentation shelf's uploaded decks.
   */
  const bindRail$ = onRef(
    command(({ set }, element: HTMLElement, signal: AbortSignal) => {
      const rail = element.dataset.rail;
      if (!rail) {
        return;
      }
      const report = () => {
        set(setRailTravel$, rail, measureRail(element));
      };
      const size = new ResizeObserver(report);
      const observeAll = () => {
        size.disconnect();
        size.observe(element);
        for (const child of element.children) {
          size.observe(child);
        }
        report();
      };
      observeAll();
      const children = new MutationObserver(observeAll);
      children.observe(element, { childList: true });
      signal.addEventListener("abort", () => {
        size.disconnect();
        children.disconnect();
      });
    }),
  );
  return {
    enabled$,
    task$,
    selectTask$,
    ideaPages$,
    nextIdeas$,
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
