import { setResHeader$ } from "../context/hono";
import { command } from "ccstate";
import { impactMarketingContract } from "@okouai/api-contracts/contracts/impact-marketing";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import {
  createImpactHandoff,
  marketingImpactEnabled,
  readMarketingImpact,
} from "../../lib/impact-marketing";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { userFeatureSwitchContext } from "../services/feature-switches.service";
import { syncImpactStripeCustomer$ } from "../services/impact-attribution.service";
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
const sync$ = command(async ({ get, set }, signal: AbortSignal) => {
  const body = await get(bodyResultOf(impactMarketingContract.sync));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const enabled = await set(handoffEnabled$, signal);
  signal.throwIfAborted();
  const auth = get(authContext$);
  if (!enabled || !auth.orgId || auth.orgRole !== "admin") {
    return { status: 200 as const, body: { synced: false } };
  }
  const metadata = await readMarketingImpact(auth.orgId, signal);
  signal.throwIfAborted();
  if (!metadata.impact_capture_id) {
    return { status: 200 as const, body: { synced: false } };
  }
  await set(syncImpactStripeCustomer$, metadata, signal);
  signal.throwIfAborted();
  return { status: 200 as const, body: { synced: true } };
});
export const impactMarketingRoutes: readonly RouteEntry[] = [
  {
    route: impactMarketingContract.handoff,
    handler: authRoute({ accept: ["session"] }, handoff$),
  },
  {
    route: impactMarketingContract.sync,
    handler: authRoute({ accept: ["session"] }, sync$),
  },
];
