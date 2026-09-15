import { setResHeader$ } from "../context/hono";
import { command } from "ccstate";
import { impactMarketingContract } from "@okouai/api-contracts/contracts/impact-marketing";
import {
  createImpactHandoff,
  marketingImpactEnabled,
} from "../../lib/impact-marketing";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";

const handoff$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const body = await get(bodyResultOf(impactMarketingContract.handoff));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const auth = get(authContext$);
  const handoff =
    marketingImpactEnabled() && auth.orgId
      ? createImpactHandoff({
          userId: auth.userId,
          orgId: auth.orgId,
          orgRole: auth.orgRole,
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
