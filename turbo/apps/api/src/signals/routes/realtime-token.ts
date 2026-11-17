import { command } from "ccstate";
import { platformRealtimeTokenContract } from "@okouai/api-contracts/contracts/realtime";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import {
  createOAuthChatRealtimeToken,
  createPlatformRealtimeToken,
} from "../external/realtime";
import { now } from "../../lib/time";
import type { RouteEntry } from "../route-entry";

const createInner$ = command(async ({ get }, signal: AbortSignal) => {
  const auth = get(authContext$);
  const token =
    auth.tokenType === "oauth"
      ? await createOAuthChatRealtimeToken(
          auth.userId,
          auth.orgId,
          Math.max(1, auth.expiresAt * 1000 - now()),
          signal,
        )
      : await createPlatformRealtimeToken(auth.userId, auth.orgId, signal);
  signal.throwIfAborted();

  return { status: 200 as const, body: token };
});

export const realtimeTokenRoutes: readonly RouteEntry[] = [
  {
    route: platformRealtimeTokenContract.create,
    handler: authRoute({ oauthScope: "okou:chat:read" }, createInner$),
  },
];
