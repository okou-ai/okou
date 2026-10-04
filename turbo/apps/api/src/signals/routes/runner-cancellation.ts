import { runnersCancellationContract } from "@okouai/api-contracts/contracts/runners";
import { command, computed } from "ccstate";

import { authorization$, setResHeader$ } from "../context/hono";
import { pathParamsOf, queryOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { createRunCancellationState } from "../services/run-cancellation-state.service";
import {
  getSandboxAuthForRun,
  unauthorizedRunMismatch,
} from "./agent-webhook-auth";

const runCancellationState$ = computed((get) => {
  const { runId } = get(pathParamsOf(runnersCancellationContract.get));
  const auth = getSandboxAuthForRun(runId, get(authorization$));
  return auth
    ? createRunCancellationState(
        auth,
        get(queryOf(runnersCancellationContract.get)),
      )
    : null;
});

const readCancellation$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  signal.throwIfAborted();
  const cancellationState$ = get(runCancellationState$);
  if (!cancellationState$) {
    return unauthorizedRunMismatch;
  }
  const body = await get(cancellationState$);
  signal.throwIfAborted();
  return { status: 200 as const, body };
});

export const runnerCancellationRoutes: readonly RouteEntry[] = [
  { route: runnersCancellationContract.get, handler: readCancellation$ },
];
