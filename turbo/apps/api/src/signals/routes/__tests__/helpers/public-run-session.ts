import type { TestContext } from "../../../../__tests__/test-context";
import type { ApiTestUser } from "./api-bdd";
import { createRunsApi } from "./api-bdd-runs";

/** Native Framework identity published by the completed Run. */
export async function readCompletedRunSessionId(
  context: TestContext,
  actor: ApiTestUser,
  runId: string,
): Promise<string> {
  const run = await createRunsApi(context).readRun(actor, runId);
  const sessionId = run.result?.frameworkSessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error(`Completed run ${runId} has no public native session`);
  }
  return sessionId;
}
