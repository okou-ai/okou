import type { TestContext } from "../../../../__tests__/test-context";
import { createBddApi, type ApiTestUser } from "./api-bdd";
import { createChatFilesBddApi } from "./api-bdd-chat-files";
import { createRunsApi } from "./api-bdd-runs";

/** Credentials issued by a chat-admitted execution. */
export async function launchPublicDiscordTestRun(
  context: TestContext,
  actor: ApiTestUser,
) {
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  await runs.grantProEntitlement(actor);
  await runs.ensurePersonalSubscriptionModel(actor);
  const runnerGroup = await runs.configureRunnerGroup();
  await runs.heartbeatRunner(runnerGroup);
  const agent = await bdd.createAgent(actor, {
    displayName: "Discord native caller",
  });
  const sent = await createChatFilesBddApi(context).sendAndLaunch(actor, {
    agentId: agent.agentId,
    prompt: "Use the Discord integration",
  });
  const execution = await runs.executionInput(sent.runId);
  const token = execution.platformEnvironment.OKOU_TOKEN;
  if (!token) {
    throw new Error("Expected the execution to issue an Okou run token");
  }
  return {
    ...sent,
    execution,
    headers: { authorization: `Bearer ${token}` },
  };
}
