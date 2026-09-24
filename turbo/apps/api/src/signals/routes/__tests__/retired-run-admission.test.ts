import { HttpResponse, http } from "msw";

import { testContext } from "../../../__tests__/test-context";

import { server } from "../../../mocks/server";
import {
  admitGoalQueueEventFixture,
  activateLegacyGoalPiFixture,
  claimPreparedGoalFixture,
  drainChatThreadQueueFixture,
  seedGoalForRunFixture,
  setLegacyGoalRunOriginFixture,
} from "../../../test-fixtures/goal-queue";

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

  it("rejects a captured pending Goal runner job without manufacturing terminal history", async () => {
    const fixture = await seedGoalApiFixture();
    const goal = await seedGoalForRunFixture(
      fixture.runId,
      "captured Goal job",
    );
    await setLegacyGoalRunOriginFixture(fixture.runId, goal.id);
    const api = createRunsApi(context);
    await api.heartbeatRunner(fixture.runnerGroup);
    const claim = await api.requestClaimRunnerJob(true, fixture.runId, [404]);
    expect(claim.status).toBe(404);
    const run = await api.readRun(fixture.actor, fixture.runId);
    expect(run.status).toBe("pending");
    expect(
      (await api.requestClaimRunnerJob(true, fixture.runId, [404])).status,
    ).toBe(404);
    const events = await createChatFilesBddApi(context).listThreadEvents(
      fixture.actor,
      fixture.threadId,
    );
    expect(
      events.events.filter((item) => {
        return item.eventType === "run.cancelled";
      }),
    ).toHaveLength(0);
  });

  it("does not treat a manual run's historical goal id as Goal execution authority", async () => {
    const fixture = await seedGoalApiFixture();
    const goal = await seedGoalForRunFixture(
      fixture.runId,
      "historical association",
    );
    await setLegacyGoalRunOriginFixture(fixture.runId, goal.id, "chat");
    await createRunsApi(context).heartbeatRunner(fixture.runnerGroup);
    const claim = await createRunsApi(context).requestClaimRunnerJob(
      true,
      fixture.runId,
      [200],
    );
    expect(claim.status).toBe(200);
    await createRunsApi(context).requestCancelRun(
      fixture.actor,
      fixture.runId,
      [200],
    );
  });

  it("rejects an already-prepared final Goal claim without replacing its input", async () => {
    const fixture = await seedGoalApiFixture();
    const goal = await seedGoalForRunFixture(
      fixture.runId,
      "captured preparation",
    );
    const event = await admitGoalQueueEventFixture({
      threadId: fixture.threadId,
      goalId: goal.id,
      objectiveBrief: goal.objectiveBrief,
    });
    if (event.kind !== "inserted") {
      throw new Error("Expected a historical Goal input");
    }
    await expect(
      claimPreparedGoalFixture({
        goal,
        eventId: event.eventId,
        runId: fixture.runId,
      }),
    ).resolves.toBe("lost");
    await drainChatThreadQueueFixture({
      threadId: fixture.threadId,
      signal: context.signal,
    });
    const events = await createChatFilesBddApi(context).listThreadEvents(
      fixture.actor,
      fixture.threadId,
    );
    expect(
      events.events.filter((item) => {
        return item.revokesEventId === event.eventId;
      }),
    ).toStrictEqual([]);
  });

  it("rejects a captured API-owned Pi Goal before any provider request", async () => {
    const fixture = await seedGoalApiFixture();
    const goal = await seedGoalForRunFixture(
      fixture.runId,
      "old Pi activation",
    );
    await setLegacyGoalRunOriginFixture(fixture.runId, goal.id);
    let providerRequests = 0;
    server.use(
      http.post("https://api.openai.com/v1/responses", () => {
        providerRequests++;
        return HttpResponse.json(
          { error: "Retired Goal must not execute" },
          { status: 500 },
        );
      }),
    );
    await activateLegacyGoalPiFixture(fixture.runId, context.signal);
    expect(providerRequests).toBe(0);
    expect(
      (await createRunsApi(context).readRun(fixture.actor, fixture.runId))
        .status,
    ).toBe("pending");
  });
});
