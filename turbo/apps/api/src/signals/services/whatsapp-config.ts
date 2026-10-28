import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command } from "ccstate";
import { optionalEnv } from "../../lib/env";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";
import { isAgentPhoneWhatsappNumberEnabled } from "../external/agentphone-client";

export const whatsappEnabled$ = command(
  async ({ set }, orgId: string, userId: string, signal: AbortSignal) => {
    return isFeatureEnabled(
      FeatureSwitchKey.WhatsappIntegration,
      await set(loadUserFeatureSwitchContext$, orgId, userId, signal),
    );
  },
);

export function whatsappPhoneNumber(): string | null {
  return optionalEnv("AGENTPHONE_PHONE_NUMBER") ?? null;
}

export async function whatsappConfigured(
  signal: AbortSignal,
): Promise<boolean> {
  const number = whatsappPhoneNumber();
  if (
    !number ||
    !optionalEnv("AGENTPHONE_WEBHOOK_SECRET") ||
    !optionalEnv("AGENTPHONE_AGENT_ID") ||
    !optionalEnv("AGENTPHONE_API_BASE_URL") ||
    !optionalEnv("AGENTPHONE_API_KEY")
  ) {
    return false;
  }
  return await isAgentPhoneWhatsappNumberEnabled(number, signal);
}

// Meta's AI-provider markets, updated 2026-10-15. Eligibility follows the
// recipient's country code, not the shared sender's country code.
// https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/ai-providers
const WHATSAPP_AI_MARKET_PREFIXES = [
  "+43",
  "+32",
  "+359",
  "+385",
  "+357",
  "+420",
  "+45",
  "+372",
  "+358",
  "+33",
  "+49",
  "+30",
  "+36",
  "+354",
  "+353",
  "+39",
  "+371",
  "+423",
  "+370",
  "+352",
  "+356",
  "+31",
  "+47",
  "+48",
  "+351",
  "+40",
  "+421",
  "+386",
  "+34",
  "+46",
  "+55",
  "+90",
] as const;

export function isWhatsappSupportedHandle(handle: string): boolean {
  return WHATSAPP_AI_MARKET_PREFIXES.some((prefix) => {
    return handle.startsWith(prefix);
  });
}
