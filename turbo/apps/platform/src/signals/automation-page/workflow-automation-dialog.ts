import { command, computed, state } from "ccstate";

type WorkflowAutomationDialogIntent =
  "automation" | "automation-chat" | "workflow";

const workflowAutomationDialogOpenState$ = state(false);
const workflowAutomationDialogIntentState$ =
  state<WorkflowAutomationDialogIntent>("automation");

export const workflowAutomationDialogOpen$ = computed((get) => {
  return get(workflowAutomationDialogOpenState$);
});

export const workflowAutomationDialogIntent$ = computed((get) => {
  return get(workflowAutomationDialogIntentState$);
});

export const setWorkflowAutomationDialogOpen$ = command(
  ({ set }, open: boolean) => {
    set(workflowAutomationDialogOpenState$, open);
    if (open) {
      set(workflowAutomationDialogIntentState$, "automation");
    }
  },
);

export const openCreateWorkflowDialog$ = command(({ set }) => {
  set(workflowAutomationDialogOpenState$, true);

  set(workflowAutomationDialogIntentState$, "workflow");
});

export const startCreateWorkflowFromAutomationDialog$ = command(({ set }) => {
  set(workflowAutomationDialogIntentState$, "automation-chat");
});
