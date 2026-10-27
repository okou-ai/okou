import { halloweenContract } from "@okouai/api-contracts/contracts/halloween";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command } from "ccstate";
import { conflict } from "../../lib/error";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { userFeatureSwitchContext } from "../services/feature-switches.service";
import { getUserEmail$ } from "../services/email-common.service";
import {
  answerHalloweenRound$,
  advanceHalloweenRound$,
  currentHalloweenRound$,
  leaveHalloweenRound$,
  startHalloweenRound$,
} from "../services/halloween.service";

const phase$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const auth = get(authContext$);
  if (!auth.orgId) {
    return "unavailable" as const;
  }
  const context = await get(userFeatureSwitchContext(auth.orgId, auth.userId));
  signal.throwIfAborted();
  return isFeatureEnabled(FeatureSwitchKey.HalloweenQuiz, context)
    ? ("open" as const)
    : ("unavailable" as const);
});

const status$ = command(async ({ set }, signal: AbortSignal) => {
  const phase = await set(phase$, signal);
  return {
    status: 200 as const,
    body: {
      phase,
      changesInMs: null,
    },
  };
});
const current$ = command(async ({ get, set }, signal: AbortSignal) => {
  if ((await set(phase$, signal)) !== "open") {
    return conflict("This Halloween quiz is not open");
  }
  const current = await get(currentHalloweenRound$);
  signal.throwIfAborted();
  return current;
});
const start$ = command(async ({ get, set }, signal: AbortSignal) => {
  const body = await get(bodyResultOf(halloweenContract.start));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  if ((await set(phase$, signal)) !== "open") {
    return conflict("This Halloween quiz is not open");
  }
  const auth = get(authContext$);
  const email = await set(getUserEmail$, auth.userId, signal);
  signal.throwIfAborted();
  return await set(
    startHalloweenRound$,
    {
      ...body.data,
      userId: auth.userId,
      orgId: auth.orgId ?? null,
      email,
    },
    signal,
  );
});
const answer$ = command(async ({ get, set }, signal: AbortSignal) => {
  const body = await get(bodyResultOf(halloweenContract.answer));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  return await set(
    answerHalloweenRound$,
    { ...body.data, userId: get(authContext$).userId },
    signal,
  );
});
const next$ = command(async ({ get, set }, signal: AbortSignal) => {
  const body = await get(bodyResultOf(halloweenContract.next));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  return await set(
    advanceHalloweenRound$,
    { ...body.data, userId: get(authContext$).userId },
    signal,
  );
});
const leave$ = command(async ({ get, set }, signal: AbortSignal) => {
  const body = await get(bodyResultOf(halloweenContract.leave));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  return await set(
    leaveHalloweenRound$,
    { ...body.data, userId: get(authContext$).userId },
    signal,
  );
});
const accountAuth = { accept: ["session", "pat"] } as const;
export const halloweenRoutes: readonly RouteEntry[] = [
  {
    route: halloweenContract.status,
    handler: authRoute(accountAuth, status$),
  },
  {
    route: halloweenContract.current,
    handler: authRoute(accountAuth, current$),
  },
  {
    route: halloweenContract.start,
    handler: authRoute(accountAuth, start$),
  },
  {
    route: halloweenContract.answer,
    handler: authRoute(accountAuth, answer$),
  },
  {
    route: halloweenContract.next,
    handler: authRoute(accountAuth, next$),
  },
  {
    route: halloweenContract.leave,
    handler: authRoute(accountAuth, leave$),
  },
];
