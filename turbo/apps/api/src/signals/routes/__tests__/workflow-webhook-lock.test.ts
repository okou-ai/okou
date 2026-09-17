import { randomUUID } from "node:crypto";
import {
  workflowAutomationsContract,
  workflowVisibilityContract,
} from "@okouai/api-contracts/contracts/workflows";
import { replayChatThreadEvents } from "@okouai/core/chat-thread-event-replay";
import { onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { settleIncludingAbort } from "../../utils";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import { holdSecretKms } from "./helpers/hold-secret-kms";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const workflows = createWorkflowsBddApi(context);
const chat = createChatFilesBddApi(context);
const webhooks = createWebhookCallbackApi(context);
const bdd = createBddApi(context);
const mocks = createRouteMocks(context);

function client() {
  return setupApp({ context, routes: workflowAutomationsRoutes })(
    workflowAutomationsContract,
  );
}

function headers(actor?: ApiTestUser) {
  if (actor) {
    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  }
  return { authorization: "Bearer clerk-session" };
}

async function readThreads(actor: ApiTestUser) {
  const snapshot = await chat.getThreadSnapshot(actor);
  const page = await chat.requestThreadEvents(
    actor,
    snapshot.latestSeqId === null ? {} : { sinceSeqId: snapshot.latestSeqId },
    [200],
  );
  if (page.status !== 200) {
    throw new Error("Expected the chat thread feed");
  }
  expect(page.body.hasMore).toBeFalsy();
  return replayChatThreadEvents(snapshot.chatThreads, page.body.events);
}

async function scenario() {
  const org = await workflows.setupWorkflowOrg({ tier: "team" });
  const agent = await workflows.createAgent(org.actor, {
    displayName: "Webhook lock test",
  });
  const workflowId = await workflows.createWorkflow(org.actor, {
    agentId: agent.agentId,
    name: "webhook-lock-test",
  });
  const thread = await chat.createThread(org.actor, {
    agentId: agent.agentId,
    title: "Unrelated chat",
  });
  return { ...org, workflowId, thread };
}

function startCreation(
  workflowId: string,
  kms: ReturnType<typeof holdSecretKms>,
) {
  const creating = client().create({
    headers: headers(),
    params: { workflowId },
    body: { kind: "event", eventType: "webhook-received" },
  });
  const settled = settleIncludingAbort(creating);
  onTestFinished(async () => {
    kms.release();
    await settled;
  });
  return creating;
}

describe("webhook credential preparation lock isolation", () => {
  it.each([1, 2])(
    "allows unrelated chat writes while KMS call %i is stalled",
    async (callToHold) => {
      const { actor, workflowId, thread } = await scenario();
      const kms = holdSecretKms(callToHold, context.signal);
      const creating = startCreation(workflowId, kms);
      await kms.entered;

      await chat.renameThread(actor, thread.id, "Changed while KMS waits");
      await expect(readThreads(actor)).resolves.toContainEqual(
        expect.objectContaining({
          id: thread.id,
          title: "Changed while KMS waits",
        }),
      );
      const listed = await accept(
        client().list({ headers: headers(), params: { workflowId } }),
        [200],
      );
      expect(listed.body).toStrictEqual([]);
      await expect(readThreads(actor)).resolves.toHaveLength(1);

      kms.release();
      const created = await accept(creating, [201]);
      expect(created.body.chatThreadId).toBeTruthy();
      await expect(readThreads(actor)).resolves.toHaveLength(2);
      const revealed = await accept(
        client().revealWebhookSecret({
          headers: headers(),
          params: { id: created.body.id },
          body: undefined,
        }),
        [200],
      );
      expect(created.body).toMatchObject(revealed.body);
    },
    30_000,
  );

  it.each(["workflow", "agent"] as const)(
    "rejects creation when the public %s becomes private during KMS preparation",
    async (revokedEntity) => {
      const { actor: owner } = await workflows.setupWorkflowOrg({
        tier: "team",
      });
      const { agentId } = await workflows.createAgent(owner, {
        visibility: "public",
      });
      const workflowId = await workflows.createWorkflow(owner, {
        agentId,
        name: "revocable-webhook",
        visibility: "public",
      });
      const actor = bdd.user({ orgId: owner.orgId, orgRole: "org:member" });
      headers(actor);
      const kms = holdSecretKms(1, context.signal);
      const creating = startCreation(workflowId, kms);
      await kms.entered;
      const visibility = setupApp({ context, routes: workflowsRoutes })(
        workflowVisibilityContract,
      );
      if (revokedEntity === "workflow") {
        await accept(
          visibility.demote({
            headers: headers(owner),
            params: { workflowId },
          }),
          [200],
        );
      } else {
        await bdd.updateAgentMetadata(owner, agentId, {
          visibility: "private",
        });
      }
      kms.release();
      await accept(creating, [404]);

      if (revokedEntity === "workflow") {
        await accept(
          visibility.publish({
            headers: headers(owner),
            params: { workflowId },
          }),
          [200],
        );
      } else {
        await bdd.updateAgentMetadata(owner, agentId, { visibility: "public" });
      }
      const listed = await accept(
        client().list({ headers: headers(actor), params: { workflowId } }),
        [200],
      );
      expect(listed.body).toStrictEqual([]);
      await expect(readThreads(actor)).resolves.toStrictEqual([]);
    },
    30_000,
  );

  it("rejects creation after a downgrade commits while KMS is stalled", async () => {
    const { actor, subscriptionId, workflowId } = await scenario();
    const kms = holdSecretKms(1, context.signal);
    const creating = startCreation(workflowId, kms);
    await kms.entered;

    await webhooks.postStripeEvent(
      {
        id: `evt_webhook_kms_downgrade_${randomUUID()}`,
        type: "customer.subscription.deleted",
        data: { object: { id: subscriptionId } },
      },
      [200],
    );
    kms.release();
    const rejected = await accept(creating, [402]);
    expect(rejected.body.error.code).toBe("TEAM_REQUIRED");
    const listed = await accept(
      client().list({ headers: headers(), params: { workflowId } }),
      [200],
    );
    expect(listed.body).toStrictEqual([]);
    await expect(readThreads(actor)).resolves.toHaveLength(1);
  }, 30_000);

  it.each([1, 2])(
    "creates no automation or thread when KMS call %i fails",
    async (callToFail) => {
      const { actor, workflowId } = await scenario();
      useSecretKmsProbe((_request, callNumber) => {
        return callNumber === callToFail
          ? Promise.reject(new Error("KMS unavailable"))
          : undefined;
      });
      const failed = await createApp({
        signal: context.signal,
        routes: workflowAutomationsRoutes,
      }).request(`/api/workflows/${workflowId}/automations`, {
        method: "POST",
        headers: { ...headers(), "content-type": "application/json" },
        body: JSON.stringify({
          kind: "event",
          eventType: "webhook-received",
        }),
      });
      expect(failed.status).toBe(500);
      const listed = await accept(
        client().list({ headers: headers(), params: { workflowId } }),
        [200],
      );
      expect(listed.body).toStrictEqual([]);
      await expect(readThreads(actor)).resolves.toHaveLength(1);
    },
  );
});
