import { createHash } from "node:crypto";
import {
  isMorningBriefDefinitionName,
  MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY,
} from "@okouai/api-contracts/contracts/morning-brief-preference";
import type {
  OfficialWorkflowAcceptedBlueprint,
  OfficialWorkflowParameterBinding,
} from "@okouai/api-contracts/contracts/official-workflow-catalog";

interface OfficialScheduleOwner {
  readonly orgId: string;
  readonly userId: string;
}

/** Morning Brief Blueprint parameter whose value is derived from its owner. */
const MORNING_BRIEF_CRON_PARAMETER = "cron";

/**
 * Stable per-owner shard shared by Official schedules. Proactive Suggestions
 * repeats the same digest in SQL to page its owners by minute.
 */
export function officialScheduleOwnerHash(owner: OfficialScheduleOwner) {
  return Number.parseInt(
    createHash("sha256")
      .update(`${owner.orgId}/${owner.userId}`)
      .digest("hex")
      .slice(0, 8),
    16,
  );
}

/**
 * Morning Brief starts at a stable owner minute from 06:30 to 06:59 local time,
 * so briefs arrive by 07:00 without every owner in a time zone starting at the
 * same instant. The 15-minute shift keeps it at least 15 minutes away from the
 * owner's hourly Proactive Suggestions minute in whole-hour time zones.
 */
function morningBriefCronExpression(owner: OfficialScheduleOwner) {
  const minute = 30 + ((officialScheduleOwnerHash(owner) + 15) % 30);
  return `${minute} 6 * * *`;
}

/**
 * The Morning Brief start time is never a stored member choice: installation
 * and reconciliation both derive it from the owner, so existing installations
 * move to their own minute without a data migration. Blueprints that do not
 * declare the parameter keep their bindings unchanged.
 */
export function withMorningBriefCronBinding(args: {
  readonly definitionName: string;
  readonly blueprint: Pick<
    OfficialWorkflowAcceptedBlueprint,
    "key" | "parameters"
  >;
  readonly owner: OfficialScheduleOwner;
  readonly bindings: readonly OfficialWorkflowParameterBinding[];
}): OfficialWorkflowParameterBinding[] {
  if (
    !isMorningBriefDefinitionName(args.definitionName) ||
    args.blueprint.key !== MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY ||
    !args.blueprint.parameters.some((parameter) => {
      return parameter.key === MORNING_BRIEF_CRON_PARAMETER;
    })
  ) {
    return [...args.bindings];
  }
  return [
    ...args.bindings.filter((binding) => {
      return binding.key !== MORNING_BRIEF_CRON_PARAMETER;
    }),
    {
      key: MORNING_BRIEF_CRON_PARAMETER,
      value: morningBriefCronExpression(args.owner),
    },
  ];
}
