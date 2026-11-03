import { command, computed, state } from "ccstate";
import { friendReferralCodeSchema } from "@okouai/api-contracts/validators/friend-referrals";
import { friendReferralsContract } from "@okouai/api-contracts/client/friend-referrals";
import { apiClient$ } from "./api-client.ts";
import { clerkUser$ } from "./auth.ts";
import { localStorageSignals } from "./external/local-storage.ts";
import { accept } from "../lib/accept.ts";
import { writeToClipboard } from "./okou-page/clipboard.ts";

const pendingReferral = localStorageSignals("friend_referral_visit");
const internalOpen$ = state(false);
export const friendReferralOpen$ = computed((get) => {
  return get(internalOpen$);
});
export const setFriendReferralOpen$ = command(({ set }, open: boolean) => {
  set(internalOpen$, open);
});

/** Capture before rendering signup, so the server can verify account newness. */
export const captureFriendReferral$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const code = friendReferralCodeSchema.safeParse(
      new URLSearchParams(location.search).get("friend_referral"),
    );
    if (!code.success || set(pendingReferral.readFresh$)) {
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

export const registerFriendReferral$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const token = set(pendingReferral.readFresh$);
    if (!token || !(await get(clerkUser$))) {
      return;
    }
    signal.throwIfAborted();
    const response = await accept(
      get(apiClient$)(friendReferralsContract).register({
        body: { token },
        fetchOptions: { signal },
      }),
      [200, 404],
      undefined,
      { showErrorToast: false },
    );
    signal.throwIfAborted();
    if (response.status === 200) {
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
