import { randomUUID } from "node:crypto";

import { authContract } from "@okouai/api-contracts/contracts/auth";
import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { instructionsContract } from "@okouai/api-contracts/contracts/instructions";
import {
  logsByIdContract,
  logsListContract,
} from "@okouai/api-contracts/contracts/logs";
import { onboardingCompleteContract } from "@okouai/api-contracts/contracts/onboarding";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import {
  runsByIdContract,
  runsCancelContract,
  runsQueueContract,
} from "@okouai/api-contracts/contracts/run-routes";
import { runnersHeartbeatContract } from "@okouai/api-contracts/contracts/runners";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import {
  webhookClerkContract,
  webhookCompleteContract,
  webhookStripeContract,
} from "@okouai/api-contracts/contracts/webhooks";
import {
  workflowAutomationsContract,
  workflowsCollectionContract,
} from "@okouai/api-contracts/contracts/workflows";
import { beforeAll, describe, expect, it } from "vitest";

import { setupAppWithRoutes } from "../../../__tests__/test-app";
import { testContext } from "../../../__tests__/test-context";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { createAppWithRoutes } from "../../../app-factory-core";
import { mockEnv, mockOptionalEnv, optionalEnv } from "../../../lib/env";
import { now, nowDate } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { authMeRoutes } from "../auth-me";
import { billingStatusRoutes } from "../billing-status";
import { chatEventsRoutes } from "../chat-events";
import { instructionsRoutes } from "../instructions";
import { logsRoutes } from "../logs";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { onboardingCompleteRoutes } from "../onboarding-complete";
import { runnersRoutes } from "../runners";
import { runsRoutes } from "../runs";
import { runsCancelRoutes } from "../runs-cancel";
import { userModelPreferenceRoutes } from "../user-model-preference";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { webhooksStripeRoutes } from "../webhooks-stripe";
import { webhooksWorkflowAutomationsRoutes } from "../webhooks-workflow-automations";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  createWebhookCallbackApi,
  deliverOrganizationCreated,
} from "./helpers/api-bdd-webhooks";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { mockClerkUsers } from "./helpers/clerk-users";
import { holdDownloadSigning } from "./helpers/hold-download-signing";
import { publicChatActor } from "./helpers/public-chat-actor";
import { publicRunOwner } from "./helpers/public-run-owner";
import {
  generatedStripeCustomerId,
  generatedStripeSubscriptionId,
  postSubscriptionInvoicePaid,
  refreshConcurrencyEntitlement,
} from "./helpers/stripe-billing-webhook";

const WARMUP_RUN_ID = "00000000-0000-4000-8000-000000000001";
const WARMUP_WORKFLOW_ID = "00000000-0000-4000-8000-000000000002";

const WARMUP_HEARTBEAT_BODY = Object.freeze({
  runnerId: "00000000-0000-4000-8000-000000000003",
  group: "vm0/warmup",
  snapshotGeneration: 1,
  snapshotSequence: 1,
  totalVcpu: 8,
  totalMemoryMb: 16_384,
  maxConcurrent: 2,
  allocatedVcpu: 0,
  allocatedMemoryMb: 0,
  runningCount: 0,
  admittableProfiles: Object.freeze(["vm0/default"]),
  heldSandboxStates: Object.freeze([]),
  heldHomeStates: Object.freeze([]),
  activeReuseProducers: Object.freeze([]),
  mode: "running" as const,
});

function clerkProfile(actor: ApiTestUser) {
  const emailId = `email_${actor.userId}`;
  return {
    id: actor.userId,
    emailAddresses: [{ id: emailId, emailAddress: actor.email }],
    primaryEmailAddressId: emailId,
    firstName: "BDD",
    lastName: "User",
  };
}

describe("run-reads.bdd", () => {
  const context = testContext();
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  const reads = createRunReadsApi(context);
  const chat = createChatFilesBddApi(context);
  const webhooks = createWebhookCallbackApi(context);
  const workflows = createWorkflowsBddApi(context);
  const fixture = createChatEventsFixture(context);

  const authMeWarmup = setupAppWithRoutes({ context, routes: authMeRoutes })(
    authContract,
  );
  const onboardingWarmup = setupAppWithRoutes({
    context,
    routes: onboardingCompleteRoutes,
  })(onboardingCompleteContract);
  const billingStatusWarmup = setupAppWithRoutes({
    context,
    routes: billingStatusRoutes,
  })(billingStatusContract);
  const providersWarmup = setupAppWithRoutes({
    context,
    routes: meModelProvidersUpsertRoutes,
  })(personalModelProvidersMainContract);
  const modelPrefWarmup = setupAppWithRoutes({
    context,
    routes: userModelPreferenceRoutes,
  })(userModelPreferenceContract);
  const instructionsWarmup = setupAppWithRoutes({
    context,
    routes: instructionsRoutes,
  })(instructionsContract);
  const chatEventsWarmup = setupAppWithRoutes({
    context,
    routes: chatEventsRoutes,
  })(chatEventsContract);
  const logsListWarmup = setupAppWithRoutes({ context, routes: logsRoutes })(
    logsListContract,
  );
  const logsByIdWarmup = setupAppWithRoutes({ context, routes: logsRoutes })(
    logsByIdContract,
  );
  const runsByIdWarmup = setupAppWithRoutes({ context, routes: runsRoutes })(
    runsByIdContract,
  );
  const runsQueueWarmup = setupAppWithRoutes({ context, routes: runsRoutes })(
    runsQueueContract,
  );
  const runsCancelWarmup = setupAppWithRoutes({
    context,
    routes: runsCancelRoutes,
  })(runsCancelContract);
  const runnersWarmup = setupAppWithRoutes({ context, routes: runnersRoutes })(
    runnersHeartbeatContract,
  );
  const completeWarmup = setupAppWithRoutes({
    context,
    routes: webhooksAgentCompleteRoutes,
  })(webhookCompleteContract);
  const clerkWebhookWarmup = setupAppWithRoutes({
    context,
    routes: webhooksClerkRoutes,
  })(webhookClerkContract);
  const stripeWebhookWarmup = setupAppWithRoutes({
    context,
    routes: webhooksStripeRoutes,
  })(webhookStripeContract);
  const workflowsWarmup = setupAppWithRoutes({
    context,
    routes: workflowsRoutes,
  })(workflowsCollectionContract);
  const automationsWarmup = setupAppWithRoutes({
    context,
    routes: workflowAutomationsRoutes,
  })(workflowAutomationsContract);

  beforeAll(async () => {
    const previousClerkSecret = optionalEnv("CLERK_WEBHOOK_SIGNING_SECRET");
    const previousStripeSecret = optionalEnv("STRIPE_WEBHOOK_SECRET");
    const warmed = await settleIncludingAbort(async () => {
      context.mocks.clerk.authenticateRequest.mockResolvedValue({
        isAuthenticated: false,
      });
      mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", "whsec_warmup_clerk");
      mockOptionalEnv("STRIPE_WEBHOOK_SECRET", "whsec_warmup_stripe");
      context.mocks.clerk.verifyWebhook.mockRejectedValueOnce(
        new Error("warmup"),
      );

      await Promise.all([
        authMeWarmup.me({ headers: {} }),
        onboardingWarmup.complete({ headers: {}, body: {} }),
        billingStatusWarmup.get({ headers: {} }),
        providersWarmup.upsert({
          headers: {},
          body: { type: "claude-code-oauth-token", secret: "warmup" },
        }),
        modelPrefWarmup.update({
          headers: {},
          body: { selectedModel: "claude-fable-5-1", serviceTier: null },
        }),
        instructionsWarmup.update({ headers: {}, body: { content: "warmup" } }),
        chatEventsWarmup.send({
          headers: {},
          body: {
            prompt: "warmup",
            hasTextContent: true,
            userMessage: {
              version: 1,
              parts: [{ type: "text", text: "warmup" }],
            },
          },
        }),
        logsListWarmup.list({ headers: {}, query: {} }),
        logsByIdWarmup.getById({ headers: {}, params: { id: WARMUP_RUN_ID } }),
        runsByIdWarmup.getById({ headers: {}, params: { id: WARMUP_RUN_ID } }),
        runsQueueWarmup.getQueue({ headers: {} }),
        runsCancelWarmup.cancel({ headers: {}, params: { id: WARMUP_RUN_ID } }),
        runnersWarmup.heartbeat({
          headers: {},
          body: {
            ...WARMUP_HEARTBEAT_BODY,
            admittableProfiles: [...WARMUP_HEARTBEAT_BODY.admittableProfiles],
            heldSandboxStates: [...WARMUP_HEARTBEAT_BODY.heldSandboxStates],
            heldHomeStates: [...WARMUP_HEARTBEAT_BODY.heldHomeStates],
            activeReuseProducers: [
              ...WARMUP_HEARTBEAT_BODY.activeReuseProducers,
            ],
          },
        }),
        completeWarmup.complete({
          headers: {},
          body: { runId: WARMUP_RUN_ID, exitCode: 0 },
        }),
        clerkWebhookWarmup.post({ body: "{}", extraHeaders: {} }),
        stripeWebhookWarmup.post({ body: "{}", extraHeaders: {} }),
        workflowsWarmup.create({
          headers: {},
          body: { name: "warmup", visibility: "public" },
        }),
        automationsWarmup.create({
          headers: {},
          params: { workflowId: WARMUP_WORKFLOW_ID },
          body: { kind: "event", eventType: "webhook-received" },
        }),
        createAppWithRoutes({
          signal: context.signal,
          routes: webhooksWorkflowAutomationsRoutes,
        }).request("/api/webhooks/workflow-automations/warmup-token", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": "9999999",
          },
          body: "{}",
        }),
      ]);
    });
    mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", previousClerkSecret);
    mockOptionalEnv("STRIPE_WEBHOOK_SECRET", previousStripeSecret);
    if (!warmed.ok) {
      throw warmed.error;
    }
  });

  async function onboardWorkspaceMember(orgId: string) {
    const member = bdd.user({ orgId, orgRole: "org:member" });
    const memberOwner = publicRunOwner(context, member);
    await bdd.completeOnboarding(member);
    const { model } = await runs.ensurePersonalSubscriptionModel(member);
    return { member, memberOwner, model };
  }

  async function findRunIdByPrompt(
    actor: ApiTestUser,
    prompt: string,
  ): Promise<string> {
    const list = await reads.requestListLogs(actor, { limit: 20 }, [200]);
    const match = list.body.data.find((entry) => {
      return entry.prompt === prompt;
    });
    if (!match) {
      throw new Error(`Expected launched run with prompt "${prompt}"`);
    }
    return match.id;
  }

  it(
    "run-reads.bdd-027 filters run logs by status and source",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const seeded = await seedTeamCancelledRuns({ includeMember: false });

      const [webFiltered, webLimited, telegramFiltered] = await Promise.all([
        reads.requestListLogs(
          seeded.owner.actor,
          { status: "cancelled", triggerSource: "web" },
          [200],
        ),
        reads.requestListLogs(
          seeded.owner.actor,
          { status: "cancelled", triggerSource: "web", limit: 1 },
          [200],
        ),
        reads.requestListLogs(
          seeded.owner.actor,
          { triggerSource: "telegram" },
          [200],
        ),
      ]);

      expect(
        webFiltered.body.data
          .map((entry) => {
            return entry.id;
          })
          .sort(),
      ).toStrictEqual([seeded.web1Id, seeded.web2Id].sort());
      expect(webLimited.body.data).toHaveLength(1);
      expect(webLimited.body.pagination.totalPages).toBe(2);
      expect(telegramFiltered.body.data).toStrictEqual([]);
    },
  );

  it(
    "run-reads.bdd-005 (1/2) lists and filters public logs and enforces run detail isolation",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockEnv("CONCURRENT_RUN_LIMIT_CAP", 2);
      const owner = await publicChatActor(context, {
        tier: "pro",
        runner: { maxConcurrent: 4 },
      });
      const {
        member,
        memberOwner,
        model: memberModel,
      } = await onboardWorkspaceMember(owner.actor.orgId ?? "");

      await Promise.all([
        owner.requestSendEvent(
          owner.actor,
          {
            prompt: "target run a",
            model: owner.model,
            clientEventId: randomUUID(),
          },
          [201],
        ),
        owner.requestSendEvent(
          owner.actor,
          {
            prompt: "other run b",
            model: owner.model,
            clientEventId: randomUUID(),
          },
          [201],
        ),
      ]);
      await flushWaitUntilForTest();

      const initialOwnerLogs = await reads.requestListLogs(
        owner.actor,
        { limit: 10 },
        [200],
      );
      const runA = initialOwnerLogs.body.data.find((entry) => {
        return entry.prompt === "target run a";
      });
      const runB = initialOwnerLogs.body.data.find((entry) => {
        return entry.prompt === "other run b";
      });
      if (!runA || !runB) {
        throw new Error("Expected both owner runs A and B to launch");
      }
      const runAToken = runs.dispatchedRun(runA.id).executionContext
        .sandboxToken;
      const runBToken = runs.dispatchedRun(runB.id).executionContext
        .sandboxToken;
      owner.rememberExecution(runA.id, runAToken);
      owner.rememberExecution(runB.id, runBToken);

      await fixture.completeChatRunOk(runB.id, {
        authorization: `Bearer ${runBToken}`,
      });
      await flushWaitUntilForTest();

      await memberOwner.run(() => {
        return chat.requestSendEvent(
          member,
          {
            prompt: "member isolated run",
            model: memberModel,
            clientEventId: randomUUID(),
          },
          [201],
        );
      });
      await flushWaitUntilForTest();
      const memberRunId = await findRunIdByPrompt(
        member,
        "member isolated run",
      );
      memberOwner.rememberExecution(
        memberRunId,
        runs.dispatchedRun(memberRunId).executionContext.sandboxToken,
      );

      const oneHourAgo = now() - 60 * 60 * 1000;
      const [
        ownerDefaultLogs,
        ownerRunningLogs,
        ownerCompletedLimit1,
        ownerCompletedSince,
        ownerRunBDetail,
        ownerUnknownRun,
        ownerMemberRun,
      ] = await Promise.all([
        reads.requestListLogs(owner.actor, {}, [200]),
        reads.requestListLogs(owner.actor, { status: "running" }, [200]),
        reads.requestListLogs(
          owner.actor,
          { status: "completed", limit: 1 },
          [200],
        ),
        reads.requestListLogs(
          owner.actor,
          { status: "completed", since: oneHourAgo },
          [200],
        ),
        runs.requestReadRun(owner.actor, runB.id, [200]),
        runs.requestReadRun(owner.actor, randomUUID(), [404]),
        runs.requestReadRun(owner.actor, memberRunId, [404]),
      ]);

      const [memberDefaultLogs, memberOwnRun] = await Promise.all([
        reads.requestListLogs(member, {}, [200]),
        runs.requestReadRun(member, memberRunId, [200]),
      ]);

      const ownerPrompts = ownerDefaultLogs.body.data.map((entry) => {
        return entry.prompt;
      });
      expect(ownerPrompts).toContain("target run a");
      expect(ownerPrompts).toContain("other run b");

      const memberIds = memberDefaultLogs.body.data.map((entry) => {
        return entry.id;
      });
      expect(memberIds).not.toContain(runA.id);

      const runningIds = ownerRunningLogs.body.data.map((entry) => {
        return entry.id;
      });
      expect(runningIds).toContain(runA.id);
      expect(runningIds).not.toContain(runB.id);

      expect(ownerCompletedLimit1.body.data).toHaveLength(1);
      expect(ownerCompletedLimit1.body.data[0]).toMatchObject({
        id: runB.id,
        startedAt: expect.any(String),
      });
      expect(ownerCompletedSince.body.data).toContainEqual(
        expect.objectContaining({ id: runB.id }),
      );

      expect(ownerRunBDetail.body).toMatchObject({
        runId: runB.id,
        status: "completed",
        startedAt: expect.any(String),
        completedAt: expect.any(String),
      });

      expectApiError(ownerUnknownRun.body);
      expect(ownerUnknownRun.body.error.message).toBe("Agent run not found");
      expectApiError(ownerMemberRun.body);
      expect(ownerMemberRun.body.error.message).toBe("Agent run not found");

      if (!("runId" in memberOwnRun.body)) {
        throw new Error("Expected member to read their own run detail");
      }
      expect(memberOwnRun.body.runId).toBe(memberRunId);
    },
  );

  it(
    "run-reads.bdd-003 groups active concurrency by workspace member",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const owner = await publicChatActor(context, {
        tier: "pro",
        runner: { maxConcurrent: 4 },
      });
      const {
        member,
        memberOwner,
        model: memberModel,
      } = await onboardWorkspaceMember(owner.actor.orgId ?? "");

      await bdd.readMe(owner.actor);
      await bdd.readMe(member);

      await owner.requestSendEvent(
        owner.actor,
        {
          prompt: "owner concurrency run",
          model: owner.model,
          clientEventId: randomUUID(),
        },
        [201],
      );
      await memberOwner.run(() => {
        return chat.requestSendEvent(
          member,
          {
            prompt: "member concurrency run",
            model: memberModel,
            clientEventId: randomUUID(),
          },
          [201],
        );
      });
      await flushWaitUntilForTest();

      const ownerRunId = await findRunIdByPrompt(
        owner.actor,
        "owner concurrency run",
      );
      const memberRunId = await findRunIdByPrompt(
        member,
        "member concurrency run",
      );
      owner.rememberExecution(
        ownerRunId,
        runs.dispatchedRun(ownerRunId).executionContext.sandboxToken,
      );
      memberOwner.rememberExecution(
        memberRunId,
        runs.dispatchedRun(memberRunId).executionContext.sandboxToken,
      );

      const queue = await runs.readRunQueue(owner.actor);
      expect(queue.body.concurrency).toMatchObject({
        tier: "pro",
        limit: 3,
        active: 2,
        available: 1,
      });
      expect(queue.body.concurrency.memberUsage).toHaveLength(2);
      expect(queue.body.concurrency.memberUsage).toStrictEqual(
        expect.arrayContaining([
          {
            userId: owner.actor.userId,
            displayName: "BDD User",
            active: 1,
          },
          {
            userId: member.userId,
            displayName: "BDD User",
            active: 1,
          },
        ]),
      );
    },
  );

  it("run-reads.bdd-002 keeps limited-free plan concurrency visible when the runtime cap is disabled", async () => {
    const member = bdd.user();
    await bdd.bootstrapLimitedFreeOnboarding(member);
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", 0);

    const queue = await runs.readRunQueue(member);
    expect(queue.body.concurrency).toStrictEqual({
      tier: "limited-free-1",
      limit: 2,
      active: 0,
      available: 2,
      memberUsage: [],
    });
  });

  it(
    "run-reads.bdd-004 reads the signed event automation trigger source from logs",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const actor = bdd.user();
      const orgId = actor.orgId;
      if (!orgId) {
        throw new Error("Expected a team workspace owner");
      }
      const owner = publicRunOwner(context, actor);
      fixture.chatCallbacks.acceptChatObjectStorage();
      runs.acceptStorageDownloads();
      runs.acceptTelemetryIngest();
      mockOptionalEnv("OPENROUTER_API_KEY", "bdd-run-reads-auto-key");
      fixture.chatCallbacks.disableVapid();
      const periodEnd = nowDate();
      periodEnd.setTime(now() + 30 * 24 * 60 * 60 * 1000);
      await Promise.all([
        runs.configureRunnerGroup(),
        deliverOrganizationCreated(context, actor),
        postSubscriptionInvoicePaid(context.signal, {
          orgId,
          userId: actor.userId,
          tier: "team",
          customerId: generatedStripeCustomerId(),
          subscriptionId: generatedStripeSubscriptionId(),
          currentPeriodEnd: periodEnd,
        }),
      ]);

      const started = await owner.run(() => {
        return workflows.startEventAutomationRun(actor);
      });
      owner.rememberExecution(
        started.runId,
        runs.dispatchedRun(started.runId).executionContext.sandboxToken,
      );

      await runs.requestCancelRun(actor, started.runId, [200]);

      const [allLogs, detail, filtered] = await Promise.all([
        reads.requestListLogs(actor, {}, [200]),
        reads.requestReadLogById(actor, started.runId, [200]),
        reads.requestListLogs(
          actor,
          { triggerSource: "automation-event" },
          [200],
        ),
      ]);

      expect(allLogs.body.filters.sources).toContain("automation-event");
      expect(detail.body).toMatchObject({
        id: started.runId,
        triggerSource: "automation-event",
      });
      expect(filtered.body.data).toContainEqual(
        expect.objectContaining({
          id: started.runId,
          triggerSource: "automation-event",
        }),
      );
    },
  );

  it(
    "run-reads.bdd-005 (2/2) enforces cap=2 queue visibility, holds cancelled slots until runner completion, then launches queued work",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockEnv("CONCURRENT_RUN_LIMIT_CAP", 2);
      const owner = await publicChatActor(context, {
        tier: "pro",
        runner: { maxConcurrent: 4 },
      });
      const {
        member,
        memberOwner,
        model: memberModel,
      } = await onboardWorkspaceMember(owner.actor.orgId ?? "");

      // Populate userCache only for owner so owner's task carries their email
      // while the uncached member's task reports userEmail: "unknown".
      await bdd.readMe(owner.actor);

      await owner.requestSendEvent(
        owner.actor,
        {
          prompt: "target run a",
          model: owner.model,
          clientEventId: randomUUID(),
        },
        [201],
      );
      await memberOwner.run(() => {
        return chat.requestSendEvent(
          member,
          {
            prompt: "member active run",
            model: memberModel,
            clientEventId: randomUUID(),
          },
          [201],
        );
      });
      await flushWaitUntilForTest();

      const runAId = await findRunIdByPrompt(owner.actor, "target run a");
      const memberRunId = await findRunIdByPrompt(member, "member active run");
      const runAToken =
        runs.dispatchedRun(runAId).executionContext.sandboxToken;
      const memberToken =
        runs.dispatchedRun(memberRunId).executionContext.sandboxToken;
      owner.rememberExecution(runAId, runAToken);
      memberOwner.rememberExecution(memberRunId, memberToken);

      const fullQueue = await runs.readRunQueue(owner.actor);
      expect(fullQueue.body.concurrency).toMatchObject({
        tier: "pro",
        limit: 2,
        active: 2,
        available: 0,
      });
      expect(fullQueue.body.runningTasks).toHaveLength(2);
      expect(fullQueue.body.runningTasks).toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({
            runId: runAId,
            userEmail: owner.actor.email,
            isOwner: true,
          }),
          expect.objectContaining({
            runId: null,
            userEmail: "unknown",
            isOwner: false,
          }),
        ]),
      );

      const waiting = await owner.sendWaitingChatInput(owner.actor, {
        prompt: "queued third prompt",
        model: owner.model,
      });
      await flushWaitUntilForTest();

      await runs.requestCancelRun(owner.actor, runAId, [200]);
      await runs.requestCancelRun(member, memberRunId, [200]);
      await flushWaitUntilForTest();

      const afterCancelQueue = await runs.readRunQueue(owner.actor);
      expect(afterCancelQueue.body.concurrency.active).toBe(2);
      const stillWaiting = await chat.listThreadEvents(
        owner.actor,
        waiting.threadId,
      );
      expect(
        stillWaiting.events.some((event) => {
          return event.runId !== undefined;
        }),
      ).toBeFalsy();

      await Promise.all([
        webhooks.requestAgentComplete(
          { runId: runAId, exitCode: 1, error: "Run cancelled" },
          { authorization: `Bearer ${runAToken}` },
          [200],
        ),
        webhooks.requestAgentComplete(
          { runId: memberRunId, exitCode: 1, error: "Run cancelled" },
          { authorization: `Bearer ${memberToken}` },
          [200],
        ),
      ]);
      await flushWaitUntilForTest();

      const launched = await waiting.launchedRun();
      const launchedToken = runs.dispatchedRun(launched.runId).executionContext
        .sandboxToken;
      owner.rememberExecution(launched.runId, launchedToken);

      const launchedQueue = await runs.readRunQueue(owner.actor);
      expect(launchedQueue.body.concurrency.active).toBe(1);

      await runs.requestCancelRun(owner.actor, launched.runId, [200]);
      await webhooks.requestAgentComplete(
        { runId: launched.runId, exitCode: 1, error: "Run cancelled" },
        { authorization: `Bearer ${launchedToken}` },
        [200],
      );
      await flushWaitUntilForTest();

      const finalQueue = await runs.readRunQueue(owner.actor);
      expect(finalQueue.body.concurrency.active).toBe(0);
    },
  );

  it(
    "run-reads.bdd-007 rejects cancellation after a run completes",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const actor = bdd.user();
      const orgId = actor.orgId;
      if (!orgId) {
        throw new Error("Expected a Pro workspace owner");
      }
      const owner = publicRunOwner(context, actor);
      fixture.chatCallbacks.acceptChatObjectStorage();
      runs.acceptStorageDownloads();
      runs.acceptTelemetryIngest();
      mockOptionalEnv("OPENROUTER_API_KEY", "bdd-run-reads-pro-key");
      fixture.chatCallbacks.disableVapid();
      const periodEnd = nowDate();
      periodEnd.setTime(now() + 30 * 24 * 60 * 60 * 1000);
      const [runnerGroup] = await Promise.all([
        runs.configureRunnerGroup(),
        postSubscriptionInvoicePaid(context.signal, {
          orgId,
          userId: actor.userId,
          tier: "pro",
          customerId: generatedStripeCustomerId(),
          subscriptionId: generatedStripeSubscriptionId(),
          currentPeriodEnd: periodEnd,
        }),
      ]);

      await owner.run(() => {
        return chat.requestSendEvent(
          actor,
          {
            prompt: "complete before cancel",
            model: null,
            clientEventId: randomUUID(),
          },
          [201],
        );
      });
      const execution = await runs.nextReceivedExecution(runnerGroup);
      owner.rememberExecution(execution.runId, execution.sandboxToken);
      const cliAgentType =
        execution.cliAgentType === "claude-code" ||
        execution.cliAgentType === "codex" ||
        execution.cliAgentType === "pi"
          ? execution.cliAgentType
          : undefined;
      await fixture.completeChatRunOk(
        execution.runId,
        { authorization: `Bearer ${execution.sandboxToken}` },
        {
          cliAgentType,
          cliAgentSessionId: execution.piSessionId ?? execution.runId,
        },
      );
      await flushWaitUntilForTest();

      const cancelled = await runs.requestCancelRun(
        actor,
        execution.runId,
        [400],
      );
      expect(cancelled.status).toBe(400);
      expectApiError(cancelled.body);
      expect(cancelled.body.error.code).toBe("RUN_NOT_CANCELLABLE");
    },
  );

  it(
    "run-reads.bdd-012 enforces chat pick concurrency until the cap is disabled",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const owner = await publicChatActor(context, {
        tier: "pro",
        runner: { maxConcurrent: 6 },
      });

      await Promise.all([
        owner.requestSendEvent(
          owner.actor,
          {
            prompt: "pro slot 1",
            model: owner.model,
            clientEventId: randomUUID(),
          },
          [201],
        ),
        owner.requestSendEvent(
          owner.actor,
          {
            prompt: "pro slot 2",
            model: owner.model,
            clientEventId: randomUUID(),
          },
          [201],
        ),
        owner.requestSendEvent(
          owner.actor,
          {
            prompt: "pro slot 3",
            model: owner.model,
            clientEventId: randomUUID(),
          },
          [201],
        ),
      ]);
      await flushWaitUntilForTest();

      const launchedLogs = await reads.requestListLogs(
        owner.actor,
        { limit: 10 },
        [200],
      );
      expect(launchedLogs.body.data).toHaveLength(3);
      for (const entry of launchedLogs.body.data) {
        owner.rememberExecution(
          entry.id,
          runs.dispatchedRun(entry.id).executionContext.sandboxToken,
        );
      }

      const fourth = await owner.sendWaitingChatInput(owner.actor, {
        prompt: "pro slot 4 queued",
        model: owner.model,
      });
      await flushWaitUntilForTest();

      const beforeDisable = await chat.listThreadEvents(
        owner.actor,
        fourth.threadId,
      );
      expect(
        beforeDisable.events.some((event) => {
          return event.runId !== undefined;
        }),
      ).toBeFalsy();

      mockEnv("CONCURRENT_RUN_LIMIT_CAP", 0);
      await refreshConcurrencyEntitlement(
        owner.actor,
        owner.customerId,
        context.signal,
      );

      const fourthRun = await fourth.launchedRun();
      owner.rememberExecution(
        fourthRun.runId,
        runs.dispatchedRun(fourthRun.runId).executionContext.sandboxToken,
      );
      const readFourth = await runs.readRun(owner.actor, fourthRun.runId);
      expect(["pending", "running"]).toContain(readFourth.status);
    },
  );

  async function seedTeamCancelledRuns(options: {
    readonly includeMember: boolean;
  }) {
    const actor = bdd.user();
    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("Expected a team workspace owner");
    }
    const owner = publicRunOwner(context, actor);
    fixture.chatCallbacks.acceptChatObjectStorage();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    mockOptionalEnv("OPENROUTER_API_KEY", "bdd-team-runs-key");
    fixture.chatCallbacks.disableVapid();
    const periodEnd = nowDate();
    periodEnd.setTime(now() + 30 * 24 * 60 * 60 * 1000);

    const [, { model: ownerModel }] = await Promise.all([
      runs.configureRunnerGroup({ maxConcurrent: 6 }),
      runs.ensurePersonalSubscriptionModel(actor),
      deliverOrganizationCreated(context, actor),
      postSubscriptionInvoicePaid(context.signal, {
        orgId,
        userId: actor.userId,
        tier: "team",
        customerId: generatedStripeCustomerId(),
        subscriptionId: generatedStripeSubscriptionId(),
        currentPeriodEnd: periodEnd,
      }),
    ]);

    const member = options.includeMember
      ? bdd.user({ orgId, orgRole: "org:member" })
      : null;
    const memberOwner = member ? publicRunOwner(context, member) : null;

    if (member && memberOwner) {
      await memberOwner.run(() => {
        return chat.requestSendEvent(
          member,
          {
            prompt: "member hidden run",
            model: null,
            clientEventId: randomUUID(),
          },
          [201],
        );
      });
      mockClerkUsers(context, [clerkProfile(actor), clerkProfile(member)]);
    }

    const [autoRun] = await Promise.all([
      owner.run(() => {
        return workflows.startEventAutomationRun(actor);
      }),
      owner.run(() => {
        return chat.requestSendEvent(
          actor,
          {
            prompt: "web log run 1",
            model: ownerModel,
            clientEventId: randomUUID(),
          },
          [201],
        );
      }),
      owner.run(() => {
        return chat.requestSendEvent(
          actor,
          {
            prompt: "web log run 2",
            model: ownerModel,
            clientEventId: randomUUID(),
          },
          [201],
        );
      }),
    ]);
    await flushWaitUntilForTest();

    const ownerLogs = await reads.requestListLogs(actor, { limit: 10 }, [200]);
    const web1 = ownerLogs.body.data.find((entry) => {
      return entry.prompt === "web log run 1";
    });
    const web2 = ownerLogs.body.data.find((entry) => {
      return entry.prompt === "web log run 2";
    });
    if (!web1 || !web2) {
      throw new Error("Expected both team web runs to launch");
    }

    for (const runId of [web1.id, web2.id, autoRun.runId]) {
      owner.rememberExecution(
        runId,
        runs.dispatchedRun(runId).executionContext.sandboxToken,
      );
    }

    await Promise.all([
      runs.requestCancelRun(actor, web1.id, [200]),
      runs.requestCancelRun(actor, web2.id, [200]),
      runs.requestCancelRun(actor, autoRun.runId, [200]),
    ]);

    let memberRunId: string | null = null;
    if (member && memberOwner) {
      memberRunId = await findRunIdByPrompt(member, "member hidden run");
      memberOwner.rememberExecution(
        memberRunId,
        runs.dispatchedRun(memberRunId).executionContext.sandboxToken,
      );
      await runs.requestCancelRun(member, memberRunId, [200]);
    }

    return {
      owner: { actor },
      member,
      web1Id: web1.id,
      web2Id: web2.id,
      autoRunId: autoRun.runId,
      memberRunId,
    };
  }

  it(
    "run-reads.bdd-025 lists organization run logs with their filter metadata",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const seeded = await seedTeamCancelledRuns({ includeMember: true });
      const list = await reads.requestListLogs(seeded.owner.actor, {}, [200]);

      const returnedIds = list.body.data.map((entry) => {
        return entry.id;
      });
      expect(returnedIds).toHaveLength(3);
      expect([...returnedIds].sort()).toStrictEqual(
        [seeded.web1Id, seeded.web2Id, seeded.autoRunId].sort(),
      );
      expect(returnedIds).not.toContain(seeded.memberRunId);

      const firstWeb = list.body.data.find((entry) => {
        return entry.id === seeded.web1Id;
      });
      const automation = list.body.data.find((entry) => {
        return entry.id === seeded.autoRunId;
      });
      expect(firstWeb).toMatchObject({
        id: seeded.web1Id,
        framework: "claude-code",
        triggerSource: "web",
        status: "cancelled",
        prompt: "web log run 1",
      });
      expect(automation).toMatchObject({
        id: seeded.autoRunId,
        triggerSource: "automation-event",
      });
      expect(list.body.filters.statuses).toContain("cancelled");
      expect([...list.body.filters.sources].sort()).toStrictEqual([
        "automation-event",
        "web",
      ]);
    },
  );

  it(
    "run-reads.bdd-026 pages run logs and falls back from malformed cursors",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const seeded = await seedTeamCancelledRuns({ includeMember: true });

      const page1 = await reads.requestListLogs(
        seeded.owner.actor,
        { limit: 1 },
        [200],
      );
      expect(page1.body.data).toHaveLength(1);
      expect(page1.body.pagination).toMatchObject({
        hasMore: true,
        totalPages: 3,
      });
      const firstId = page1.body.data[0]?.id;
      const nextCursor = page1.body.pagination.nextCursor;
      if (!firstId || !nextCursor) {
        throw new Error("Expected page 1 entry and nextCursor");
      }

      const [page2, fallback] = await Promise.all([
        reads.requestListLogs(
          seeded.owner.actor,
          { limit: 1, cursor: nextCursor },
          [200],
        ),
        reads.requestListLogs(
          seeded.owner.actor,
          { limit: 1, cursor: "garbage" },
          [200],
        ),
      ]);

      expect(page2.body.data).toHaveLength(1);
      expect(page2.body.data[0]?.id).not.toBe(firstId);
      expect(page2.body.pagination.totalPages).toBe(3);

      expect(fallback.body.data).toHaveLength(1);
      expect(fallback.body.data[0]?.id).toBe(firstId);
    },
  );

  it(
    "run-reads.bdd-028 (1/2) returns pending run-log detail while download signing is held",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const actor = bdd.user();
      const owner = publicRunOwner(context, actor);
      fixture.chatCallbacks.acceptChatObjectStorage();
      runs.acceptStorageDownloads();
      runs.acceptTelemetryIngest();
      mockOptionalEnv("OPENROUTER_API_KEY", "bdd-run-reads-pending-key");
      fixture.chatCallbacks.disableVapid();
      context.mocks.ably.publish.mockResolvedValue(undefined);

      await Promise.all([
        runs.configureRunnerGroup(),
        deliverOrganizationCreated(context, actor),
        bdd.updatePersonalInstructions(
          actor,
          `Keep replies brief ${randomUUID()}`,
        ),
      ]);

      const hold = holdDownloadSigning(context);
      await owner.run(() => {
        return chat.requestSendEvent(
          actor,
          {
            prompt: "pending download signing run",
            model: null,
            clientEventId: randomUUID(),
          },
          [201],
        );
      });
      await hold.waitForPending();

      const pendingList = await reads.requestListLogs(
        actor,
        { status: "pending" },
        [200],
      );
      const pendingEntry = pendingList.body.data[0];
      if (!pendingEntry) {
        throw new Error("Expected pending run in pending logs list");
      }

      const pendingDetail = await reads.requestReadLogById(
        actor,
        pendingEntry.id,
        [200],
      );

      hold.release();
      await flushWaitUntilForTest();

      const pendingToken = runs.dispatchedRun(pendingEntry.id).executionContext
        .sandboxToken;
      owner.rememberExecution(pendingEntry.id, pendingToken);
      await runs.requestCancelRun(actor, pendingEntry.id, [200]);
      await webhooks.requestAgentComplete(
        { runId: pendingEntry.id, exitCode: 1, error: "Run cancelled" },
        { authorization: `Bearer ${pendingToken}` },
        [200],
      );
      await flushWaitUntilForTest();

      expect(pendingList.body.data).toContainEqual(
        expect.objectContaining({ id: pendingEntry.id, status: "pending" }),
      );
      expect(pendingDetail.body).toMatchObject({
        id: pendingEntry.id,
        status: "pending",
        sessionId: null,
        completedAt: null,
      });
    },
  );

  it(
    "run-reads.bdd-028 (2/2) returns failed run-log detail with unknown failure reason",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const actor = bdd.user();
      const owner = publicRunOwner(context, actor);
      fixture.chatCallbacks.acceptChatObjectStorage();
      runs.acceptStorageDownloads();
      runs.acceptTelemetryIngest();
      mockOptionalEnv("OPENROUTER_API_KEY", "bdd-run-reads-failed-key");
      fixture.chatCallbacks.disableVapid();
      context.mocks.ably.publish.mockResolvedValue(undefined);

      const [runnerGroup] = await Promise.all([
        runs.configureRunnerGroup(),
        deliverOrganizationCreated(context, actor),
      ]);

      await owner.run(() => {
        return chat.requestSendEvent(
          actor,
          {
            prompt: "failing run for log detail",
            model: null,
            clientEventId: randomUUID(),
          },
          [201],
        );
      });
      const execution = await runs.nextReceivedExecution(runnerGroup);
      owner.rememberExecution(execution.runId, execution.sandboxToken);

      await webhooks.requestAgentComplete(
        { runId: execution.runId, exitCode: 1, error: "bdd failure" },
        { authorization: `Bearer ${execution.sandboxToken}` },
        [200],
      );
      await flushWaitUntilForTest();

      const failedDetail = await reads.requestReadLogById(
        actor,
        execution.runId,
        [200],
      );
      expect(failedDetail.body).toMatchObject({
        id: execution.runId,
        status: "failed",
        failureReason: "unknown",
      });
    },
  );
});
