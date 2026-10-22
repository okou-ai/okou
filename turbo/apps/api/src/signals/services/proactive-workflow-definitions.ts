import {
  PROACTIVE_ACTION_BLUEPRINT_KEY,
  PROACTIVE_ACTION_DEFINITION_NAME,
} from "@okouai/api-contracts/contracts/proactive-action";
import {
  PROACTIVE_SUGGESTIONS_BLUEPRINT_KEY,
  PROACTIVE_SUGGESTIONS_DEFINITION_NAME,
} from "@okouai/api-contracts/contracts/proactive-suggestions";
import {
  PROACTIVE_JOBS_BLUEPRINT_KEY,
  PROACTIVE_JOBS_DEFINITION_NAME,
} from "@okouai/api-contracts/contracts/proactive-jobs";

export const PROACTIVE_WORKFLOW_DEFINITIONS = {
  jobs: {
    name: PROACTIVE_JOBS_DEFINITION_NAME,
    blueprintKey: PROACTIVE_JOBS_BLUEPRINT_KEY,
  },
  suggestions: {
    name: PROACTIVE_SUGGESTIONS_DEFINITION_NAME,
    blueprintKey: PROACTIVE_SUGGESTIONS_BLUEPRINT_KEY,
  },
  action: {
    name: PROACTIVE_ACTION_DEFINITION_NAME,
    blueprintKey: PROACTIVE_ACTION_BLUEPRINT_KEY,
  },
} as const;

export function proactiveWorkflowKind(name: string | null) {
  if (name === PROACTIVE_JOBS_DEFINITION_NAME) {
    return "jobs" as const;
  }
  if (name === PROACTIVE_ACTION_DEFINITION_NAME) {
    return "action" as const;
  }
  return name === PROACTIVE_SUGGESTIONS_DEFINITION_NAME
    ? ("suggestions" as const)
    : null;
}
