import { env } from "../../lib/env";

/** The cutoff is strictly older than thirty minutes; equality is still due. */
export const SCHEDULE_GRACE_MS = 30 * 60_000;

/** Off until the compatible API fleet has drained and rollout is approved. */
export function scheduleExpiryEnabled(): boolean {
  return env("WORKFLOW_SCHEDULE_EXPIRY_ENABLED") === "true";
}

export function scheduleExpired(anchor: Date, at: Date): boolean {
  return anchor.getTime() < at.getTime() - SCHEDULE_GRACE_MS;
}
