import { formatRunFailureForExternalSurface } from "@okouai/api-contracts/contracts/errors";
import type { RunFailureReasonToken } from "@okouai/api-contracts/contracts/run-failure-reasons";
import { modelProviderTypeSchema } from "@okouai/api-contracts/contracts/model-providers";

/** Generated compatibility copy; no persisted diagnostic participates. */
export function runFailureMessage(
  status: string,
  failureReason: RunFailureReasonToken | null | undefined,
  modelProviderType?: string | null,
): string | undefined {
  if (status === "cancelled") {
    return "Run cancelled";
  }
  if (status === "timeout") {
    return "Run timed out";
  }
  if (status !== "failed") {
    return undefined;
  }
  const providerType =
    modelProviderTypeSchema.safeParse(modelProviderType).data;
  return formatRunFailureForExternalSurface({
    failureReason,
    modelProviderType: providerType,
    claudeCodeCredentialRecovery: {
      modelProviderType: providerType,
      modelProvidersUrl: undefined,
    },
  });
}
