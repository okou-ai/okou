import { command, computed, state } from "ccstate";
import { delay } from "signal-timers";
import type { AgentPhoneLinkCodeResponse } from "@okouai/api-contracts/contracts/integrations-agentphone";
import { now } from "../../lib/time.ts";
import {
  agentPhoneLinkStatus$,
  createAgentPhoneLinkCode$,
} from "../okou-page/agentphone.ts";
import { detach, Reason, resetSignal } from "../utils.ts";

/** Transport lifecycle belongs to the promise; these are the domain outcomes. */
type OnboardingPhoneCode =
  | { readonly kind: "unavailable" }
  | { readonly kind: "expired" }
  | { readonly kind: "ready"; readonly code: AgentPhoneLinkCodeResponse };

const internalPhoneCode$ = state<Promise<AgentPhoneLinkCodeResponse | null>>(
  Promise.resolve(null),
);
const internalPhoneCodeExpired$ = state(false);
const resetPhoneCodeSignal$ = resetSignal();

export const onboardingPhoneCode$ = computed(
  async (get): Promise<OnboardingPhoneCode> => {
    const expired = get(internalPhoneCodeExpired$);
    const code = await get(internalPhoneCode$);
    if (!code) {
      return { kind: "unavailable" };
    }
    return expired ? { kind: "expired" } : { kind: "ready", code };
  },
);

const expireOnboardingPhoneCode$ = command(
  async ({ set }, expiresAt: string, signal: AbortSignal): Promise<void> => {
    await delay(Math.max(0, Date.parse(expiresAt) - now()), { signal });
    signal.throwIfAborted();
    set(internalPhoneCodeExpired$, true);
  },
);

const loadOnboardingPhoneCode$ = command(
  async (
    { get, set },
    signal: AbortSignal,
  ): Promise<AgentPhoneLinkCodeResponse | null> => {
    const status = await get(agentPhoneLinkStatus$);
    signal.throwIfAborted();
    if (status.linked || !status.configured || !status.agentPhoneNumber) {
      return null;
    }
    const code = await set(createAgentPhoneLinkCode$, signal);
    signal.throwIfAborted();
    if (Date.parse(code.expiresAt) <= now()) {
      set(internalPhoneCodeExpired$, true);
    } else {
      detach(
        set(expireOnboardingPhoneCode$, code.expiresAt, signal),
        Reason.Daemon,
        "onboarding phone code expiry",
      );
    }
    return code;
  },
);

/** Retry replaces the promise and cancels the previous route-owned attempt. */
export const requestOnboardingPhoneCode$ = command(
  async ({ set }, parentSignal: AbortSignal): Promise<void> => {
    const signal = set(resetPhoneCodeSignal$, parentSignal);
    set(internalPhoneCodeExpired$, false);
    const promise = set(loadOnboardingPhoneCode$, signal);
    set(internalPhoneCode$, promise);
    await promise;
  },
);

/** Start the non-blocking route-owned generation; the view observes its loadable. */
export const enterOnboardingPhoneCode$ = command(
  ({ set }, signal: AbortSignal): Promise<void> => {
    detach(
      set(requestOnboardingPhoneCode$, signal),
      Reason.Daemon,
      "onboarding phone code creation",
    );
    return Promise.resolve();
  },
);
