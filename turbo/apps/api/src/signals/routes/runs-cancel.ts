import { command } from "ccstate";
import { runsCancelContract } from "@okouai/api-contracts/contracts/run-routes";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { apiStartTime$ } from "../context/hono";
import { pathParamsOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import { logger } from "../../lib/log";
import {
  cancelRun$,
  type CancelRunResult,
} from "../services/agent-run-terminal-transition.service";
import {
  dispatchCancelSideEffects$,
  shouldDispatchCancelSideEffects,
} from "../services/run-cancel.service";
import { tapError } from "../utils";
import type { RouteEntry } from "../route-entry";

const L = logger("RunCancel");

function isCancelResult(value: NonNullable<unknown>): value is CancelRunResult {
  return "alreadyCancelled" in value;
}

const cancelInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(runsCancelContract.cancel));
  const apiStartTime = get(apiStartTime$);
  signal.throwIfAborted();

  const result = await set(
    cancelRun$,
    {
      runId: params.id,
      userId: auth.userId,
      orgId: auth.orgId,
      runnerCancellationMode: "cooperative",
      apiStartTime,
    },
    signal,
  );
  signal.throwIfAborted();

  if (!isCancelResult(result)) {
    // Frozen httpError response from notFound() or runNotCancellable() —
    // forward verbatim. The body.error.code differentiates 404 NOT_FOUND
    // from 400 RUN_NOT_CANCELLABLE for the client.
    return result;
  }

  if (shouldDispatchCancelSideEffects(result)) {
    const backgroundSignal = new AbortController().signal;
    waitUntil(
      tapError(
        set(dispatchCancelSideEffects$, result, backgroundSignal),
        (error) => {
          L.error("dispatchCancelSideEffects failed", {
            runId: result.runId,
            error,
          });
        },
      ),
    );
  }

  return {
    status: 200 as const,
    body: {
      id: result.runId,
      status: "cancelled" as const,
      message: "Run cancelled successfully",
    },
  };
});

export const runsCancelRoutes: readonly RouteEntry[] = [
  {
    route: runsCancelContract.cancel,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        accept: ["session", "pat", "oauth"],
        oauthScope: "okou:run:cancel",
      },
      cancelInner$,
    ),
  },
];
