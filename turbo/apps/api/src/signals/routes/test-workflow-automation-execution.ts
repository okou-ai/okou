import { testWorkflowAutomationExecutionContract } from "@okouai/api-contracts/contracts/test-workflow-automation-execution";
import { command } from "ccstate";

import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { dispatchRunCallbacks$ } from "../services/agent-run-callback.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";
const dispatchBody$ = bodyResultOf(
  testWorkflowAutomationExecutionContract.dispatchCallbacks,
);

const dispatchTestWorkflowAutomationCallbacks$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const bodyResult = await get(dispatchBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const body = bodyResult.data;
    const db = set(writeDb$);
    const dispatches = await Promise.all(
      Array.from({ length: body.dispatch_count }, async () => {
        return await set(
          dispatchRunCallbacks$,
          {
            db,
            runId: body.run_id,
            status: body.status,
            error: body.status === "failed" ? body.error : undefined,
          },
          signal,
        );
      }),
    );
    signal.throwIfAborted();
    const callbackResults = dispatches.flat();
    return {
      status: 200 as const,
      body: {
        success: true as const,
        dispatches: dispatches.length,
        callback_results: callbackResults.length,
        successful_callbacks: callbackResults.filter((result) => {
          return result.success;
        }).length,
      },
    };
  },
);

export const testWorkflowAutomationExecutionRoutes: readonly RouteEntry[] = [
  {
    route: testWorkflowAutomationExecutionContract.dispatchCallbacks,
    handler: dispatchTestWorkflowAutomationCallbacks$,
  },
];
