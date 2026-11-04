import type { ProactiveWorkflowOwner } from "./proactive-workflows-eligibility.service";
import { officialScheduleOwnerHash } from "./official-workflow-owner-schedule";

/** Spread Learning starts across the first half-hour after 02:00 local time. */
export function proactiveNightlyCron(owner: ProactiveWorkflowOwner) {
  return `${officialScheduleOwnerHash(owner) % 30} 2 * * *`;
}
