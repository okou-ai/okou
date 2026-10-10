import { debugMorningBriefEmailContract } from "@okouai/api-contracts/contracts/debug-morning-brief-email";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command, computed } from "ccstate";
import { resourceUnavailable } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import {
  debugMorningBriefEmail,
  sendDebugMorningBriefEmail$,
} from "../services/debug-morning-brief-email.service";
import { userFeatureSwitchContext } from "../services/feature-switches.service";

const enabled$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const context = await get(userFeatureSwitchContext(auth.orgId, auth.userId));
  return isFeatureEnabled(FeatureSwitchKey.OkouDebug, context);
});
const disabled = () => {
  return resourceUnavailable("Morning Brief test email requires Okou Debug.");
};
const body$ = bodyResultOf(debugMorningBriefEmailContract.send);
const params$ = pathParamsOf(debugMorningBriefEmailContract.get);
const send$ = command(async ({ get, set }, signal: AbortSignal) => {
  const enabled = await get(enabled$);
  signal.throwIfAborted();
  if (!enabled) {
    return disabled();
  }
  const body = await get(body$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  return await set(
    sendDebugMorningBriefEmail$,
    get(organizationAuthContext$),
    body.data.requestId,
    signal,
  );
});
const get$ = command(async ({ get }, signal: AbortSignal) => {
  const enabled = await get(enabled$);
  signal.throwIfAborted();
  if (!enabled) {
    return disabled();
  }
  const result = await get(
    debugMorningBriefEmail(get(organizationAuthContext$), get(params$).id),
  );
  signal.throwIfAborted();
  return result;
});
const auth = { accept: ["session"], requireOrganization: true } as const;
export const debugMorningBriefEmailRoutes: readonly RouteEntry[] = [
  {
    route: debugMorningBriefEmailContract.send,
    handler: authRoute(auth, send$),
  },
  { route: debugMorningBriefEmailContract.get, handler: authRoute(auth, get$) },
];
