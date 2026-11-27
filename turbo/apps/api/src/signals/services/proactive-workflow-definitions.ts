import { MORNING_BRIEF_OFFICIAL_DEFINITION_NAMES } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { PROACTIVE_SUGGESTIONS_DEFINITION_NAME } from "@okouai/api-contracts/contracts/proactive-suggestions";
import { PROACTIVE_LEARNING_DEFINITION_NAME } from "@okouai/api-contracts/contracts/proactive";

// Retained identities stop installed schedules without deleting their history.
const RETIRED_PROACTIVE_DEFINITION_NAMES = [
  "proactive-action",
  "proactive-planning",
  "proactive-jobs",
] as const;

/** These installed identities are historical. A user's Workflow may have the same name. */
export const LEGACY_PROACTIVE_WORKFLOW_NAMES = [
  ...MORNING_BRIEF_OFFICIAL_DEFINITION_NAMES,
  PROACTIVE_SUGGESTIONS_DEFINITION_NAME,
  PROACTIVE_LEARNING_DEFINITION_NAME,
  ...RETIRED_PROACTIVE_DEFINITION_NAMES,
] as const;

export function isLegacyProactiveWorkflow(definitionName: string | null) {
  return LEGACY_PROACTIVE_WORKFLOW_NAMES.some((name) => {
    return name === definitionName;
  });
}
