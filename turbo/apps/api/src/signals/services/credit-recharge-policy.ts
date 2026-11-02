import type { AutoRechargeConfig } from "@okouai/api-contracts/contracts/billing";

export const AUTO_RECHARGE_FAILURE_LIMIT = 3;

export function autoRechargeConfigFromOrg(org: {
  readonly autoRechargeEnabled: boolean;
  readonly autoRechargeThreshold: number | null;
  readonly autoRechargeAmount: number | null;
  readonly autoRechargeFailureCount: number;
}): AutoRechargeConfig {
  const disabled =
    !org.autoRechargeEnabled &&
    org.autoRechargeFailureCount >= AUTO_RECHARGE_FAILURE_LIMIT;
  return {
    enabled: org.autoRechargeEnabled,
    threshold: org.autoRechargeThreshold,
    amount: org.autoRechargeAmount,
    ...(disabled ? { disabledReason: "consecutive_failures" as const } : {}),
  };
}
