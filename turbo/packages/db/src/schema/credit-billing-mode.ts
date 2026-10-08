/** Admission-time credit ownership. NULL columns denote legacy provenance. */
export const CREDIT_BILLING_MODES = ["org", "member_pack"] as const;
export type CreditBillingMode = (typeof CREDIT_BILLING_MODES)[number];
