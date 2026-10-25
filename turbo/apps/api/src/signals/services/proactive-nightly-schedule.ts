import type { ProactiveWorkflowOwner } from "./proactive-workflows-eligibility.service";
import { officialScheduleOwnerHash } from "./official-workflow-owner-schedule";

type ProactiveNightlyKind = "learning" | "planning";

/** Independent nightly schedules keep a two-hour nominal gap in the member's timezone. */
export function proactiveNightlyCron(
  kind: ProactiveNightlyKind,
  owner: ProactiveWorkflowOwner,
) {
  return `${officialScheduleOwnerHash(owner) % 30} ${kind === "learning" ? 2 : 4} * * *`;
}
