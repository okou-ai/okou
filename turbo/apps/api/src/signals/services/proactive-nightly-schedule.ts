import type { ProactiveScheduleOwner } from "./proactive-member-preferences.service";
import { proactiveScheduleOwnerHash } from "./proactive-cadence";

/** Spread Learning starts across the first half-hour after 02:00 local time. */
export function proactiveNightlyCron(owner: ProactiveScheduleOwner) {
  return `${proactiveScheduleOwnerHash(owner) % 30} 2 * * *`;
}
