import {
  PROACTIVE_SUGGESTIONS_BLUEPRINT_KEY,
  PROACTIVE_SUGGESTIONS_DEFINITION_NAME,
} from "@okouai/api-contracts/contracts/proactive-suggestions";
import {
  PROACTIVE_LEARNING_BLUEPRINT_KEY,
  PROACTIVE_LEARNING_DEFINITION_NAME,
} from "@okouai/api-contracts/contracts/proactive-nightly";

// Retained identities stop installed schedules without deleting their history.
export const RETIRED_PROACTIVE_DEFINITION_NAMES = [
  "proactive-action",
  "proactive-planning",
  "proactive-jobs",
] as const;

export const PROACTIVE_WORKFLOW_DEFINITIONS = {
  suggestions: {
    name: PROACTIVE_SUGGESTIONS_DEFINITION_NAME,
    blueprintKey: PROACTIVE_SUGGESTIONS_BLUEPRINT_KEY,
  },
  learning: {
    name: PROACTIVE_LEARNING_DEFINITION_NAME,
    blueprintKey: PROACTIVE_LEARNING_BLUEPRINT_KEY,
  },
} as const;

export function proactiveWorkflowKind(name: string | null) {
  if (name === PROACTIVE_LEARNING_DEFINITION_NAME) {
    return "learning" as const;
  }
  return name === PROACTIVE_SUGGESTIONS_DEFINITION_NAME
    ? ("suggestions" as const)
    : null;
}

export function isRetiredProactiveWorkflow(name: string | null) {
  return RETIRED_PROACTIVE_DEFINITION_NAMES.some((retired) => {
    return retired === name;
  });
}
