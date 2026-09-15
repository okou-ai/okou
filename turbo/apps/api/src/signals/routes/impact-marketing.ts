import { setResHeader$ } from "../context/hono";
import { command } from "ccstate";
import { impactMarketingContract } from "@okouai/api-contracts/contracts/impact-marketing";
import { createImpactHandoff } from "../../lib/impact-marketing";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { clerk$ } from "../external/clerk";
import { nowDate } from "../../lib/time";

const handoff$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const body = await get(bodyResultOf(impactMarketingContract.handoff));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const auth = get(authContext$);
  const request = body.data.acquisition;
  const now = nowDate().getTime();
  let signupAt: number | undefined;
  if (request?.checkSignup && auth.orgId) {
    const users = await get(clerk$).users.getUserList({
      userId: [auth.userId],
      limit: 1,
    });
    signal.throwIfAborted();
    const user = users.data.find((candidate) => {
      return candidate.id === auth.userId;
    });
    // A previous App's signup record suppresses replay when a recent user
    // refreshes into the replacement bundle during the serving transition.
    if (
      user &&
      !user.banned &&
      !user.locked &&
      !user.privateMetadata.signup_attribution &&
      Number.isSafeInteger(user.createdAt) &&
      user.createdAt <= now &&
      now - user.createdAt <= 30 * 60_000
    ) {
      signupAt = user.createdAt;
    }
  }
  const handoff = auth.orgId
    ? createImpactHandoff({
        userId: auth.userId,
        orgId: auth.orgId,
        orgRole: auth.orgRole,
        ...(request
          ? {
              acquisition: {
                version: 2 as const,
                ...(signupAt === undefined ? {} : { signupAt }),
                events: request.events
                  .filter((event) => {
                    return (
                      event.at <= now + 5000 && event.at >= now - 86_400_000
                    );
                  })
                  .map((event) => {
                    return { ...event, at: Math.min(event.at, now) };
                  }),
              },
            }
          : {}),
      })
    : null;
  return { status: 200 as const, body: { handoff } };
});
export const impactMarketingRoutes: readonly RouteEntry[] = [
  {
    route: impactMarketingContract.handoff,
    handler: authRoute({ accept: ["session"] }, handoff$),
  },
];
