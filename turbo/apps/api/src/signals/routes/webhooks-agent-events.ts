import { command } from "ccstate";
import { webhookEventsContract } from "@okouai/api-contracts/contracts/webhooks";

import { authorization$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import type { RouteEntry } from "../route-entry";
import {
  dispatchOptionalAgentEventConsumers$,
  receiveAgentEvents$,
} from "../services/agent-webhook-events.service";
import {
  getSandboxAuthForRun,
  unauthorizedRunMismatch,
} from "./agent-webhook-auth";

const eventsBody$ = bodyResultOf(webhookEventsContract.send);

const receiveEvents$ = command(async ({ get, set }, signal: AbortSignal) => {
  const bodyResult = await get(eventsBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const body = bodyResult.data;
  const auth = getSandboxAuthForRun(body.runId, get(authorization$));
  if (!auth) {
    return unauthorizedRunMismatch;
  }
  const result = await set(receiveAgentEvents$, { auth, body }, signal);
  signal.throwIfAborted();

  if ("acceptedEvents" in result && result.acceptedEvents !== undefined) {
    waitUntil(
      set(dispatchOptionalAgentEventConsumers$, result.acceptedEvents, signal),
    );
  }
  return result.response;
});

export const webhooksAgentEventsRoutes: readonly RouteEntry[] = [
  {
    route: webhookEventsContract.send,
    handler: receiveEvents$,
  },
];
