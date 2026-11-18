import {
  normalizeRunFailureReason,
  type KnownRunFailureReason,
  type RunFailureReasonToken,
} from "@okouai/api-contracts/contracts/run-failure-reasons";
import { publicProviderBalanceFailureReason } from "@okouai/api-contracts/contracts/run-balance-errors";

/** Public terminal facts exclude platform-owned provider balance failures. */
export function publicRunFailureReason(
  status: string,
  failureReason: RunFailureReasonToken | null | undefined,
  modelProviderType?: string | null,
): KnownRunFailureReason | undefined {
  if (status !== "failed" && status !== "timeout") {
    return undefined;
  }
  const reason = normalizeRunFailureReason(failureReason);
  return reason === "provider_insufficient_credits"
    ? normalizeRunFailureReason(
        publicProviderBalanceFailureReason(modelProviderType),
      )
    : reason;
}
