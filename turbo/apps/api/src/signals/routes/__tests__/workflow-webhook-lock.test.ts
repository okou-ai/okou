import {
  chatThreadByIdContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  workflowAutomationsContract,
  workflowsCollectionContract,
} from "@okouai/api-contracts/contracts/workflows";
import { describe, expect, it } from "vitest";
import { setupApp } from "../../../__tests__/test-helpers";
import { accept, testContext } from "../../../__tests__/test-context";
import { chatThreadRoutes } from "../chat-threads";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import { chatThreadDeleteRoutes } from "../chat-threads-delete";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";
import { createBddApi } from "./helpers/api-bdd";
import { publicPlanLifecycle } from "./helpers/public-plan-lifecycle";
import { createRouteMocks } from "./helpers/route-test";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";

const context = testContext();
const bdd = createBddApi(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const routes = Object.freeze([
  ...workflowsRoutes,
  ...workflowAutomationsRoutes,
  ...chatThreadRoutes,
  ...chatThreadCreateRoutes,
  ...chatThreadDeleteRoutes,
]);
const app = setupApp({ context, routes });
const rethrowingApp = setupApp({ context, routes, rethrowErrors: true });
const webhook = Object.freeze({
  kind: "event" as const,
  eventType: "webhook-received" as const,
});

async function teamMember(options: { unrelatedThread: boolean }) {
  const actor = bdd.user();
  if (!actor.orgId) {
    throw new Error("Expected a workspace member");
  }
  await publicPlanLifecycle(context, actor, "team").update("active");
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  const [workflow, thread] = await Promise.all([
    accept(
      app(workflowsCollectionContract).create({
        headers,
        body: { name: "webhook-lock-test" },
      }),
      [201],
    ),
    options.unrelatedThread
      ? accept(
          app(chatThreadsContract).create({ headers, body: { model: null } }),
          [201],
        )
      : Promise.resolve(null),
  ]);
  return { workflowId: workflow.body.id, threadId: thread?.body.id ?? null };
}

function createWebhook(workflowId: string) {
  return accept(
    app(workflowAutomationsContract).create({
      headers,
      params: { workflowId },
      body: webhook,
    }),
    [201],
  );
}

async function created(workflowId: string) {
  const response = await createWebhook(workflowId);
  const body = response.body;
  if (!("webhookUrl" in body) || !("webhookSecret" in body)) {
    throw new Error("Expected a webhook automation");
  }
  return {
    id: body.id,
    chatThreadId: body.chatThreadId,
    webhookUrl: body.webhookUrl,
    webhookSecret: body.webhookSecret,
  };
}

async function reveal(id: string) {
  return (
    await accept(
      app(workflowAutomationsContract).revealWebhookSecret({
        headers,
        params: { id },
      }),
      [200],
    )
  ).body;
}

async function listAutomations(workflowId: string) {
  return (
    await accept(
      app(workflowAutomationsContract).list({
        headers,
        params: { workflowId },
      }),
      [200],
    )
  ).body;
}

async function feedThreadIds() {
  const feed = await accept(
    app(chatThreadsContract).events({ headers, query: {} }),
    [200],
  );
  return [
    ...new Set(
      feed.body.events.map((event) => {
        return event.chatThreadId;
      }),
    ),
  ].sort();
}

describe("webhook credential preparation lock isolation", () => {
  it("workflow-webhook-lock-007 (1/2) fails the webhook creation when KMS call 1 fails", async () => {
    const { workflowId } = await kmsFailingTeamMember();

    await expect(createFailingWebhook(workflowId)).rejects.toThrow(
      "KMS unavailable",
    );
  });

  it("workflow-webhook-lock-007 (2/2) leaves no automation and only the unrelated thread", async () => {
    const { workflowId, threadId } = await kmsFailingTeamMember();
    await createFailingWebhook(workflowId).catch(() => {
      return undefined;
    });

    await expect(listAutomations(workflowId)).resolves.toStrictEqual([]);
    await expect(feedThreadIds()).resolves.toStrictEqual([threadId]);
  });

  it("workflow-webhook-lock-001 shares one conversation between concurrent webhook credentials", async () => {
    const { workflowId, threadId } = await teamMember({
      unrelatedThread: true,
    });

    const [first, second] = await Promise.all([
      created(workflowId),
      created(workflowId),
    ]);
    expect(first.chatThreadId).toBe(second.chatThreadId);
    expect(first.id).not.toBe(second.id);
    expect(first.webhookUrl).not.toBe(second.webhookUrl);

    const [firstSecret, secondSecret, threads, automations] = await Promise.all(
      [
        reveal(first.id),
        reveal(second.id),
        feedThreadIds(),
        listAutomations(workflowId),
      ],
    );
    expect(firstSecret).toStrictEqual({
      webhookUrl: first.webhookUrl,
      webhookSecret: first.webhookSecret,
    });
    expect(secondSecret).toStrictEqual({
      webhookUrl: second.webhookUrl,
      webhookSecret: second.webhookSecret,
    });
    expect(threads).toStrictEqual([threadId, first.chatThreadId].sort());
    expect(
      automations
        .map((automation) => {
          return automation.id;
        })
        .sort(),
    ).toStrictEqual([first.id, second.id].sort());
  });

  it("workflow-webhook-lock-002 rebuilds the conversation without re-enabling a deleted conversation's webhook", async () => {
    const { workflowId } = await teamMember({ unrelatedThread: false });
    const first = await created(workflowId);
    const deletedThreadId = first.chatThreadId;
    if (!deletedThreadId) {
      throw new Error("Expected a webhook conversation");
    }
    await accept(
      app(chatThreadByIdContract).delete({
        headers,
        params: { id: deletedThreadId },
      }),
      [204],
    );

    const second = await created(workflowId);
    expect(second.chatThreadId).not.toBe(deletedThreadId);
    const [automations, secret, threads] = await Promise.all([
      listAutomations(workflowId),
      reveal(second.id),
      feedThreadIds(),
    ]);

    expect(
      automations
        .map((automation) => {
          return [automation.id, automation.enabled, automation.chatThreadId];
        })
        .sort(),
    ).toStrictEqual(
      [
        [first.id, false, second.chatThreadId],
        [second.id, true, second.chatThreadId],
      ].sort(),
    );
    expect(secret).toStrictEqual({
      webhookUrl: second.webhookUrl,
      webhookSecret: second.webhookSecret,
    });
    expect(threads).toHaveLength(2);
  });
});

/** A Team member's Workflow and unrelated Thread, with KMS failing its first call. */
async function kmsFailingTeamMember() {
  const owned = await teamMember({ unrelatedThread: true });
  useSecretKmsProbe((_request, callNumber) => {
    return callNumber === 1
      ? Promise.reject(new Error("KMS unavailable"))
      : undefined;
  });
  return owned;
}

function createFailingWebhook(workflowId: string) {
  return rethrowingApp(workflowAutomationsContract).create({
    headers,
    params: { workflowId },
    body: webhook,
  });
}
