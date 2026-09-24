import { command } from "ccstate";
import { platformRealtimeTokenContract } from "@okouai/api-contracts/contracts/realtime";

import { requiredAuthContext$, setAuthContext$ } from "../auth/auth-context";
import { createPlatformRealtimeToken } from "../external/realtime";
import type { RouteEntry } from "../route-entry";

const unauthenticated = Object.freeze({
  status: 401 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Authentication required",
      code: "UNAUTHORIZED",
    }),
  }),
});

const createInner$ = command(async ({ set }, signal: AbortSignal) => {
  const auth = await set(requiredAuthContext$, {}, signal);
  signal.throwIfAborted();
  if ("status" in auth) {
    return unauthenticated;
  }

  set(setAuthContext$, auth);

  const token = await createPlatformRealtimeToken(
    auth.userId,
    auth.orgId,
    signal,
  );
  signal.throwIfAborted();

  return { status: 200 as const, body: token };
});

export const realtimeTokenRoutes: readonly RouteEntry[] = [
  {
    route: platformRealtimeTokenContract.create,
    handler: createInner$,
  },
];
