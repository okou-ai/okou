import { command, computed, state } from "ccstate";
import type { DocumentTemplateCategory } from "@okouai/core/document-template-items";
import type { GenerationTemplateRequest } from "@okouai/api-contracts/contracts/chat-threads";
import type { ComposerTemplateAttachment } from "./tiptap-workflow-composer.ts";
import {
  createWorkflowRecommendationSignals,
  type WorkflowRecommendationActions,
} from "./composer-workflow-recommendations.ts";
import type {
  ComposerCreateMode,
  ComposerCreateSignals,
} from "./composer-create.ts";
import { createComposerVisualizationSignals } from "./composer-visualization.ts";
import { onRef, settle } from "../utils.ts";
import { observeRail, type RailTravel } from "./rail-travel.ts";
import { customTemplateCatalog$ } from "./custom-template-library.ts";
import { homeJobSummaries$ } from "./entrusted-jobs.ts";
import { createComposerTaskOverflowSignals } from "./composer-task-overflow.ts";

export type ComposerTask =
  | ComposerCreateMode
  | "workflow"
  | "website"
  | "visualization"
  | "suggestions"
  | "jobs";
export type ComposerIdeaTask = Exclude<
  ComposerTask,
  "visualization" | "suggestions" | "jobs"
>;
/** The tasks whose ideas render as a prompt row; workflow has its own surface. */
export type ComposerPromptRowTask = Exclude<ComposerIdeaTask, "workflow">;
/**
 * The tasks served by the shared cover shelf. Presentation owns its import
 * tile, while Document owns its purpose filters; both build their own rows.
 */
export type ComposerTemplateTask = Exclude<
  ComposerPromptRowTask,
  "presentation" | "document"
>;

/** A general task owns the chip row itself; the rest resolve to a create mode. */
function isComposerGeneralTask(
  task: ComposerTask | null,
): task is "workflow" | "website" | "visualization" | "suggestions" | "jobs" {
  return (
    task === "workflow" ||
    task === "website" ||
    task === "visualization" ||
    task === "suggestions" ||
    task === "jobs"
  );
}

type ComposerDocumentCategory = DocumentTemplateCategory | "custom";

function createDocumentCategorySignals() {
  const internalDocumentCategory$ = state<ComposerDocumentCategory | null>(
    null,
  );
  const defaultDocumentCategory$ = computed(
    async (get): Promise<ComposerDocumentCategory> => {
      const result = await settle(get(customTemplateCatalog$));
      if (!result.ok) {
        // A failed custom catalog must leave the built-in shelf usable.
        return "creative-brief";
      }
      return result.value.some((template) => {
        return template.kind === "document";
      })
        ? "custom"
        : "creative-brief";
    },
  );
  const documentCategory$ = computed((get) => {
    const selected = get(internalDocumentCategory$);
    if (selected !== null) {
      return selected;
    }
    // Resolve the default from the catalog. An explicit choice stops depending
    // on this request, so a late response or refresh cannot replace that choice.
    return get(defaultDocumentCategory$);
  });
  const setDocumentCategory$ = command(
    ({ set }, category: ComposerDocumentCategory) => {
      set(internalDocumentCategory$, category);
    },
  );
  return { documentCategory$, setDocumentCategory$ };
}

function createTaskRailSignals() {
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
  return { railTravel$, setRailTravel$, bindRail$ };
}

export function createComposerTaskChipsSignals(
  create: ComposerCreateSignals,
  workflowActions: WorkflowRecommendationActions,
) {
  const internalGeneralTask$ = state<
    "workflow" | "website" | "visualization" | "suggestions" | "jobs" | null
  >(null);
  const explicitSelection$ = state(false);
  const visualization = createComposerVisualizationSignals();
  const overflow = createComposerTaskOverflowSignals();
  const { documentCategory$, setDocumentCategory$ } =
    createDocumentCategorySignals();
  /** The task selected through the chip row, slash panel or template picker. */
  const task$ = computed((get): ComposerTask | null => {
    return get(create.mode$) ?? get(internalGeneralTask$);
  });
  // Only a shelf that can display custom templates subscribes to the catalog.
  const customTemplates$ = computed(async (get) => {
    const task = get(task$);
    if (task !== "presentation" && task !== "image" && task !== "document") {
      return [];
    }
    return await get(customTemplateCatalog$);
  });
  const workflowVisible$ = computed((get) => {
    return get(task$) === "workflow";
  });
  const workflows = createWorkflowRecommendationSignals(
    workflowVisible$,
    workflowActions,
  );
  const applyTask$ = command(
    ({ set }, task: ComposerTask | null, browsing = false) => {
      set(workflows.close$);
      if (task === null || isComposerGeneralTask(task)) {
        set(internalGeneralTask$, task);
        set(create.setMode$, null, !browsing);
        return;
      }
      set(internalGeneralTask$, null);
      if (browsing) {
        set(create.setMode$, task, false);
      } else {
        set(create.selectCommand$, task);
      }
    },
  );
  /**
   * The chip row toggles: choosing the task already showing clears it. The
   * footer chip and the composer's Backspace clear the same way.
   */
  const selectTask$ = command(({ get, set }, task: ComposerTask | null) => {
    set(explicitSelection$, true);
    set(applyTask$, get(task$) === task ? null : task);
  });
  /**
   * Opens a task without the chip's toggle. A caller outside the row states
   * what the member has just started rather than pressing the chip, so
   * repeating it has to leave the surface the last one opened standing.
   */
  const openTask$ = command(({ get, set }, task: ComposerTask) => {
    set(explicitSelection$, true);
    if (get(task$) === task) {
      return;
    }
    set(applyTask$, task);
  });
  const browseTask$ = command(({ set }, task: ComposerTask) => {
    set(explicitSelection$, true);
    set(applyTask$, task, true);
  });
  const initializeHomeJobs$ = command(
    async ({ get, set }, signal: AbortSignal) => {
      const jobs = await get(homeJobSummaries$);
      signal.throwIfAborted();
      if (
        !get(explicitSelection$) &&
        get(task$) === null &&
        jobs.some((job) => {
          return job.status.startsWith("waiting_") || job.hasUnseenResult;
        })
      ) {
        set(applyTask$, "jobs", true);
      }
    },
  );
  const selectTemplate$ = command(
    (
      { set },
      template: GenerationTemplateRequest,
      attachment: ComposerTemplateAttachment,
      type: GenerationTemplateRequest["type"] = template.type,
    ) => {
      // The picker can leave the category that opened it. Insert before changing
      // tasks because task activation moves the editor selection to the end.
      set(workflowActions.insertTemplate$, template, attachment);
      if (
        type === "presentation" ||
        type === "document" ||
        type === "illustration" ||
        type === "website" ||
        type === "workflow"
      ) {
        set(openTask$, type === "illustration" ? "image" : type);
      } else {
        set(applyTask$, null);
      }
    },
  );
  // Choosing a task hands focus to the composer and removes More. Ordinary
  // dismissal (or browsing Suggestions/Tasks) returns focus to the trigger.
  const taskMenuFinalFocus$ = command(({ get }) => {
    const task = get(task$);
    return task === null || task === "suggestions" || task === "jobs";
  });
  const { railTravel$, setRailTravel$, bindRail$ } = createTaskRailSignals();
  return {
    task$,
    initializeHomeJobs$,
    customTemplates$,
    selectTask$,
    taskMenuFinalFocus$,
    openTask$,
    browseTask$,
    selectTemplate$,
    railTravel$,
    setRailTravel$,
    bindRail$,
    workflows,
    visualization,
    overflow,
    documentCategory$,
    setDocumentCategory$,
  };
}

export type ComposerTaskChipsSignals = ReturnType<
  typeof createComposerTaskChipsSignals
>;
