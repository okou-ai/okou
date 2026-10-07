import { testWorkflowAutomationExecutionContract } from "@okouai/api-contracts/contracts/test-workflow-automation-execution";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { workflowAutomations, workflows } from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";

import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { nowDate } from "../../lib/time";
import type { RouteEntry } from "../route-entry";
import { dispatchRunCallbacks$ } from "../services/agent-run-callback.service";
import { handleWorkflowAutomationResultEmailInternalCallback$ } from "../services/internal-workflow-automation-result-email-callback.service";
import { executeDueWorkflowAutomationsForAutomation$ } from "../services/workflow-automation-poller.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const agentBody$ = bodyResultOf(
  testWorkflowAutomationExecutionContract.executeForAgent,
);
const dispatchBody$ = bodyResultOf(
  testWorkflowAutomationExecutionContract.dispatchCallbacks,
);
const interruptionBody$ = bodyResultOf(
  testWorkflowAutomationExecutionContract.interruptResultEmailCallback,
);

const executeTestWorkflowAutomationsForAgent$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const bodyResult = await get(agentBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const db = set(writeDb$);
    const rows = await db
      .select({ id: workflowAutomations.id })
      .from(workflowAutomations)
      .innerJoin(workflows, eq(workflowAutomations.workflowId, workflows.id))
      .where(eq(workflows.agentId, bodyResult.data.agent_id));
    signal.throwIfAborted();

    let executed = 0;
    let skipped = 0;
    for (const row of rows) {
      const result = await set(
        executeDueWorkflowAutomationsForAutomation$,
        row.id,
        signal,
      );
      executed += result.executed;
      skipped += result.skipped;
    }
    return {
      status: 200 as const,
      body: { success: true as const, executed, skipped },
    };
  },
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

const interruptTestWorkflowAutomationResultEmailCallback$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const bodyResult = await get(interruptionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const db = set(writeDb$);
    const [callback] = await db
      .select({
        id: agentRunCallbacks.id,
        payload: agentRunCallbacks.payload,
      })
      .from(agentRunCallbacks)
      .where(
        and(
          eq(agentRunCallbacks.runId, bodyResult.data.run_id),
          eq(
            agentRunCallbacks.internalKind,
            "workflow-automation:result-email",
          ),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!callback) {
      throw new Error("Official Automation result email callback not found");
    }

    await db
      .update(agentRunCallbacks)
      .set({ attempts: 1, lastAttemptAt: nowDate() })
      .where(eq(agentRunCallbacks.id, callback.id));
    signal.throwIfAborted();
    const result = await set(
      handleWorkflowAutomationResultEmailInternalCallback$,
      {
        callbackId: callback.id,
        runId: bodyResult.data.run_id,
        status: "completed",
        payload: callback.payload,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!result.success) {
      throw new Error(result.error);
    }
    return {
      status: 200 as const,
      body: {
        success: true as const,
        callback_id: callback.id,
        skipped: result.skipped ?? false,
      },
    };
  },
);

export const testWorkflowAutomationExecutionRoutes: readonly RouteEntry[] = [
  {
    route: testWorkflowAutomationExecutionContract.executeForAgent,
    handler: executeTestWorkflowAutomationsForAgent$,
  },
  {
    route: testWorkflowAutomationExecutionContract.dispatchCallbacks,
    handler: dispatchTestWorkflowAutomationCallbacks$,
  },
  {
    route: testWorkflowAutomationExecutionContract.interruptResultEmailCallback,
    handler: interruptTestWorkflowAutomationResultEmailCallback$,
  },
];
