import { command, computed, state } from "ccstate";
import { delay } from "signal-timers";
import type { AgentPhoneLinkCodeResponse } from "@okouai/api-contracts/contracts/integrations-agentphone";
import { now } from "../../lib/time.ts";
import {
  agentPhoneLinkStatus$,
  createAgentPhoneLinkCode$,
} from "../okou-page/agentphone.ts";
import { detach, Reason, resetSignal, tapError } from "../utils.ts";

/** The inline code belongs to this visit, not to the shared connect dialog. */
type OnboardingPhoneCode =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "error" }
  | { readonly kind: "expired" }
  | { readonly kind: "ready"; readonly code: AgentPhoneLinkCodeResponse };

const internalPhoneCode$ = state<OnboardingPhoneCode>({ kind: "loading" });
const resetPhoneCodeSignal$ = resetSignal();

export const onboardingPhoneCode$ = computed((get) => {
  return get(internalPhoneCode$);
});

const expireOnboardingPhoneCode$ = command(
  async ({ set }, expiresAt: string, signal: AbortSignal): Promise<void> => {
    await delay(Math.max(0, Date.parse(expiresAt) - now()), { signal });
    signal.throwIfAborted();
    set(internalPhoneCode$, { kind: "expired" });
  },
);

/** Generate once on entry or explicit retry; replacement cancels the old expiry. */
export const requestOnboardingPhoneCode$ = command(
  async ({ get, set }, parentSignal: AbortSignal): Promise<void> => {
    const signal = set(resetPhoneCodeSignal$, parentSignal);
    set(internalPhoneCode$, { kind: "loading" });
    const status = await tapError(get(agentPhoneLinkStatus$));
    signal.throwIfAborted();
    if (!status) {
      set(internalPhoneCode$, { kind: "error" });
      return;
    }
    if (status.linked || !status.configured || !status.agentPhoneNumber) {
      set(internalPhoneCode$, { kind: "unavailable" });
      return;
    }
    const code = await tapError(set(createAgentPhoneLinkCode$, signal));
    signal.throwIfAborted();
    if (!code) {
      set(internalPhoneCode$, { kind: "error" });
      return;
    }
    if (Date.parse(code.expiresAt) <= now()) {
      set(internalPhoneCode$, { kind: "expired" });
      return;
    }
    set(internalPhoneCode$, { kind: "ready", code });
    detach(
      set(expireOnboardingPhoneCode$, code.expiresAt, signal),
      Reason.Daemon,
      "onboarding phone code expiry",
    );
  },
);
