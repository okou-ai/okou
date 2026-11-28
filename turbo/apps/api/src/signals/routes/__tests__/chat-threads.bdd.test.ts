import { randomUUID } from "node:crypto";
import {
  chatThreadByIdContract,
  chatThreadComputerUseHostContract,
  chatThreadMetadataContract,
  chatThreadModelSelectionContract,
  chatThreadRenameContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { chatThreadRoutes } from "../chat-threads";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createComputerUseBddApi } from "./helpers/api-bdd-computer-use";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";
import {
  generatedStripeCustomerId,
  generatedStripeSubscriptionId,
  postSubscriptionInvoicePaid,
} from "./helpers/stripe-billing-webhook";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { now } from "../../../lib/time";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function app(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId ?? null,
    actor.orgRole,
  );
  return setupApp({ context, routes: chatThreadRoutes });
}

function threads(actor: ApiTestUser) {
  return app(actor)(chatThreadsContract);
}

async function createThread(
  actor: ApiTestUser,
  body: NonNullable<
    Parameters<ReturnType<typeof threads>["create"]>[0]
  >["body"] = {},
) {
  const created = await accept(threads(actor).create({ headers, body }), [201]);
  return created.body;
}

async function events(actor: ApiTestUser, sinceSeqId?: number) {
  const response = await accept(
    threads(actor).events({
      headers,
      query: sinceSeqId === undefined ? {} : { sinceSeqId },
    }),
    [200],
  );
  return response.body;
}

async function metadata(actor: ApiTestUser, id: string) {
  const response = await accept(
    app(actor)(chatThreadMetadataContract).get({ headers, params: { id } }),
    [200],
  );
  return response.body;
}

function selectModel(actor: ApiTestUser, id: string, model: string | null) {
  return app(actor)(chatThreadModelSelectionContract).update({
    headers,
    params: { id },
    body: { model },
  });
}

describe("CHAT-01 thread detail, create, and delete cascades", () => {
  it("chat-threads.bdd-010 creates a thread without a model as Auto when the member has no preference", async () => {
    const member = createBddApi(context).user();
    const eventId = randomUUID();
    const created = await createThread(member, { eventId });
    expect(created.selectedModel).toBe("auto");
    await expect(metadata(member, created.id)).resolves.toMatchObject({
      selectedModel: "auto",
    });
    const page = await events(member);
    expect(page.events).toContainEqual(
      expect.objectContaining({
        id: eventId,
        kind: "created",
        chatThreadId: created.id,
        selectedModel: "auto",
      }),
    );
  });

  it("chat-threads.bdd-003 requires a signed-in organization member to create a thread", async () => {
    const bdd = createBddApi(context);
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const anonymous = await accept(
      setupApp({ context, routes: chatThreadRoutes })(
        chatThreadsContract,
      ).create({ headers, body: {} }),
      [401],
    );
    expect(anonymous.body.error.code).toBe("UNAUTHORIZED");

    const member = bdd.user();
    await accept(threads(member).create({ headers, body: {} }), [201]);

    const withoutOrg = bdd.user();
    createRouteMocks(context).clerk.session(withoutOrg.userId, null);
    const orgless = await accept(
      setupApp({ context, routes: chatThreadRoutes })(
        chatThreadsContract,
      ).create({ headers, body: {} }),
      [401],
    );
    expect(orgless.body.error.code).toBe("UNAUTHORIZED");

    const outsider = bdd.user();
    await expect(events(outsider)).resolves.toMatchObject({ events: [] });
  });

  it("chat-threads.bdd-004 returns the thread snapshot and lifecycle events with cursor expiry", async () => {
    const member = createBddApi(context).user();
    await createRunsApi(context).ensurePersonalSubscriptionModel(member, {
      model: "claude-fable-5-1",
    });
    const snapshot = await accept(threads(member).snapshot({ headers }), [200]);
    expect(snapshot.body).toStrictEqual({
      chatThreads: [],
      latestEventId: null,
      latestSeqId: null,
    });

    const created = await createThread(member, { eventId: randomUUID() });
    await accept(
      app(member)(chatThreadRenameContract).rename({
        headers,
        params: { id: created.id },
        body: { title: "Renamed lifecycle" },
      }),
      [204],
    );
    await accept(selectModel(member, created.id, "claude-sonnet-5-5"), [204]);

    const page = await events(member);
    expect(page.hasMore).toBeFalsy();
    expect(
      page.events.map((event) => {
        return [event.seqId, event.kind];
      }),
    ).toStrictEqual([
      [1, "created"],
      [2, "renamed"],
      [3, "model_selection_updated"],
      [4, "service_tier_updated"],
    ]);
    const selection = page.events[2];
    const tier = page.events[3];
    expect(selection?.selectedModel).toBe("claude-sonnet-5-5");
    expect(tier?.serviceTier).toBeNull();
    expect(tier?.createdAt).toBe(selection?.createdAt);

    await expect(events(member, 3)).resolves.toMatchObject({
      events: [{ seqId: 4, kind: "service_tier_updated" }],
    });
    const afterCreated = await events(member, 1);
    expect(
      afterCreated.events.map((event) => {
        return event.kind;
      }),
    ).toStrictEqual([
      "renamed",
      "model_selection_updated",
      "service_tier_updated",
    ]);
    const expired = await accept(
      threads(member).events({ headers, query: { sinceSeqId: 999_999 } }),
      [410],
    );
    expect(expired.body.error).toMatchObject({
      code: "CHAT_THREAD_EVENTS_EXPIRED",
      message: "Chat thread events cursor has expired",
    });
  });

  it("chat-threads.bdd-006 preserves member threads across sidebar event replay", async () => {
    const member = createBddApi(context).user();
    const ids: string[] = [];
    for (let index = 0; index < 3; index++) {
      ids.push((await createThread(member)).id);
    }
    const replay = await events(member);
    const sidebar = new Set<string>();
    for (const event of replay.events) {
      if (event.kind === "created") {
        sidebar.add(event.chatThreadId);
      }
    }
    const latest = replay.events.at(-1)?.seqId;
    if (latest === undefined) {
      throw new Error("Expected lifecycle events");
    }
    await expect(events(member, latest)).resolves.toStrictEqual({
      events: [],
      hasMore: false,
    });
    expect([...sidebar].sort()).toStrictEqual([...ids].sort());
    for (const id of ids.slice(0, 2)) {
      await accept(
        app(member)(chatThreadByIdContract).get({ headers, params: { id } }),
        [200],
      );
    }
  });

  it("chat-threads.bdd-008 rejects explicit thread models outside the member's subscription", async () => {
    const member = createBddApi(context).user();
    await createRunsApi(context).ensurePersonalSubscriptionModel(member, {
      model: "claude-opus-5-5",
    });
    const clientThreadId = randomUUID();
    const rejected = await accept(
      threads(member).create({
        headers,
        body: { clientThreadId, model: "gpt-6-astra" },
      }),
      [400],
    );
    expect(rejected.body.error.message).toContain(
      "Select Auto or a model from your connected personal subscription",
    );
    await accept(
      app(member)(chatThreadByIdContract).get({
        headers,
        params: { id: clientThreadId },
      }),
      [404],
    );
    const created = await createThread(member, { model: "claude-opus-5-5" });
    const update = await accept(
      selectModel(member, created.id, "gpt-6-astra"),
      [400],
    );
    expect(update.body.error.message).toContain(
      "Select Auto or a model from your connected personal subscription",
    );
  });

  it("chat-threads.bdd-009 rejects the internal Auto run model as a thread selection", async () => {
    const member = createBddApi(context).user();
    await createRunsApi(context).ensurePersonalSubscriptionModel(member, {
      model: "claude-fable-5-1",
    });
    const clientThreadId = randomUUID();
    await accept(
      threads(member).create({
        headers,
        body: { clientThreadId, model: "okou-1.0" },
      }),
      [400],
    );
    await accept(
      app(member)(chatThreadByIdContract).get({
        headers,
        params: { id: clientThreadId },
      }),
      [404],
    );
    const created = await createThread(member, { model: "claude-fable-5-1" });
    await accept(selectModel(member, created.id, "okou-1.0"), [400]);
    await expect(metadata(member, created.id)).resolves.toMatchObject({
      selectedModel: "claude-fable-5-1",
    });
  });

  it("chat-threads.bdd-013 updates the Computer Use host binding on a chat thread", async () => {
    const bdd = createBddApi(context);
    const member = bdd.user();
    const peer = bdd.user({ orgId: member.orgId, orgRole: "org:member" });
    const created = await createThread(member);
    const host =
      await createComputerUseBddApi(context).startComputerUseHost(member);
    function bind(actor: ApiTestUser, id: string, hostId: string | null) {
      return app(actor)(chatThreadComputerUseHostContract).update({
        headers,
        params: { id },
        body: { computerUseHostId: hostId },
      });
    }
    await accept(bind(member, created.id, host.hostId), [204]);
    const unknownHost = await accept(
      bind(member, created.id, randomUUID()),
      [404],
    );
    expect(unknownHost.body.error.message).toBe("Computer-use host not found");
    const byPeer = await accept(bind(peer, created.id, host.hostId), [404]);
    expect(byPeer.body.error.message).toBe("Chat thread not found");
    await accept(bind(member, created.id, null), [204]);
    const unknownThread = await accept(bind(member, randomUUID(), null), [404]);
    expect(unknownThread.body.error.message).toBe("Chat thread not found");

    const page = await events(member);
    expect(
      page.events
        .filter((event) => {
          return event.kind === "computer_use_host_updated";
        })
        .map((event) => {
          return event.computerUseHostId;
        }),
    ).toStrictEqual([host.hostId, null]);
  });
  it("chat-threads.bdd-011 stores canonical Auto intent for limited-free-1 workspaces", async () => {
    const member = createBddApi(context).user();
    const orgId = member.orgId ?? "";
    const customerId = generatedStripeCustomerId();
    const subscriptionId = generatedStripeSubscriptionId();
    await postSubscriptionInvoicePaid(context.signal, {
      orgId,
      userId: member.userId,
      tier: "pro",
      customerId,
      subscriptionId,
      currentPeriodEnd: new Date(now() + 30 * 86_400_000),
    });
    await flushWaitUntilForTest();
    const runs = createRunsApi(context);
    const funded = await runs.readBillingStatus(member);
    if (funded.tier !== "pro" || funded.credits <= 0) {
      throw new Error("Expected a funded Pro workspace");
    }
    const webhooks = createWebhookCallbackApi(context);
    webhooks.configureStripeBillingEnv();
    await webhooks.postStripeEvent(
      {
        id: `evt_${randomUUID()}`,
        type: "customer.subscription.deleted",
        created: Math.floor(now() / 1000),
        data: {
          object: {
            id: subscriptionId,
            customer: customerId,
            status: "canceled",
            metadata: {},
          },
        },
      },
      [200],
    );
    await flushWaitUntilForTest();
    const status = await runs.readBillingStatus(member);
    expect(status).toMatchObject({ tier: "limited-free-1", status: "active" });
    expect(status.credits).toStrictEqual(funded.credits);

    const created = await createThread(member, {
      title: "Free tier thread",
      model: null,
    });
    await accept(selectModel(member, created.id, null), [204]);
    await expect(metadata(member, created.id)).resolves.toMatchObject({
      title: "Free tier thread",
      selectedModel: "auto",
    });
  });
});
