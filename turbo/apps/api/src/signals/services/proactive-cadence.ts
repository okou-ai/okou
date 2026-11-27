import { createHash } from "node:crypto";
import type { ProactiveScheduleOwner } from "./proactive-member-preferences.service";

/** All three platform schedules retain their original per-member minute. */
export function proactiveScheduleOwnerHash(owner: ProactiveScheduleOwner) {
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
export function morningBriefCronExpression(owner: ProactiveScheduleOwner) {
  const minute = 30 + ((proactiveScheduleOwnerHash(owner) + 15) % 30);
  return `${minute} 6 * * *`;
}

/** Suggestions is sharded by owner in UTC, including owners without a timezone. */
export function hourlySuggestionsCron(owner: ProactiveScheduleOwner) {
  return `${proactiveScheduleOwnerHash(owner) % 60} * * * *`;
}
