import { debugMorningBriefContract } from "@okouai/api-contracts/contracts/debug-morning-brief";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command, computed } from "ccstate";
import { notFound, resourceUnavailable } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { createDebugMorningBriefReceipt } from "../services/debug-morning-brief.service";
import { userFeatureSwitchContext } from "../services/feature-switches.service";

const owner$ = computed((get) => {
  return get(organizationAuthContext$);
});
const enabled$ = computed(async (get) => {
  const owner = get(owner$);
  const features = await get(
    userFeatureSwitchContext(owner.orgId, owner.userId),
  );
  return isFeatureEnabled(FeatureSwitchKey.OkouDebug, features);
});
const getRequestId$ = computed((get) => {
  return get(pathParamsOf(debugMorningBriefContract.get)).id;
});
const receipt = createDebugMorningBriefReceipt(owner$, getRequestId$);
const disabled = () => {
  return resourceUnavailable(
    "Running Morning Brief from Debug requires Okou Debug.",
  );
};
const get$ = command(async ({ get }, signal: AbortSignal) => {
  const enabled = await get(enabled$);
  signal.throwIfAborted();
  if (!enabled) {
    return disabled();
  }
  const response = await get(receipt);
  signal.throwIfAborted();
  return response
    ? { status: 200 as const, body: response }
    : notFound("Morning Brief request not found in your workspace.");
});
const auth = { accept: ["session"], requireOrganization: true } as const;
export const debugMorningBriefRoutes: readonly RouteEntry[] = [
  { route: debugMorningBriefContract.get, handler: authRoute(auth, get$) },
];
