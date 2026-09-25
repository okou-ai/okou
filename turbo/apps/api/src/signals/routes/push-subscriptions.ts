import { command } from "ccstate";
import { pushSubscriptionsContract } from "@okouai/api-contracts/contracts/push-subscriptions";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { registerPushSubscription$ } from "../services/push-subscriptions.service";
import type { RouteEntry } from "../route-entry";

const registerInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(authContext$);

  const bodyResult = await get(
    bodyResultOf(pushSubscriptionsContract.register),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const { endpoint, keys } = bodyResult.data;

  await set(
    registerPushSubscription$,
    {
      userId: auth.userId,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
    },
    signal,
  );
  signal.throwIfAborted();

  return { status: 201 as const, body: { success: true as const } };
});

export const pushSubscriptionsRoutes: readonly RouteEntry[] = [
  {
    route: pushSubscriptionsContract.register,
    handler: authRoute({}, registerInner$),
  },
];
