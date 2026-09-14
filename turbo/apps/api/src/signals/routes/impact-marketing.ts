import { setResHeader$ } from "../context/hono";
import { command } from "ccstate";
import { impactMarketingContract } from "@okouai/api-contracts/contracts/impact-marketing";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import {
  createImpactHandoff,
  marketingImpactEnabled,
} from "../../lib/impact-marketing";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { userFeatureSwitchContext } from "../services/feature-switches.service";
import type { RouteEntry } from "../route-entry";

const handoffEnabled$ = command(async ({ get }, signal: AbortSignal) => {
  const auth = get(authContext$);
  if (!marketingImpactEnabled() || !auth.orgId) {
    return false;
  }
  const context = await get(userFeatureSwitchContext(auth.orgId, auth.userId));
  signal.throwIfAborted();
  return isFeatureEnabled(FeatureSwitchKey.ImpactMarketingAttribution, context);
});
const handoff$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const body = await get(bodyResultOf(impactMarketingContract.handoff));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const enabled = await set(handoffEnabled$, signal);
  signal.throwIfAborted();
  const auth = get(authContext$);
  const handoff =
    enabled && auth.orgId
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
