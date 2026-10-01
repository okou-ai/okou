import type { TestContext } from "../../../../__tests__/test-context";
import type { ApiTestUser } from "./api-bdd";
import { createRunsApi } from "./api-bdd-runs";

/** Application session identity published by a completed run, not its tables. */
export async function readCompletedRunSessionId(
  context: TestContext,
  actor: ApiTestUser,
  runId: string,
): Promise<string> {
  const run = await createRunsApi(context).readRun(actor, runId);
  const sessionId = run.result?.agentSessionId;
  if (!sessionId) {
    throw new Error(`Completed run ${runId} has no public application session`);
  }
  return sessionId;
}
