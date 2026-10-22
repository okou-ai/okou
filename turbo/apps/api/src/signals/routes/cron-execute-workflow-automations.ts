import { cronExecuteWorkflowAutomationsContract } from "@okouai/api-contracts/contracts/cron";
import { command } from "ccstate";

import { logger } from "../../lib/log";
import type { RouteEntry } from "../route-entry";
import { executeDueNotionAutomationEvents$ } from "../services/notion-automation-event.service";
import { executeDueStripeAutomationEvents$ } from "../services/stripe-automation-event.service";
import { executeDueWorkflowAutomations$ } from "../services/workflow-automation-poller.service";
import { executeOfficialWorkflowReconciliationWork$ } from "../services/official-workflow-reconciliation-worker.service";
import {
  reconcileProactiveWorkflows$,
  reconcileRunnableProactiveJobs$,
} from "../services/proactive-workflows-lifecycle.service";
import { recoverDueOfficialWorkflowSchedules$ } from "../services/official-workflow-schedule-recovery.service";
import { reconcilePendingProactiveJobsCompletions$ } from "../services/proactive-jobs-settlement.service";
import { settle } from "../utils";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const log = logger("OfficialWorkflowReconciliationCron");

// The cron tick polls the workflow_automations table; runs carry generic
// trigger provenance and inject the workflow skill via the agent's attachment.
const executeWorkflowAutomationsRoute$: RouteEntry["handler"] = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const reconciliation = await settle(
      set(executeOfficialWorkflowReconciliationWork$, signal),
      signal,
    );
    if (!reconciliation.ok) {
      log.error("Official Workflow reconciliation worker failed", {
        error: reconciliation.error,
      });
    }
    const proactive = await settle(
      set(reconcileProactiveWorkflows$, signal),
      signal,
    );
    if (!proactive.ok) {
      log.error("Proactive workflow reconciliation failed", {
        error: proactive.error,
      });
    }
    const completions = await settle(
      set(reconcilePendingProactiveJobsCompletions$, signal),
      signal,
    );
    if (!completions.ok) {
      log.error("Jobs completion reconciliation failed", {
        error: completions.error,
      });
    }
    const jobs = await settle(
      set(reconcileRunnableProactiveJobs$, signal),
      signal,
    );
    if (!jobs.ok) {
      log.error("Runnable Jobs reconciliation failed", { error: jobs.error });
    }
    const recovery = await settle(
      set(recoverDueOfficialWorkflowSchedules$, signal),
      signal,
    );
    if (!recovery.ok) {
      log.error("Official Workflow schedule recovery failed", {
        error: recovery.error,
      });
    }
    const result = await set(executeDueWorkflowAutomations$, signal);
    const notionResult = await set(executeDueNotionAutomationEvents$, signal);
    const stripeResult = await set(executeDueStripeAutomationEvents$, signal);
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        success: true as const,
        executed:
          result.executed + notionResult.executed + stripeResult.executed,
        skipped:
          result.skipped +
          notionResult.skipped +
          stripeResult.skipped +
          stripeResult.failed +
          stripeResult.retried,
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
