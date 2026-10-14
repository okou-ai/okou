import { computed } from "ccstate";
import { runRunnerContract } from "@okouai/api-contracts/contracts/run-routes";
import type {
  SandboxReuseResult,
  HomeReuseResult,
} from "@okouai/api-contracts/contracts/runner-primitives";
import { apiClient$ } from "../api-client.ts";
import { currentRunId$, activityDetail$ } from "./activity-signals.ts";
import { accept } from "../../lib/accept.ts";
import type { LogStatus } from "../okou-page/log-types.ts";

interface ActivityRunner {
  runId: string;
  status: LogStatus;
  runner: {
    sandboxReuseResult: SandboxReuseResult | null;
    homeReuseResult: HomeReuseResult | null;
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
      sandboxReuseResult: result.body.sandboxReuseResult,
      homeReuseResult: result.body.homeReuseResult ?? null,
      runnerHostname: result.body.runnerHostname ?? null,
      runnerVersion: result.body.runnerVersion ?? null,
      runnerId: result.body.runnerId ?? null,
      runnerHeartbeatGeneration: result.body.runnerHeartbeatGeneration ?? null,
    },
  } satisfies ActivityRunner;
});
