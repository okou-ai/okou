import type { TestContext } from "../../../../__tests__/test-context";
import type { ApiTestUser } from "./api-bdd";
import { createChatFilesBddApi } from "./api-bdd-chat-files";
import { createRunsApi } from "./api-bdd-runs";
import { okouTokenFromExecution } from "./chat-events-fixture";

/** Obtain publication credentials through chat send and real Runner dispatch. */
export async function launchCatalogPublisher(
  context: TestContext,
  owner: ApiTestUser,
) {
  const runs = createRunsApi(context);
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  const runnerGroup = await runs.configureRunnerGroup();
  await runs.grantProEntitlement(owner);
  await runs.ensurePersonalSubscriptionModel(owner, {
    model: "claude-fable-5-1",
  });
  const run = await createChatFilesBddApi(context).sendAndLaunch(owner, {
    prompt: "Publish a catalog artifact",
  });
  await runs.heartbeatRunner(runnerGroup);
  const execution = await runs.executionInput(run.runId);
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: false,
  });
  return { bearerToken: okouTokenFromExecution(execution) };
}
