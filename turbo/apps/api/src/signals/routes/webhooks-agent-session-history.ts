import { command } from "ccstate";
import { webhookSessionHistoryPrepareContract } from "@okouai/api-contracts/contracts/webhooks";
import { authorization$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { prepareSessionHistoryUpload$ } from "../services/agent-run-output.service";
import {
  getSandboxAuthForRun,
  unauthorizedRunMismatch,
} from "./agent-webhook-auth";

const body$ = bodyResultOf(webhookSessionHistoryPrepareContract.prepare);
const historyUploadHandler$ = command(
  async ({ get, set }, signal: AbortSignal) => {
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
  },
);

export const webhooksAgentSessionHistoryRoutes: readonly RouteEntry[] = [
  {
    route: webhookSessionHistoryPrepareContract.prepare,
    handler: historyUploadHandler$,
  },
];
