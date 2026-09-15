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

export type ComposerTask =
  | ComposerCreateMode
  | "workflow"
  | "website"
  | "visualization";
export type ComposerIdeaTask = Exclude<
  ComposerTask,
  "presentation" | "visualization"
>;
/** The idea tasks whose catalog carries cover art, so they get a cover shelf. */
export type ComposerTemplateTask = Exclude<ComposerIdeaTask, "workflow">;

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
   * The rows are a two-way pager, not a shuffle: the last page does not wrap
   * back to the first, so `‹` and `›` can say truthfully whether there is
   * anything in that direction. `nextIdeas$` above keeps its wrap because the
   * workflow row is still a single "more" button rather than a pager.
   */
  const stepIdeaPage$ = command(
    ({ get, set }, task: ComposerIdeaTask, step: number, pageCount: number) => {
      const pages = get(internalIdeaPages$);
      set(internalIdeaPages$, {
        ...pages,
        [task]: Math.min(Math.max(pages[task] + step, 0), pageCount - 1),
      });
    },
  );
  const internalTemplatePages$ = state({ image: 0, video: 0, website: 0 });
  const templatePages$ = computed((get) => {
    return get(internalTemplatePages$);
  });
  const stepTemplatePage$ = command(
    (
      { get, set },
      task: ComposerTemplateTask,
      step: number,
      pageCount: number,
    ) => {
      const pages = get(internalTemplatePages$);
      set(internalTemplatePages$, {
        ...pages,
        [task]: Math.min(Math.max(pages[task] + step, 0), pageCount - 1),
      });
    },
  );
  return {
    enabled$,
    task$,
    selectTask$,
    ideaPages$,
    nextIdeas$,
    stepIdeaPage$,
    templatePages$,
    stepTemplatePage$,
    workflows,
    visualization,
  };
}

export type ComposerTaskChipsSignals = ReturnType<
  typeof createComposerTaskChipsSignals
>;
