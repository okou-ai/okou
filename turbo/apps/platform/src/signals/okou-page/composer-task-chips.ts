import { createComposerHomeSignals } from "./composer-home.ts";
import { command, computed, state } from "ccstate";
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
import { customTemplateCatalog$ } from "./custom-template-library.ts";

export type ComposerTask =
  ComposerCreateMode | "workflow" | "website" | "visualization";
/** Presentation and Document build their own template rails. */
export type ComposerTemplateTask = "image" | "website";

/** General tasks do not resolve to a create mode. */
function isComposerGeneralTask(
  task: ComposerTask | null,
): task is "workflow" | "website" | "visualization" {
  return task === "workflow" || task === "website" || task === "visualization";
}

export function createComposerTaskChipsSignals(
  create: ComposerCreateSignals,
  workflowActions: WorkflowRecommendationActions,
) {
  const internalGeneralTask$ = state<
    "workflow" | "website" | "visualization" | null
  >(null);
  const visualization = createComposerVisualizationSignals();
  /** The task selected through a capability, slash panel or template picker. */
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
  const applyTask$ = command(({ set }, task: ComposerTask | null) => {
    set(home.show$);
    if (task === null || isComposerGeneralTask(task)) {
      set(internalGeneralTask$, task);
      set(create.setMode$, null, true);
      return;
    }
    set(internalGeneralTask$, null);
    set(create.selectCommand$, task);
  });
  /** Choosing the active task or clearing it removes the current intent. */
  const selectTask$ = command(({ get, set }, task: ComposerTask | null) => {
    const nextTask = get(task$) === task ? null : task;
    if (nextTask === null) {
      set(workflowActions.clearPrompt$);
    }
    set(applyTask$, nextTask);
  });
  /** Opens a task without toggling an already active intent off. */
  const openTask$ = command(({ get, set }, task: ComposerTask) => {
    set(home.show$);
    if (get(task$) === task) {
      return;
    }
    set(applyTask$, task);
  });
  const home = createComposerHomeSignals(
    task$,
    openTask$,
    selectTask$,
    workflowActions,
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
  return {
    home,
    task$,
    customTemplates$,
    selectTask$,
    openTask$,
    selectTemplate$,
    workflows,
    visualization,
  };
}

export type ComposerTaskChipsSignals = ReturnType<
  typeof createComposerTaskChipsSignals
>;
