import { createHash } from "node:crypto";
interface OfficialScheduleOwner {
  readonly orgId: string;
  readonly userId: string;
}

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
export function morningBriefCronExpression(owner: OfficialScheduleOwner) {
  const minute = 30 + ((officialScheduleOwnerHash(owner) + 15) % 30);
  return `${minute} 6 * * *`;
}
