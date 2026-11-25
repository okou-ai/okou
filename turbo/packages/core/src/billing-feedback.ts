/** PostHog owns questions, targeting, frequency, responses, and launch state. */
export const BILLING_FEEDBACK_SURVEYS = {
  credits_exhausted: "01a20bd6-511f-0000-70b9-87889e169e85",
  upgrade_dismissed: "01a20bd6-5392-0000-848c-57c2b7d65180",
  checkout_canceled: "01a20bd6-55a8-0000-721e-f04ef7abf01c",
} as const;

export type BillingFeedbackKind = keyof typeof BILLING_FEEDBACK_SURVEYS;
