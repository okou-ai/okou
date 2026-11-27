import { command } from "ccstate";
import { sql } from "drizzle-orm";
import { proactiveDispatchHandoff } from "@okouai/db/schema/proactive-schedule";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import {
  PROACTIVE_SUGGESTIONS_BLUEPRINT_KEY,
  PROACTIVE_SUGGESTIONS_DEFINITION_NAME,
} from "@okouai/api-contracts/contracts/proactive-suggestions";
import {
  PROACTIVE_LEARNING_BLUEPRINT_KEY,
  PROACTIVE_LEARNING_DEFINITION_NAME,
} from "@okouai/api-contracts/contracts/proactive";
import {
  isMorningBriefDefinitionName,
  MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY,
} from "@okouai/api-contracts/contracts/morning-brief-preference";
import { writeDb$ } from "../external/db";

export const proactiveDispatchPhase$ = command(
  async ({ set }, signal: AbortSignal) => {
    const [handoff] = await set(writeDb$)
      .select({ phase: proactiveDispatchHandoff.phase })
      .from(proactiveDispatchHandoff);
    signal.throwIfAborted();
    if (!handoff) {
      throw new Error("Missing proactive dispatch handoff");
    }
    return handoff.phase;
  },
);

export function legacyProactiveInstallation(
  definition: string | null,
  blueprint: string | null,
) {
  return (
    (isMorningBriefDefinitionName(definition) &&
      blueprint === MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY) ||
    (definition === PROACTIVE_SUGGESTIONS_DEFINITION_NAME &&
      blueprint === PROACTIVE_SUGGESTIONS_BLUEPRINT_KEY) ||
    (definition === PROACTIVE_LEARNING_DEFINITION_NAME &&
      blueprint === PROACTIVE_LEARNING_BLUEPRINT_KEY)
  );
}

/** Fence the built-in installation at claim time, including claims selected by an earlier tick. */
export function legacyProactiveClaimAllowed() {
  return sql`(NOT EXISTS (
    SELECT 1 FROM workflows official WHERE official.id = ${workflowAutomations.workflowId}
    AND ${workflowAutomations.kind}='schedule' AND ${workflowAutomations.scheduleType}='cron'
    AND official.visibility = 'private' AND official.org_id = ${workflowAutomations.orgId}
    AND official.owner_user_id = ${workflowAutomations.ownerUserId}
    AND (official.official_definition_name, ${workflowAutomations.officialBlueprintKey}) IN
      (('morning-brief','daily-delivery'),('internal-test-morning-brief','daily-delivery'),
       ('agent-suggestions','hourly-check'),('proactive-learning','nightly-learning'))
  ) OR EXISTS (SELECT 1 FROM proactive_dispatch_handoff WHERE phase = 'automation' FOR SHARE))`;
}
