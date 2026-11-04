import { command, computed, state } from "ccstate";
import { friendReferralCodeSchema } from "@okouai/api-contracts/validators/friend-referrals";
import { friendReferralsContract } from "@okouai/api-contracts/client/friend-referrals";
import { apiClient$ } from "./api-client.ts";
import { clerkUser$ } from "./auth.ts";
import { pageVersion$ } from "./page-signal.ts";
import { localStorageSignals } from "./external/local-storage.ts";
import { accept } from "../lib/accept.ts";
import { writeToClipboard } from "./okou-page/clipboard.ts";
import { resetSignal } from "./utils.ts";
import { historyState$, replaceSearchParams$ } from "./route.ts";

const pendingReferral = localStorageSignals("friend_referral_visit");
const pendingReferralCode = localStorageSignals("friend_referral_code");
const resetReferralVisit$ = resetSignal();
export const signupFriendReferralCode$ = computed((get) => {
  return get(pendingReferralCode.get$) ?? "";
});
export const signupFriendReferralReady$ = computed((get) => {
  return !get(signupFriendReferralCode$) || !!get(pendingReferral.get$);
});
const internalOpenPageVersion$ = state<number | null>(null);
export const friendReferralOpen$ = computed((get) => {
  return get(internalOpenPageVersion$) === get(pageVersion$);
});
export const setFriendReferralOpen$ = command(({ get, set }, open: boolean) => {
  set(internalOpenPageVersion$, open ? get(pageVersion$) : null);
});

/** Link-prefilled and manually entered codes share the signed pre-signup visit. */
export const setSignupFriendReferralCode$ = command(
  async ({ get, set }, value: string, parentSignal: AbortSignal) => {
    const signal = set(resetReferralVisit$, parentSignal);
    const normalizedCode = value.trim().toLowerCase();
    if (
      normalizedCode === set(pendingReferralCode.readFresh$) &&
      set(pendingReferral.readFresh$)
    ) {
      return;
    }
    set(pendingReferralCode.set$, normalizedCode);
    set(pendingReferral.clear$);
    const code = friendReferralCodeSchema.safeParse(normalizedCode);
    if (!code.success) {
      return;
    }
    const client = get(apiClient$)(friendReferralsContract, {
      getToken: () => {
        return Promise.resolve(null);
      },
    });
    const response = await accept(
      client.visit({ body: { code: code.data }, fetchOptions: { signal } }),
      [200, 404],
      undefined,
      { showErrorToast: false },
    );
    signal.throwIfAborted();
    if (response.status === 200) {
      set(pendingReferral.set$, response.body.token);
    }
  },
);

/** Capture before rendering signup, so the server can verify account newness. */
export const captureFriendReferral$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const params = new URLSearchParams(location.search);
    const code = params.get("friend_referral");
    if (code !== null) {
      await set(setSignupFriendReferralCode$, code, signal);
      signal.throwIfAborted();
      // Consume the prefill so a reload cannot overwrite a later edit or clear.
      params.delete("friend_referral");
      set(replaceSearchParams$, params, get(historyState$), location.hash);
    }
  },
);

export const registerFriendReferral$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const token = set(pendingReferral.readFresh$);
    if (!token || !(await get(clerkUser$))) {
      return;
    }
    signal.throwIfAborted();
    await accept(
      get(apiClient$)(friendReferralsContract).register({
        body: { token },
        fetchOptions: { signal },
      }),
      [200],
      undefined,
      { showErrorToast: false },
    );
    signal.throwIfAborted();
    set(pendingReferral.clear$);
    set(pendingReferralCode.clear$);
  },
);

export const loadFriendReferral$ = command(
  async ({ get }, signal: AbortSignal) => {
    const response = await accept(
      get(apiClient$)(friendReferralsContract).link({
        fetchOptions: { signal },
      }),
      [200],
      undefined,
      { showErrorToast: false },
    );
    signal.throwIfAborted();
    return response.body;
  },
);

export function friendReferralUrl(code: string): string {
  const url = new URL("/sign-up", location.origin);
  url.searchParams.set("friend_referral", code);
  return url.href;
}

export const copyFriendReferral$ = command(
  async (
    _context,
    code: string,
    target: "code" | "link",
    signal: AbortSignal,
  ) => {
    const copied = await writeToClipboard(
      target === "code" ? code : friendReferralUrl(code),
    );
    signal.throwIfAborted();
    return { target, copied };
  },
);
