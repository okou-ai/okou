import { runnersCancellationContract } from "@okouai/api-contracts/contracts/runners";
import { command } from "ccstate";

import { authorization$, setResHeader$ } from "../context/hono";
import { pathParamsOf, queryOf } from "../context/request";
import { db$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { readRunCancellationState } from "../services/run-cancellation-state.service";
import {
  getSandboxAuthForRun,
  unauthorizedRunMismatch,
} from "./agent-webhook-auth";

const readCancellation$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const { runId } = get(pathParamsOf(runnersCancellationContract.get));
  const auth = getSandboxAuthForRun(runId, get(authorization$));
  if (!auth) {
    return unauthorizedRunMismatch;
  }
  const body = await readRunCancellationState(
    get(db$),
    auth,
    get(queryOf(runnersCancellationContract.get)),
    signal,
  );
  signal.throwIfAborted();
  return { status: 200 as const, body };
});

export const runnerCancellationRoutes: readonly RouteEntry[] = [
  { route: runnersCancellationContract.get, handler: readCancellation$ },
];
