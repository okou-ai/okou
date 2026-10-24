import {
  PROACTIVE_SUGGESTIONS_BLUEPRINT_KEY,
  PROACTIVE_SUGGESTIONS_DEFINITION_NAME,
} from "@okouai/api-contracts/contracts/proactive-suggestions";
import {
  PROACTIVE_JOBS_BLUEPRINT_KEY,
  PROACTIVE_JOBS_DEFINITION_NAME,
} from "@okouai/api-contracts/contracts/proactive-jobs";
import {
  PROACTIVE_LEARNING_BLUEPRINT_KEY,
  PROACTIVE_LEARNING_DEFINITION_NAME,
  PROACTIVE_PLANNING_BLUEPRINT_KEY,
  PROACTIVE_PLANNING_DEFINITION_NAME,
} from "@okouai/api-contracts/contracts/proactive-nightly";

// Keep the installed identity so admission and reconciliation can retire its
// schedules without deleting workflow or conversation history.
export const RETIRED_PROACTIVE_DEFINITION_NAME = "proactive-action";

export const PROACTIVE_WORKFLOW_DEFINITIONS = {
  jobs: {
    name: PROACTIVE_JOBS_DEFINITION_NAME,
    blueprintKey: PROACTIVE_JOBS_BLUEPRINT_KEY,
  },
  suggestions: {
    name: PROACTIVE_SUGGESTIONS_DEFINITION_NAME,
    blueprintKey: PROACTIVE_SUGGESTIONS_BLUEPRINT_KEY,
  },
  learning: {
    name: PROACTIVE_LEARNING_DEFINITION_NAME,
    blueprintKey: PROACTIVE_LEARNING_BLUEPRINT_KEY,
  },
  planning: {
    name: PROACTIVE_PLANNING_DEFINITION_NAME,
    blueprintKey: PROACTIVE_PLANNING_BLUEPRINT_KEY,
  },
} as const;

export function proactiveWorkflowKind(name: string | null) {
  if (name === PROACTIVE_JOBS_DEFINITION_NAME) {
    return "jobs" as const;
  }
  if (name === PROACTIVE_LEARNING_DEFINITION_NAME) {
    return "learning" as const;
  }
  if (name === PROACTIVE_PLANNING_DEFINITION_NAME) {
    return "planning" as const;
  }
  return name === PROACTIVE_SUGGESTIONS_DEFINITION_NAME
    ? ("suggestions" as const)
    : null;
}
