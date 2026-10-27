// Settlement planning decides when to alert without loading the email sender.
export const LOW_CREDIT_EMAIL_ALERT_THRESHOLD_CREDITS = 5000;

export interface CreditLowBalanceAlertArgs {
  readonly orgId: string;
  readonly remainingCredits: number;
  readonly thresholdCredits: number;
}
