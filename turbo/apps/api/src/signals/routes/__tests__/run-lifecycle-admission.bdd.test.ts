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
import { runModelsMainContract } from "@okouai/api-contracts/contracts/run-models";
import { runsQueueContract } from "@okouai/api-contracts/contracts/run-routes";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { billingStatusRoutes } from "../billing-status";
import { billingUsagePackCreditsRoutes } from "../billing-usage-pack-credits";
import { chatEventsRoutes } from "../chat-events";
import { chatThreadRoutes } from "../chat-threads";
import { runModelsRoutes } from "../run-models";
import { runsRoutes } from "../runs";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { projectChatEventRows } from "./helpers/chat-event-test-reader";
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
});
