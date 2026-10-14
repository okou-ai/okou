import { debugMorningBriefContract } from "@okouai/api-contracts/contracts/debug-morning-brief";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command, computed } from "ccstate";
import { notFound, resourceUnavailable } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import type { RouteEntry } from "../route-entry";
import { createDebugMorningBrief } from "../services/debug-morning-brief.service";
import { userFeatureSwitchContext } from "../services/feature-switches.service";
import { notifyRunningChatRunOfPendingInput$ } from "../services/chat-thread-queue-drain.service";
import { publishEnqueuedWorkflowInput$ } from "../services/workflow-automation-run.service";

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
const body$ = bodyResultOf(debugMorningBriefContract.run);
const runRequestId$ = computed(async (get) => {
  const body = await get(body$);
  if (!body.ok) {
    throw new Error("Morning Brief request must be validated before enqueue");
  }
  return body.data.requestId;
});
const getRequestId$ = computed((get) => {
  return get(pathParamsOf(debugMorningBriefContract.get)).id;
});
const run = createDebugMorningBrief(owner$, runRequestId$);
const receipt = createDebugMorningBrief(owner$, getRequestId$);
const disabled = () => {
  return resourceUnavailable(
    "Running Morning Brief from Debug requires Okou Debug.",
  );
};
const run$ = command(async ({ get, set }, signal: AbortSignal) => {
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
  const result = await set(run.enqueue$, signal);
  signal.throwIfAborted();
  if (result.kind === "error") {
    return result.response;
  }
  if (result.kind === "enqueued") {
    const owner = get(owner$);
    waitUntil(
      set(
        publishEnqueuedWorkflowInput$,
        {
          ...owner,
          chatThreadId: result.response.chatThreadId,
          enqueueCommit: result.enqueueCommit,
        },
        signal,
      ),
    );
    waitUntil(
      set(
        notifyRunningChatRunOfPendingInput$,
        result.response.chatThreadId,
        signal,
      ),
    );
  }
  return { status: 200 as const, body: result.response };
});
const get$ = command(async ({ get }, signal: AbortSignal) => {
  const enabled = await get(enabled$);
  signal.throwIfAborted();
  if (!enabled) {
    return disabled();
  }
  const response = await get(receipt.receipt$);
  signal.throwIfAborted();
  return response
    ? { status: 200 as const, body: response }
    : notFound("Morning Brief request not found in your workspace.");
});
const auth = { accept: ["session"], requireOrganization: true } as const;
export const debugMorningBriefRoutes: readonly RouteEntry[] = [
  { route: debugMorningBriefContract.run, handler: authRoute(auth, run$) },
  { route: debugMorningBriefContract.get, handler: authRoute(auth, get$) },
];
