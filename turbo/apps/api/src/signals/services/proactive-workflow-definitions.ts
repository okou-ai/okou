import {
  PROACTIVE_ACTION_BLUEPRINT_KEY,
  PROACTIVE_ACTION_DEFINITION_NAME,
} from "@okouai/api-contracts/contracts/proactive-action";
import {
  PROACTIVE_SUGGESTIONS_BLUEPRINT_KEY,
  PROACTIVE_SUGGESTIONS_DEFINITION_NAME,
} from "@okouai/api-contracts/contracts/proactive-suggestions";

export const PROACTIVE_WORKFLOW_DEFINITIONS = {
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
  if (name === PROACTIVE_ACTION_DEFINITION_NAME) {
    return "action" as const;
  }
  return name === PROACTIVE_SUGGESTIONS_DEFINITION_NAME
    ? ("suggestions" as const)
    : null;
}
