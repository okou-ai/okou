import { computed } from "ccstate";
import { runRunnerContract } from "@okouai/api-contracts/client/run-routes";
import type { SandboxStartupPath } from "@okouai/api-contracts/contracts/runner-primitives";
import { apiClient$ } from "../api-client.ts";
import { currentRunId$, activityDetail$ } from "./activity-signals.ts";
import { accept } from "../../lib/accept.ts";
import type { LogStatus } from "../okou-page/log-types.ts";

interface ActivityRunner {
  runId: string;
  status: LogStatus;
  runner: {
    sandboxStartupPath: SandboxStartupPath | null;
    runnerHostname: string | null;
    runnerVersion: string | null;
    runnerId: string | null;
    runnerHeartbeatGeneration: number | null;
  };
}

export const activityRunner$ = computed(async (get) => {
  const runId = get(currentRunId$);
  const detail = await get(activityDetail$);
  if (!runId || !detail || detail.id !== runId) {
    return null;
  }

  const client = get(apiClient$)(runRunnerContract);
  const result = await accept(
    client.getRunner({ params: { id: runId } }),
    [200],
  );
  return {
    runId,
    status: detail.status,
    runner: {
      sandboxStartupPath: result.body.sandboxStartupPath,
      runnerHostname: result.body.runnerHostname ?? null,
      runnerVersion: result.body.runnerVersion ?? null,
      runnerId: result.body.runnerId ?? null,
      runnerHeartbeatGeneration: result.body.runnerHeartbeatGeneration ?? null,
    },
  } satisfies ActivityRunner;
});
