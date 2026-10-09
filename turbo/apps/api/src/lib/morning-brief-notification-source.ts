import {
  MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY,
  MORNING_BRIEF_OFFICIAL_DEFINITION_NAME,
} from "@okouai/api-contracts/contracts/morning-brief-preference";
import type { AgentRunOfficialWorkflowProvenance } from "@okouai/db/jsonb-contracts/agent-run-session-conversation";

interface NotificationOwner {
  readonly orgId: string;
  readonly userId: string;
}

interface NotificationRunSource {
  readonly workflowAutomationId: string | null;
  readonly officialWorkflowProvenance: AgentRunOfficialWorkflowProvenance | null;
}

interface MorningBriefAutomationSource {
  readonly automationId: string;
  readonly automationOrgId: string;
  readonly automationOwnerUserId: string;
  readonly workflowOrgId: string;
  readonly workflowOwnerUserId: string;
  readonly officialDefinitionName: string | null;
  readonly officialBlueprintKey: string | null;
}

/** Authorize the purpose from server-owned origin, not mounted skills or labels. */
export function isMorningBriefNotificationSource(
  owner: NotificationOwner,
  run: NotificationRunSource,
  source: MorningBriefAutomationSource | undefined,
): boolean {
  return (
    source !== undefined &&
    run.workflowAutomationId === source.automationId &&
    source.automationOrgId === owner.orgId &&
    source.automationOwnerUserId === owner.userId &&
    source.workflowOrgId === owner.orgId &&
    source.workflowOwnerUserId === owner.userId &&
    source.officialDefinitionName === MORNING_BRIEF_OFFICIAL_DEFINITION_NAME &&
    source.officialBlueprintKey === MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY &&
    run.officialWorkflowProvenance !== null &&
    run.officialWorkflowProvenance.definitions.some((definition) => {
      return definition.name === MORNING_BRIEF_OFFICIAL_DEFINITION_NAME;
    })
  );
}
