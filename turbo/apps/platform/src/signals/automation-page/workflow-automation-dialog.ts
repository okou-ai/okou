import { command, computed, state } from "ccstate";

type WorkflowAutomationDialogIntent =
  "automation" | "automation-chat" | "workflow";

const workflowAutomationDialogOpenState$ = state(false);
const selectedWorkflowAutomationAgentIdState$ = state("");
const workflowAutomationAgentQueryState$ = state("");
const workflowAutomationAgentSelectionLockedState$ = state(false);
const workflowAutomationDialogIntentState$ =
  state<WorkflowAutomationDialogIntent>("automation");

export const workflowAutomationDialogOpen$ = computed((get) => {
  return get(workflowAutomationDialogOpenState$);
});

export const selectedWorkflowAutomationAgentId$ = computed((get) => {
  return get(selectedWorkflowAutomationAgentIdState$);
});

export const workflowAutomationAgentQuery$ = computed((get) => {
  return get(workflowAutomationAgentQueryState$);
});

export const workflowAutomationAgentSelectionLocked$ = computed((get) => {
  return get(workflowAutomationAgentSelectionLockedState$);
});

export const workflowAutomationDialogIntent$ = computed((get) => {
  return get(workflowAutomationDialogIntentState$);
});

export const setWorkflowAutomationDialogOpen$ = command(
  ({ set }, open: boolean) => {
    set(workflowAutomationDialogOpenState$, open);
    if (open) {
      set(selectedWorkflowAutomationAgentIdState$, "");
      set(workflowAutomationAgentQueryState$, "");
      set(workflowAutomationAgentSelectionLockedState$, false);
      set(workflowAutomationDialogIntentState$, "automation");
    }
  },
);

export const openCreateWorkflowDialog$ = command(({ set }) => {
  set(workflowAutomationDialogOpenState$, true);
  set(selectedWorkflowAutomationAgentIdState$, "");
  set(workflowAutomationAgentQueryState$, "");
  set(workflowAutomationAgentSelectionLockedState$, false);
  set(workflowAutomationDialogIntentState$, "workflow");
});

export const startCreateWorkflowFromAutomationDialog$ = command(({ set }) => {
  set(selectedWorkflowAutomationAgentIdState$, "");
  set(workflowAutomationAgentQueryState$, "");
  set(workflowAutomationAgentSelectionLockedState$, false);
  set(workflowAutomationDialogIntentState$, "automation-chat");
});

export const setWorkflowAutomationAgentQuery$ = command(
  ({ set }, query: string) => {
    set(workflowAutomationAgentQueryState$, query);
  },
);
