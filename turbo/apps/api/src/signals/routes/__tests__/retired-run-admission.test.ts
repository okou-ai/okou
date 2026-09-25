import { testContext } from "../../../__tests__/test-context";

import { flushWaitUntilForTest } from "../../context/wait-until";

import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
createRouteMocks(context);

interface GoalApiAuthFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly agentId: string;
}

interface GoalApiFixture extends GoalApiAuthFixture {
  readonly actor: ApiTestUser;
  readonly runnerGroup: string;
}

async function seedGoalApiFixture(): Promise<GoalApiFixture> {
  const bdd = createBddApi(context);
  const api = createRunsApi(context);
  const chat = createChatFilesBddApi(context);
  const actor = bdd.user();
  if (!actor.orgId) {
    throw new Error("Goal fixtures require an org-scoped actor");
  }
  bdd.acceptAgentStorageWrites();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  const runnerGroup = api.configureRunnerGroup();
  await api.grantProEntitlement(actor);
  const { providerId } = await api.ensureOrgModelProvider(actor);
  // Retired Goal admission is checked against an otherwise claimable run.
  await api.updateOrgModelPolicies(actor, [
    {
      model: "claude-fable-5-1",
      isDefault: true,
      defaultProviderType: "anthropic-api-key",
      credentialScope: "org",
      modelProviderId: providerId,
    },
  ]);
  const agent = await bdd.createAgent(actor, {
    displayName: "Goal Agent",
    visibility: "private",
  });
  const sent = await chat.requestSendEvent(
    actor,
    {
      agentId: agent.agentId,
      prompt: "goal precondition",
      model: "claude-fable-5-1",
    },
    [201],
  );
  if (sent.status !== 201 || sent.body.runId === null) {
    throw new Error("Expected the chat send to create a thread-linked run");
  }
  await flushWaitUntilForTest();
  return {
    actor,
    runnerGroup,
    orgId: actor.orgId,
    userId: actor.userId,
    runId: sent.body.runId,
    threadId: sent.body.threadId,
    agentId: agent.agentId,
  };
}

describe("retired run admission", () => {
  it("rejects obsolete caller-supplied execution authority while ordinary creation remains supported", async () => {
    const fixture = await seedGoalApiFixture();
    const api = createRunsApi(context);
    const result = await api.requestCreateRunUnchecked(
      fixture.actor,
      {
        agentId: fixture.agentId,
        prompt: "captured Goal request",
        triggerSource: "goal",
      },
      [400],
    );
    expect(result.status).toBe(400);
    expect((await api.readRun(fixture.actor, fixture.runId)).status).toBe(
      "pending",
    );
  });
});
