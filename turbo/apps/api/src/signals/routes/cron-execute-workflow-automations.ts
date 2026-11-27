import { cronExecuteWorkflowAutomationsContract } from "@okouai/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route-entry";
import { executeDueNotionAutomationEvents$ } from "../services/notion-automation-event.service";
import { executeDueWorkflowAutomations$ } from "../services/workflow-automation-poller.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const executeWorkflowAutomationsRoute$: RouteEntry["handler"] = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const result = await set(executeDueWorkflowAutomations$, signal);
    const notionResult = await set(executeDueNotionAutomationEvents$, signal);
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        success: true as const,
        executed: result.executed + notionResult.executed,
        skipped: result.skipped + notionResult.skipped,
      },
    };
  },
);

export const cronExecuteWorkflowAutomationsRoutes: readonly RouteEntry[] = [
  {
    route: cronExecuteWorkflowAutomationsContract.execute,
    handler: executeWorkflowAutomationsRoute$,
  },
];
