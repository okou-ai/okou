/** The cutoff is strictly older than thirty minutes; equality is still due. */
export const SCHEDULE_GRACE_MS = 30 * 60_000;

export function scheduleExpired(anchor: Date, at: Date): boolean {
  return anchor.getTime() < at.getTime() - SCHEDULE_GRACE_MS;
}
