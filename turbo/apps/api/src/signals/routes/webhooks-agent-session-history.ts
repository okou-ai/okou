import { command } from "ccstate";
import {
  webhookCheckpointsPrepareHistoryContract,
  webhookSessionHistoryPrepareContract,
} from "@okouai/api-contracts/contracts/webhooks";
import { authorization$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { prepareSessionHistoryUpload$ } from "../services/agent-run-output.service";
import {
  getSandboxAuthForRun,
  unauthorizedRunMismatch,
} from "./agent-webhook-auth";

function historyUploadHandler(
  route:
    | typeof webhookSessionHistoryPrepareContract.prepare
    | typeof webhookCheckpointsPrepareHistoryContract.prepare,
) {
  const body$ = bodyResultOf(route);
  return command(async ({ get, set }, signal: AbortSignal) => {
    const parsed = await get(body$);
    signal.throwIfAborted();
    if (!parsed.ok) {
      return parsed.response;
    }
    const body = parsed.data;
    const auth = getSandboxAuthForRun(body.runId, get(authorization$));
    if (!auth) {
      return unauthorizedRunMismatch;
    }
    return await set(prepareSessionHistoryUpload$, { auth, body }, signal);
  });
}

export const webhooksAgentSessionHistoryRoutes: readonly RouteEntry[] = [
  {
    route: webhookSessionHistoryPrepareContract.prepare,
    handler: historyUploadHandler(webhookSessionHistoryPrepareContract.prepare),
  },
  // Remove after old Guest binaries and their pending uploads have drained.
  {
    route: webhookCheckpointsPrepareHistoryContract.prepare,
    handler: historyUploadHandler(
      webhookCheckpointsPrepareHistoryContract.prepare,
    ),
  },
];
