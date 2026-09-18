import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, onTestFinished } from "vitest";
import { createDeferredPromise } from "../../utils";
import {
  resolveChatEventRecommendedFollowups,
  type ChatFollowupOrigin,
} from "@okouai/api-contracts/contracts/chat-threads";
import { cronRefreshFollowupProfilesContract } from "@okouai/api-contracts/contracts/cron";
import { testFollowupProfilesContract } from "@okouai/api-contracts/contracts/test-followup-profiles";
import { FeatureSwitchKey } from "@okouai/core";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { cronRefreshFollowupProfilesRoutes } from "../cron-refresh-followup-profiles";
import { testFollowupProfilesRoutes } from "../test-followup-profiles";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const runs = createRunsApi(context);
const callbacks = createChatCallbacksApi(context);
const webhooks = createWebhookCallbackApi(context);
const PREFERENCE =
  "For code reviews, prefers a concise verification checklist.";
const GENERIC = "Check the implementation";
const PERSONALIZED = "Give me a concise verification checklist";
type OrgTestUser = ApiTestUser & { readonly orgId: string };

async function actorWithAgent(actor = bdd.user()) {
  if (!actor.orgId) {
    throw new Error("Expected an organization test user");
  }
  callbacks.acceptChatObjectStorage();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  callbacks.disableVapid();
  const runnerGroup = runs.configureRunnerGroup();
  await runs.grantProEntitlement(actor);
  await runs.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "Followup preference test",
  });
  return {
    actor: { ...actor, orgId: actor.orgId },
    agentId: agent.agentId,
    runnerGroup,
  };
}

async function refresh(actor: OrgTestUser) {
  mockEnv("ENV", "development");
  return await accept(
    setupApp({ context, routes: testFollowupProfilesRoutes })(
      testFollowupProfilesContract,
    ).refresh({
      body: { orgId: actor.orgId, userId: actor.userId },
    }),
    [200],
  );
}

async function completedTurn(
  fixture: Awaited<ReturnType<typeof actorWithAgent>>,
  prompt: string,
  options: {
    readonly threadId?: string;
    readonly origins?: readonly ChatFollowupOrigin[];
  } = {},
) {
  const clientEventId = randomUUID();
  const request = {
    agentId: fixture.agentId,
    prompt,
    clientEventId,
    ...(options.threadId
      ? { threadId: options.threadId }
      : { model: "claude-sonnet-5" as const }),
    ...(options.origins ? { followupOrigins: options.origins } : {}),
  };
  const sent = await chat.requestSendEvent(fixture.actor, request, [201]);
  if (sent.status !== 201 || !sent.body.runId) {
    throw new Error("Expected a dispatched run");
  }
  const { runId, threadId } = sent.body;
  await runs.heartbeatRunner(fixture.runnerGroup);
  let claim: Awaited<ReturnType<typeof runs.requestClaimRunnerJob>> | undefined;
  await expect
    .poll(
      async () => {
        claim = await runs.requestClaimRunnerJob(true, runId, [200, 404]);
        return claim.status;
      },
      { interval: 100, timeout: 10_000 },
    )
    .toBe(200);
  if (!claim || claim.status !== 200) {
    throw new Error("Expected a runner claim");
  }
  const headers = { authorization: `Bearer ${claim.body.sandboxToken}` };
  await webhooks.requestAgentEvents(
    {
      runId,
      events: [
        {
          type: "assistant",
          sequenceNumber: 0,
          message: {
            content: [
              {
                type: "text",
                text: "The code review is complete. Check the result next.",
              },
            ],
          },
        },
      ],
    },
    headers,
    [200],
  );
  const completion = {
    runId,
    exitCode: 0,
    checkpoint: {
      cliAgentType: "claude-code" as const,
      cliAgentSessionId: `followup-test-${runId}`,
      cliAgentSessionHistoryHash: createHash("sha256")
        .update(`bdd chat session history ${runId}`)
        .digest("hex"),
    },
    lastEventSequence: 0,
  };
  await webhooks.requestAgentComplete(completion, headers, [200]);
  await flushWaitUntilForTest();
  const events = await chat.listThreadEvents(fixture.actor, threadId);
  const event = events.events
    .filter((item) => {
      return item.eventType === "output.followups";
    })
    .at(-1);
  if (!event) {
    throw new Error("Expected recommended followups");
  }
  return { threadId, event, request, completion, headers };
}

function generationMock(
  learningRequests: string[],
  beforeLearning?: () => Promise<void>,
) {
  mockOptionalEnv("OPENROUTER_API_KEY", "followup-test-provider-key");
  callbacks.mockOpenRouterCompletions(async (body) => {
    const system = body.messages[0]?.content ?? "";
    const input = body.messages[1]?.content ?? "";
    if (system.includes("Summarize preferences useful")) {
      learningRequests.push(input);
      await beforeLearning?.();
      return JSON.stringify({ preferences: PREFERENCE });
    }
    if (system.includes("recommended follow-up messages")) {
      return JSON.stringify([
        {
          prompt: input.includes(PREFERENCE) ? PERSONALIZED : GENERIC,
          kind: "talk",
        },
      ]);
    }
    return "Code review";
  });
}

describe("personalized followups", () => {
  it("learns from completed inputs, distinguishes adoption and edits, and applies only retained evidence", async () => {
    const fixture = await actorWithAgent();
    await updateFeatureSwitchesForUser(context, fixture.actor, {
      [FeatureSwitchKey.PersonalizedFollowups]: true,
    });
    const learningRequests: string[] = [];
    generationMock(learningRequests);
    const first = await completedTurn(
      fixture,
      "Review the code; keep the verification checklist concise.",
    );
    const second = await completedTurn(fixture, GENERIC, {
      threadId: first.threadId,
      origins: [{ eventId: first.event.id, index: 0 }],
    });
    const third = await completedTurn(
      fixture,
      `${GENERIC}; use a concise checklist.`,
      {
        threadId: first.threadId,
        origins: [{ eventId: second.event.id, index: 0 }],
      },
    );
    await completedTurn(fixture, "A concise checklist is enough.", {
      threadId: first.threadId,
      origins: [{ eventId: randomUUID(), index: 0 }],
    });
    expect((await refresh(fixture.actor)).body.attempted).toBe(0);
    const fifth = await completedTurn(
      fixture,
      "Please keep code review checklists concise.",
      { threadId: first.threadId },
    );
    // The caller can retry its accepted event without contributing another sample.
    await chat.requestSendEvent(fixture.actor, fifth.request, [201]);
    await webhooks.requestAgentComplete(fifth.completion, fifth.headers, [200]);
    await flushWaitUntilForTest();
    expect((await refresh(fixture.actor)).body.attempted).toBe(1);
    expect(learningRequests).toHaveLength(1);
    expect(learningRequests[0]?.match(/"inputEventId"/g)).toHaveLength(5);
    expect(learningRequests[0]).toContain('"kind":"adopted"');
    expect(learningRequests[0]).toContain('"kind":"edited"');
    expect(learningRequests[0]).toContain('"kind":"unresolved"');
    expect(learningRequests[0]).toContain('"kind":"unattributed"');
    expect((await refresh(fixture.actor)).body.attempted).toBe(0);
    const personalized = await completedTurn(fixture, "Review another change.");
    expect(
      resolveChatEventRecommendedFollowups(personalized.event)[0]?.prompt,
    ).toBe(PERSONALIZED);
    for (const actor of [
      bdd.user({ orgId: fixture.actor.orgId }),
      bdd.user({ userId: fixture.actor.userId }),
    ]) {
      const otherScope = await actorWithAgent(actor);
      await updateFeatureSwitchesForUser(context, otherScope.actor, {
        [FeatureSwitchKey.PersonalizedFollowups]: true,
      });
      const unrelated = await completedTurn(
        otherScope,
        "Review another change.",
      );
      expect(
        resolveChatEventRecommendedFollowups(unrelated.event)[0]?.prompt,
      ).toBe(GENERIC);
    }
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", fixture.runnerGroup);
    await updateFeatureSwitchesForUser(context, fixture.actor, {
      [FeatureSwitchKey.PersonalizedFollowups]: false,
    });
    const disabled = await completedTurn(
      fixture,
      "Review a change with personalization disabled.",
    );
    expect(
      resolveChatEventRecommendedFollowups(disabled.event)[0]?.prompt,
    ).toBe(GENERIC);
    await updateFeatureSwitchesForUser(context, fixture.actor, {
      [FeatureSwitchKey.PersonalizedFollowups]: true,
    });
    await chat.deleteThread(fixture.actor, third.threadId);
    const afterDeletion = await completedTurn(
      fixture,
      "Review the next change.",
    );
    expect(
      resolveChatEventRecommendedFollowups(afterDeletion.event)[0]?.prompt,
    ).toBe(GENERIC);
  });

  it("rejects a profile produced after its source thread is deleted", async () => {
    const fixture = await actorWithAgent();
    await updateFeatureSwitchesForUser(context, fixture.actor, {
      [FeatureSwitchKey.PersonalizedFollowups]: true,
    });
    const started = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!release.settled()) {
        release.resolve(undefined);
      }
    });
    const learningRequests: string[] = [];
    generationMock(learningRequests, async () => {
      started.resolve(undefined);
      await release.promise;
    });
    let sourceThreadId: string | undefined;
    for (let index = 0; index < 5; index++) {
      const turn = await completedTurn(
        fixture,
        `Review change ${index} with a concise checklist.`,
        { threadId: sourceThreadId },
      );
      sourceThreadId = turn.threadId;
    }
    const updating = refresh(fixture.actor);
    await started.promise;
    if (!sourceThreadId) {
      throw new Error("Expected source thread");
    }
    await chat.deleteThread(fixture.actor, sourceThreadId);
    release.resolve(undefined);
    await updating;
    const afterDeletion = await completedTurn(
      fixture,
      "Review another change.",
    );
    expect(
      resolveChatEventRecommendedFollowups(afterDeletion.event)[0]?.prompt,
    ).toBe(GENERIC);
    expect(learningRequests).toHaveLength(1);
  });

  it("keeps generic recommendations and accepts stale origins while personalization is disabled", async () => {
    const fixture = await actorWithAgent();
    const learningRequests: string[] = [];
    generationMock(learningRequests);
    const turn = await completedTurn(fixture, "Review my change.", {
      origins: [{ eventId: randomUUID(), index: 0 }],
    });
    expect(resolveChatEventRecommendedFollowups(turn.event)[0]?.prompt).toBe(
      GENERIC,
    );
    expect((await refresh(fixture.actor)).body.attempted).toBe(0);
    expect(learningRequests).toHaveLength(0);
  });

  it("requires cron authentication", async () => {
    const client = setupApp({
      context,
      routes: cronRefreshFollowupProfilesRoutes,
    })(cronRefreshFollowupProfilesContract);
    expect((await client.refresh({ headers: {} })).status).toBe(401);
    expect(
      (
        await client.refresh({
          headers: { authorization: "Bearer wrong-secret" },
        })
      ).status,
    ).toBe(401);
  });
});
