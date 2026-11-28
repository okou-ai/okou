import { randomUUID } from "node:crypto";
import {
  billingStatusContract,
  billingUsagePackCreditsContract,
} from "@okouai/api-contracts/contracts/billing";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import {
  chatThreadEventsContract,
  chatThreadModelSelectionContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  logsByIdContract,
  logsListContract,
} from "@okouai/api-contracts/contracts/logs";
import { ENABLE_FRAMEWORK_IMAGE_GENERATION_ENV_VAR } from "@okouai/api-contracts/contracts/paid-tools";
import { runModelsMainContract } from "@okouai/api-contracts/contracts/run-models";
import {
  runsByIdContract,
  runsCancelContract,
  runsQueueContract,
} from "@okouai/api-contracts/contracts/run-routes";
import { webhookCompleteContract } from "@okouai/api-contracts/contracts/webhooks";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { now } from "../../../lib/time";
import { DEV_SEED_SENTINEL_MANAGED_MODEL_KEY } from "../../../scripts/dev-seed-managed-model-key";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { billingStatusRoutes } from "../billing-status";
import { billingUsagePackCreditsRoutes } from "../billing-usage-pack-credits";
import { chatEventsRoutes } from "../chat-events";
import { chatThreadRoutes } from "../chat-threads";
import { logsRoutes } from "../logs";
import { runModelsRoutes } from "../run-models";
import { runsRoutes } from "../runs";
import { runsCancelRoutes } from "../runs-cancel";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { projectChatEventRows } from "./helpers/chat-event-test-reader";
import { okouTokenFromExecution } from "./helpers/chat-events-fixture";
import { setPaidToolDisabled } from "./helpers/paid-tools";
import { publicRunOwner } from "./helpers/public-run-owner";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

const app = setupApp({
  context,
  routes: [
    ...billingStatusRoutes,
    ...billingUsagePackCreditsRoutes,
    ...runModelsRoutes,
    ...chatThreadRoutes,
    ...chatEventsRoutes,
    ...runsRoutes,
  ],
});
const billingStatusApi = app(billingStatusContract);
const usagePackCreditsApi = app(billingUsagePackCreditsContract);
const runModelsApi = app(runModelsMainContract);
const threadsApi = app(chatThreadsContract);
const modelSelectionApi = app(chatThreadModelSelectionContract);
const threadEventsApi = app(chatThreadEventsContract);
const chatEventsApi = app(chatEventsContract);
const runsQueueApi = app(runsQueueContract);
const runsByIdApi = app(runsByIdContract);

const extraApp = setupApp({
  context,
  routes: [...logsRoutes, ...runsCancelRoutes, ...webhooksAgentCompleteRoutes],
});
const logsListApi = extraApp(logsListContract);
const logsByIdApi = extraApp(logsByIdContract);
const runsCancelApi = extraApp(runsCancelContract);
const webhookCompleteApi = extraApp(webhookCompleteContract);

function signIn(user: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    user.userId,
    user.orgId,
    user.orgRole ?? "org:admin",
  );
  return headers;
}

async function rejectPinnedModel(
  pinnedModel: "gpt-6-astra" | "claude-fable-5-1" | "gpt-5.6-sol",
) {
  const member = bdd.user();
  await bdd.bootstrapLimitedFreeOnboarding(member);
  const authHeaders = signIn(member);
  const conversation = await accept(
    threadsApi.create({
      headers: authHeaders,
      body: { title: `Limited free ${pinnedModel}` },
    }),
    [201],
  );
  const threadId = conversation.body.id;

  const clientEventId = randomUUID();
  const sendResponse = await accept(
    chatEventsApi.send({
      headers: authHeaders,
      body: {
        threadId,
        prompt: `Pin ${pinnedModel}`,
        hasTextContent: true,
        model: pinnedModel,
        clientEventId,
        userMessage: {
          version: 1,
          parts: [{ type: "text", text: `Pin ${pinnedModel}` }],
        },
      },
    }),
    [201, 400],
  );
  if (sendResponse.status === 400) {
    expect(sendResponse.body.error.code).toBe("BAD_REQUEST");
  } else {
    await flushWaitUntilForTest();
    const rows = await accept(
      threadEventsApi.rows({
        headers: authHeaders,
        params: { threadId },
        query: { sinceSeqId: 0, limit: 50 },
      }),
      [200],
    );
    const events = projectChatEventRows(rows.body.rows);
    const rejected = events.find((event) => {
      return (
        event.eventType === "input.rejected" &&
        event.revokesEventId === clientEventId
      );
    });
    expect(rejected).toMatchObject({
      eventType: "input.rejected",
      error: "pro_required",
    });
    expect(rejected?.runId).toBeUndefined();
  }

  const [pinResponse, queue] = await Promise.all([
    accept(
      modelSelectionApi.update({
        headers: authHeaders,
        params: { id: threadId },
        body: { model: pinnedModel },
      }),
      [400],
    ),
    accept(runsQueueApi.getQueue({ headers: authHeaders }), [200]),
  ]);
  return {
    pinErrorCode: pinResponse.body.error.code,
    activeQueue: queue.body.concurrency.active,
  };
}

describe("RUN-02: model provider selection and built-in admission", () => {
  it("run-lifecycle-admission.bdd-007 (1/4) exposes limited-free billing, bonus usage pack, Auto model, and default conversation selection", async () => {
    const member = bdd.user();
    await bdd.bootstrapLimitedFreeOnboarding(member);

    const authHeaders = signIn(member);
    const [billing, usagePacks, models, conversation] = await Promise.all([
      accept(billingStatusApi.get({ headers: authHeaders }), [200]),
      accept(usagePackCreditsApi.get({ headers: authHeaders }), [200]),
      accept(runModelsApi.list({ headers: authHeaders }), [200]),
      accept(
        threadsApi.create({
          headers: authHeaders,
          body: { title: "Limited free chat" },
        }),
        [201],
      ),
    ]);

    expect(billing.body).toMatchObject({
      tier: "limited-free-1",
      credits: 0,
      onboardingPaymentPending: false,
    });
    expect(billing.body.creditGrants).toStrictEqual([]);
    expect(usagePacks.body).toMatchObject({
      totalCredits: 1000,
      bonusCredits: 1000,
    });

    expect(models.body.models).toHaveLength(1);
    expect(models.body.models[0]?.model).toBe("auto");
    expect(conversation.body.selectedModel).toBe("auto");
  });

  it("run-lifecycle-admission.bdd-007 (2/4) rejects gpt-6-astra pinned sends and conversation pins with active queue at zero", async () => {
    await expect(rejectPinnedModel("gpt-6-astra")).resolves.toStrictEqual({
      pinErrorCode: "BAD_REQUEST",
      activeQueue: 0,
    });
  });

  it("run-lifecycle-admission.bdd-007 (3/4) rejects claude-fable-5-1 pinned sends and conversation pins with active queue at zero", async () => {
    await expect(rejectPinnedModel("claude-fable-5-1")).resolves.toStrictEqual({
      pinErrorCode: "BAD_REQUEST",
      activeQueue: 0,
    });
  });

  it("run-lifecycle-admission.bdd-007 (4/4) rejects gpt-5.6-sol pinned sends and conversation pins with active queue at zero", async () => {
    await expect(rejectPinnedModel("gpt-5.6-sol")).resolves.toStrictEqual({
      pinErrorCode: "BAD_REQUEST",
      activeQueue: 0,
    });
  });

  it("run-lifecycle-admission.bdd-005 (1/2) rejects built-in model runs for an unonboarded workspace with no billing state", async () => {
    const unonboarded = bdd.user();
    const runs = createRunsApi(context);

    const rejection = await runs.readThreadRunRejection(unonboarded, {
      prompt: "Built-in run without onboarding",
      model: null,
    });
    expect(rejection).toBe("insufficient_credits");
  });

  it("run-lifecycle-admission.bdd-005 (2/2) rejects built-in model runs when Pro credit grants expired 60 days ago", async () => {
    const expired = bdd.user();
    const runs = createRunsApi(context);
    await runs.grantProEntitlement(expired, {
      periodEndUnix: Math.floor(now() / 1000) - 60 * 86_400,
    });

    const rejection = await runs.readThreadRunRejection(expired, {
      prompt: "Built-in run with expired credits",
      model: null,
    });
    expect(rejection).toBe("insufficient_credits");
  });

  it(
    "run-lifecycle-admission.bdd-008 dispatches managed Auto runs without delivering the managed provider key",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, owner, runs } = await setupProRunActor({
        withClaudeSubscription: false,
      });
      await setPaidToolDisabled(context, actor, "image-generation", true);

      const created = await owner.run(() => {
        return startChatRun(actor, {
          prompt: "Auto run without managed key exposure",
          model: null,
        });
      });

      const execution = await owner.executionInput(created.runId);
      const dispatch = runs.dispatchedRun(created.runId);
      const authHeaders = signIn(actor);
      const [runResponse, eventRows, logsList, logDetail] = await Promise.all([
        accept(
          runsByIdApi.getById({
            headers: authHeaders,
            params: { id: created.runId },
          }),
          [200],
        ),
        accept(
          threadEventsApi.rows({
            headers: authHeaders,
            params: { threadId: created.threadId },
            query: { sinceSeqId: 0, limit: 50 },
          }),
          [200],
        ),
        accept(
          logsListApi.list({ headers: authHeaders, query: { limit: 50 } }),
          [200],
        ),
        accept(
          logsByIdApi.getById({
            headers: authHeaders,
            params: { id: created.runId },
          }),
          [200],
        ),
      ]);
      const run = runResponse.body;
      const events = projectChatEventRows(eventRows.body.rows);

      expect(execution.firewalls).toContainEqual(
        expect.objectContaining({
          kind: "builtin",
          name: "model-provider:openrouter-codex",
        }),
      );
      expect(
        execution.platformEnvironment[
          ENABLE_FRAMEWORK_IMAGE_GENERATION_ENV_VAR
        ],
      ).toBeUndefined();
      expect(run.source.providerType).toBe("built-in");

      for (const surface of [
        dispatch,
        execution,
        run,
        events,
        logsList.body,
        logDetail.body,
      ]) {
        expect(JSON.stringify(surface)).not.toContain(
          DEV_SEED_SENTINEL_MANAGED_MODEL_KEY,
        );
      }
    },
  );
});

async function startChatRun(
  actor: ApiTestUser,
  body: { readonly prompt: string; readonly model?: string | null },
): Promise<{ readonly runId: string; readonly threadId: string }> {
  const clientEventId = randomUUID();
  const authHeaders = signIn(actor);
  const sent = await accept(
    chatEventsApi.send({
      headers: authHeaders,
      body: {
        prompt: body.prompt,
        hasTextContent: true,
        clientEventId,
        ...(body.model === undefined ? {} : { model: body.model }),
        userMessage: {
          version: 1,
          parts: [{ type: "text", text: body.prompt }],
        },
      },
    }),
    [201],
  );
  await flushWaitUntilForTest();
  const rows = await accept(
    threadEventsApi.rows({
      headers: signIn(actor),
      params: { threadId: sent.body.threadId },
      query: { sinceSeqId: 0, limit: 50 },
    }),
    [200],
  );
  const runId = projectChatEventRows(rows.body.rows).find((event) => {
    return event.revokesEventId === clientEventId;
  })?.runId;
  if (!runId) {
    throw new Error("Expected chat send to launch a Run");
  }
  return { runId, threadId: sent.body.threadId };
}

async function setupProRunActor(args: {
  readonly withClaudeSubscription: boolean;
}) {
  const actor = bdd.user();
  const runs = createRunsApi(context);
  const chatCallbacks = createChatCallbacksApi(context);
  chatCallbacks.acceptChatObjectStorage();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  chatCallbacks.disableVapid();
  const runnerReady = runs.configureRunnerGroup({ maxConcurrent: 4 });
  const owner = publicRunOwner(context, actor);
  await Promise.all([
    runnerReady,
    owner.run(() => {
      return runs.grantProEntitlement(actor);
    }),
  ]);
  if (args.withClaudeSubscription) {
    await owner.run(() => {
      return runs.ensurePersonalSubscriptionModel(actor);
    });
  }
  return { actor, owner, runs };
}

describe("RUN-01: agent run authorization and session boundaries", () => {
  it(
    "run-lifecycle-admission.bdd-003 (1/2) accepts browser session cancellation for a running chat Run",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, owner } = await setupProRunActor({
        withClaudeSubscription: false,
      });
      const firstRun = await owner.run(() => {
        return startChatRun(actor, {
          prompt: "Run cancelled by browser session",
          model: null,
        });
      });

      const authHeaders = signIn(actor);
      const cancelResponse = await accept(
        runsCancelApi.cancel({
          headers: authHeaders,
          params: { id: firstRun.runId },
        }),
        [200],
      );
      expect(cancelResponse.body.status).toBe("cancelled");
      const afterCancel = await accept(
        runsByIdApi.getById({
          headers: authHeaders,
          params: { id: firstRun.runId },
        }),
        [200],
      );
      expect(afterCancel.body.status).toBe("cancelled");
    },
  );

  it(
    "run-lifecycle-admission.bdd-003 (2/2) rejects run-scoped tokens with 403 and accepts CLI PAT cancellation with 200",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, owner, runs } = await setupProRunActor({
        withClaudeSubscription: false,
      });
      const [targetRun, donorRun, cliToken] = await owner.run(() => {
        return Promise.all([
          startChatRun(actor, {
            prompt: "Run targeted for token cancellation checks",
            model: null,
          }),
          startChatRun(actor, {
            prompt: "Donor run supplying run-scoped tokens",
            model: null,
          }),
          runs.createCliToken(actor),
        ]);
      });

      const donorExecution = await owner.executionInput(donorRun.runId);
      const okouRunToken = okouTokenFromExecution(donorExecution);

      const [sandboxAttempt, okouAttempt] = await Promise.all([
        accept(
          runsCancelApi.cancel({
            headers: { authorization: `Bearer ${donorExecution.sandboxToken}` },
            params: { id: targetRun.runId },
          }),
          [403],
        ),
        accept(
          runsCancelApi.cancel({
            headers: { authorization: `Bearer ${okouRunToken}` },
            params: { id: targetRun.runId },
          }),
          [403],
        ),
      ]);
      expect(sandboxAttempt.status).toBe(403);
      expect(okouAttempt.status).toBe(403);
      const stillRunning = await accept(
        runsByIdApi.getById({
          headers: signIn(actor),
          params: { id: targetRun.runId },
        }),
        [200],
      );
      expect(stillRunning.body.status).toBe("running");

      const patCancel = await accept(
        runsCancelApi.cancel({
          headers: { authorization: `Bearer ${cliToken.token}` },
          params: { id: targetRun.runId },
        }),
        [200],
      );
      expect(patCancel.body.status).toBe("cancelled");
      const afterPatCancel = await accept(
        runsByIdApi.getById({
          headers: signIn(actor),
          params: { id: targetRun.runId },
        }),
        [200],
      );
      expect(afterPatCancel.body.status).toBe("cancelled");
    },
  );

  it(
    "run-lifecycle-admission.bdd-004 prevents another member from continuing an owned thread",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const {
        actor: owner,
        owner: runOwner,
        runs,
      } = await setupProRunActor({
        withClaudeSubscription: true,
      });
      if (!owner.orgId) {
        throw new Error("Expected owner orgId");
      }
      const peer = bdd.user({ orgId: owner.orgId, orgRole: "org:member" });

      const running = await runOwner.run(() => {
        return startChatRun(owner, {
          prompt: "Owned native Runner conversation",
        });
      });
      const execution = await runs.executionInput(running.runId);
      const sandboxHeaders = {
        authorization: `Bearer ${execution.sandboxToken}`,
      };

      const peerAttempt = await accept(
        chatEventsApi.send({
          headers: signIn(peer),
          body: {
            threadId: running.threadId,
            prompt: "Peer intrusion attempt",
            hasTextContent: true,
            clientEventId: randomUUID(),
            userMessage: {
              version: 1,
              parts: [{ type: "text", text: "Peer intrusion attempt" }],
            },
          },
        }),
        [404],
      );
      expect(peerAttempt.body.error.code).toBe("NOT_FOUND");

      await accept(
        runsCancelApi.cancel({
          headers: signIn(owner),
          params: { id: running.runId },
        }),
        [200],
      );
      await accept(
        webhookCompleteApi.complete({
          headers: sandboxHeaders,
          body: {
            runId: running.runId,
            exitCode: 1,
            error: "Run cancelled",
          },
        }),
        [200],
      );
      await flushWaitUntilForTest();

      const queue = await accept(
        runsQueueApi.getQueue({ headers: signIn(owner) }),
        [200],
      );
      expect(queue.body.concurrency.active).toBe(0);
    },
  );
});

async function rejectSuspendedEntitlementSend(args: {
  readonly prompt: string;
  readonly model?: null;
}) {
  const actor = bdd.user();
  const runs = createRunsApi(context);
  const webhooks = createWebhookCallbackApi(context);
  const [{ customerId, subscriptionId }] = await Promise.all([
    runs.grantProEntitlement(actor),
    runs.ensurePersonalSubscriptionModel(actor, {
      model: "claude-fable-5-1",
    }),
  ]);

  webhooks.configureStripeBillingEnv();
  context.mocks.stripe.customers.retrieve.mockResolvedValue({
    id: customerId,
    metadata: { orgId: actor.orgId },
  });
  await webhooks.postStripeEvent(
    {
      id: `evt_cancel_${randomUUID()}`,
      type: "customer.subscription.updated",
      created: Math.floor(now() / 1000),
      data: {
        object: {
          id: subscriptionId,
          customer: customerId,
          status: "canceled",
          metadata: {},
          cancel_at_period_end: false,
          cancel_at: null,
          schedule: null,
          trial_end: null,
          items: { data: [{ price: { id: "price_bdd_pro" } }] },
        },
      },
    },
    [200],
  );
  await flushWaitUntilForTest();

  const authHeaders = signIn(actor);
  const clientEventId = randomUUID();
  const sent = await accept(
    chatEventsApi.send({
      headers: authHeaders,
      body: {
        prompt: args.prompt,
        hasTextContent: true,
        ...(args.model === undefined ? {} : { model: args.model }),
        clientEventId,
        userMessage: {
          version: 1,
          parts: [{ type: "text", text: args.prompt }],
        },
      },
    }),
    [201],
  );
  await flushWaitUntilForTest();

  const [rows, logs, queue] = await Promise.all([
    accept(
      threadEventsApi.rows({
        headers: authHeaders,
        params: { threadId: sent.body.threadId },
        query: { sinceSeqId: 0, limit: 50 },
      }),
      [200],
    ),
    accept(
      logsListApi.list({ headers: authHeaders, query: { limit: 50 } }),
      [200],
    ),
    accept(runsQueueApi.getQueue({ headers: authHeaders }), [200]),
  ]);

  const rejected = projectChatEventRows(rows.body.rows).find((event) => {
    return (
      event.eventType === "input.rejected" &&
      event.revokesEventId === clientEventId
    );
  });
  const loggedPrompts = logs.body.data.map((entry) => {
    return entry.prompt;
  });
  return {
    rejectedEventType: rejected?.eventType,
    rejectedError: rejected && "error" in rejected ? rejected.error : undefined,
    promptLogged: loggedPrompts.includes(args.prompt),
    activeQueue: queue.body.concurrency.active,
  };
}

describe("RUN-01: admission boundaries beyond request validation", () => {
  it("run-lifecycle-admission.bdd-001 (1/2) rejects default subscription runs when entitlements are suspended", async () => {
    await expect(
      rejectSuspendedEntitlementSend({
        prompt: "Suspended default subscription send",
      }),
    ).resolves.toStrictEqual({
      rejectedEventType: "input.rejected",
      rejectedError: "insufficient_credits",
      promptLogged: false,
      activeQueue: 0,
    });
  });

  it("run-lifecycle-admission.bdd-001 (2/2) rejects Auto model runs when entitlements are suspended", async () => {
    await expect(
      rejectSuspendedEntitlementSend({
        prompt: "Suspended auto model send",
        model: null,
      }),
    ).resolves.toStrictEqual({
      rejectedEventType: "input.rejected",
      rejectedError: "insufficient_credits",
      promptLogged: false,
      activeQueue: 0,
    });
  });
});
