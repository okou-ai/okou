import { testCronCleanupSandboxesStateContract } from "@okouai/api-contracts/contracts/test-cron-cleanup-sandboxes-state";

import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { testCronCleanupSandboxesStateRoutes } from "../../test-cron-cleanup-sandboxes-state";

export type TestTerminalRunStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout";

export async function transitionRunToTerminal(
  context: TestContext,
  runId: string,
  status: TestTerminalRunStatus,
) {
  return await accept(
    setupApp({ context, routes: testCronCleanupSandboxesStateRoutes })(
      testCronCleanupSandboxesStateContract,
    ).action({
      body: { action: "transition-run-terminal", run_id: runId, status },
    }),
    [200],
  );
}

export async function transitionRunToTimeout(
  context: TestContext,
  runId: string,
) {
  return await transitionRunToTerminal(context, runId, "timeout");
}
