export const ACTIVE_ALLOWANCE_STATUSES = [
  "active",
  "manual_active",
  "trialing",
  "past_due",
  "unpaid",
] as const;

const PAYMENT_FAILED_ALLOWANCE_STATUSES = ["past_due", "unpaid"] as const;
const PAYMENT_FAILURE_ALLOWANCE_GRACE_MS = 24 * 60 * 60 * 1000;

export function activeAllowanceCutoff(status: string, now: Date): Date {
  const paymentFailed = PAYMENT_FAILED_ALLOWANCE_STATUSES.some((candidate) => {
    return candidate === status;
  });
  return paymentFailed
    ? new Date(now.getTime() - PAYMENT_FAILURE_ALLOWANCE_GRACE_MS)
    : now;
}
