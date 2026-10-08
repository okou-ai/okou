import type { BillingStatusResponse } from "@okouai/api-contracts/contracts/billing";
import { decodeSandboxTokenPayload } from "../../lib/api/sandbox-token";

export function currentPlanCanBuyCredits(
  billing: BillingStatusResponse,
): boolean {
  return billing.canBuyCredits === true;
}

export function currentTokenCanReadBilling(): boolean {
  const payload = decodeSandboxTokenPayload();
  return payload === undefined || payload.capabilities.includes("billing:read");
}
