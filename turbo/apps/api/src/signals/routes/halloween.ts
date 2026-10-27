import { halloweenContract } from "@okouai/api-contracts/contracts/halloween";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command } from "ccstate";
import { conflict } from "../../lib/error";
import { authContext$, requiredAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { authorization$, cookie$, setResHeader$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { userFeatureSwitchContext } from "../services/feature-switches.service";
import { getUserEmail$ } from "../services/email-common.service";
import {
  startHalloweenRound$,
  answerHalloweenRound$,
  advanceHalloweenRound$,
  leaveHalloweenRound$,
  linkHalloweenRound$,
} from "../services/halloween.service";

const phase$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  if (isFeatureEnabled(FeatureSwitchKey.HalloweenQuiz, {})) {
    return "open" as const;
  }
  if (!get(authorization$) && !get(cookie$)) {
    return "unavailable" as const;
  }
  const auth = await set(requiredAuthContext$, {}, signal);
  if ("status" in auth || !auth.orgId) {
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
const start$ = command(async ({ get, set }, signal: AbortSignal) => {
  const body = await get(bodyResultOf(halloweenContract.start));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  if ((await set(phase$, signal)) !== "open") {
    return conflict("This Halloween quiz is not open");
  }
  return await set(startHalloweenRound$, body.data, signal);
});
const answer$ = command(async ({ get, set }, signal: AbortSignal) => {
  const body = await get(bodyResultOf(halloweenContract.answer));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  return await set(answerHalloweenRound$, body.data, signal);
});
const next$ = command(async ({ get, set }, signal: AbortSignal) => {
  const body = await get(bodyResultOf(halloweenContract.next));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  return await set(advanceHalloweenRound$, body.data, signal);
});
const leave$ = command(async ({ get, set }, signal: AbortSignal) => {
  const body = await get(bodyResultOf(halloweenContract.leave));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  return await set(leaveHalloweenRound$, body.data, signal);
});
const link$ = command(async ({ get, set }, signal: AbortSignal) => {
  const body = await get(bodyResultOf(halloweenContract.link));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const auth = get(authContext$);
  const email = await set(getUserEmail$, auth.userId, signal);
  signal.throwIfAborted();
  return await set(
    linkHalloweenRound$,
    { ...body.data, userId: auth.userId, orgId: auth.orgId ?? null, email },
    signal,
  );
});
const accountAuth = { accept: ["session", "pat"] } as const;
export const halloweenRoutes: readonly RouteEntry[] = [
  { route: halloweenContract.status, handler: status$ },
  { route: halloweenContract.start, handler: start$ },
  { route: halloweenContract.answer, handler: answer$ },
  { route: halloweenContract.next, handler: next$ },
  { route: halloweenContract.leave, handler: leave$ },
  { route: halloweenContract.link, handler: authRoute(accountAuth, link$) },
];
