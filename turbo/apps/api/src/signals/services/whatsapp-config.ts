import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command } from "ccstate";
import { env, optionalEnv } from "../../lib/env";
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

export const whatsappFileUploadEnabled$ = command(
  async ({ set }, orgId: string, userId: string, signal: AbortSignal) => {
    return isFeatureEnabled(
      FeatureSwitchKey.WhatsappFileUpload,
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

export function isWhatsappSupportedHandle(handle: string): boolean {
  const prefixes = env("WHATSAPP_ALLOWED_COUNTRY_PREFIXES");
  return (
    prefixes.length === 0 ||
    prefixes.some((prefix) => {
      return handle.startsWith(prefix);
    })
  );
}
