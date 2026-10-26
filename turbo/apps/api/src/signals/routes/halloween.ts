import { halloweenContract } from "@okouai/api-contracts/contracts/halloween";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  halloweenPhase,
  HALLOWEEN_START,
  HALLOWEEN_END,
} from "@okouai/core/halloween";
import { halloweenExposures } from "@okouai/db/schema/halloween";
import { command } from "ccstate";
import { conflict } from "../../lib/error";
import { nowDate } from "../../lib/time";
import { authContext$, requiredAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { authorization$, cookie$, setResHeader$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$ } from "../external/db";
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
    return halloweenPhase(nowDate().getTime());
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
    ? halloweenPhase(nowDate().getTime())
    : ("unavailable" as const);
});

const status$ = command(async ({ set }, signal: AbortSignal) => {
  const phase = await set(phase$, signal);
  const boundary =
    phase === "upcoming"
      ? HALLOWEEN_START
      : phase === "open"
        ? HALLOWEEN_END
        : null;
  return {
    status: 200 as const,
    body: {
      phase,
      changesInMs:
        boundary === null ? null : Math.max(0, boundary - nowDate().getTime()),
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
const exposure$ = command(async ({ get, set }, signal: AbortSignal) => {
  if ((await set(phase$, signal)) !== "open") {
    return { status: 200 as const, body: { first: false } };
  }
  const db = set(writeDb$);
  const inserted = await db
    .insert(halloweenExposures)
    .values({ userId: get(authContext$).userId })
    .onConflictDoNothing()
    .returning({ userId: halloweenExposures.userId });
  signal.throwIfAborted();
  return { status: 200 as const, body: { first: inserted.length > 0 } };
});
const accountAuth = { accept: ["session", "pat"] } as const;
export const halloweenRoutes: readonly RouteEntry[] = [
  { route: halloweenContract.status, handler: status$ },
  { route: halloweenContract.start, handler: start$ },
  { route: halloweenContract.answer, handler: answer$ },
  { route: halloweenContract.next, handler: next$ },
  { route: halloweenContract.leave, handler: leave$ },
  { route: halloweenContract.link, handler: authRoute(accountAuth, link$) },
  {
    route: halloweenContract.exposure,
    handler: authRoute(accountAuth, exposure$),
  },
];
