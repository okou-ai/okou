import { command, computed, state } from "ccstate";
import { friendReferralCodeSchema } from "@okouai/api-contracts/validators/friend-referrals";
import { friendReferralsContract } from "@okouai/api-contracts/client/friend-referrals";
import { apiClient$ } from "./api-client.ts";
import { clerkUser$ } from "./auth.ts";
import { pageVersion$ } from "./page-signal.ts";
import { cookieSignals } from "./external/cookie.ts";
import { accept } from "../lib/accept.ts";
import { writeToClipboard } from "./okou-page/clipboard.ts";
import { historyState$, replaceSearchParams$ } from "./route.ts";

const pendingReferral = cookieSignals("friend-referral-visit", {
  scope: "host",
  maxAgeSeconds: 60 * 60 * 24 * 30,
});
const internalOpenPageVersion$ = state<number | null>(null);
export const friendReferralOpen$ = computed((get) => {
  return get(internalOpenPageVersion$) === get(pageVersion$);
});
export const setFriendReferralOpen$ = command(({ get, set }, open: boolean) => {
  set(internalOpenPageVersion$, open ? get(pageVersion$) : null);
});

/** Capture before Clerk renders, so the server can verify account newness. */
export const captureFriendReferral$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const params = new URLSearchParams(location.search);
    const value = params.get("friend_referral");
    if (value === null) {
      return;
    }
    const code = friendReferralCodeSchema.safeParse(value.trim().toLowerCase());
    if (code.success) {
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
    }
    params.delete("friend_referral");
    set(replaceSearchParams$, params, get(historyState$), location.hash);
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
    if (set(pendingReferral.readFresh$) === token) {
      set(pendingReferral.clear$);
    }
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
  async (_context, code: string, signal: AbortSignal) => {
    const copied = await writeToClipboard(friendReferralUrl(code));
    signal.throwIfAborted();
    return copied;
  },
);
