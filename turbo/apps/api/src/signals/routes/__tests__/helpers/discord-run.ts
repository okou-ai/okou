import type { TestContext } from "../../../../__tests__/test-context";
import { createBddApi, type ApiTestUser } from "./api-bdd";
import { createChatFilesBddApi } from "./api-bdd-chat-files";
import { createRunsApi } from "./api-bdd-runs";

/** A real chat-admitted Run and Runner claim, never a locally signed JWT. */
export async function claimPublicDiscordTestRun(
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
  const runnerGroup = runs.configureRunnerGroup();
  await runs.heartbeatRunner(runnerGroup);
  const agent = await bdd.createAgent(actor, {
    displayName: "Discord native caller",
  });
  const sent = await createChatFilesBddApi(context).sendAndLaunch(actor, {
    agentId: agent.agentId,
    prompt: "Use the Discord integration",
  });
  const claim = await runs.claimRunnerJob(sent.runId);
  const token = claim.platformEnvironment.OKOU_TOKEN;
  if (!token) {
    throw new Error("Expected the Runner claim to issue an Okou run token");
  }
  return { ...sent, claim, headers: { authorization: `Bearer ${token}` } };
}
