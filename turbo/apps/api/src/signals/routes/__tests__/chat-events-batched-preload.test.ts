import { randomUUID } from "node:crypto";
import {
  paidToolsContract,
  DISABLED_PAID_TOOLS_ENV_VAR,
} from "@okouai/api-contracts/contracts/paid-tools";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { paidToolsRoutes } from "../paid-tools";
import {
  createChatEventsFixture,
  claimEnvironment,
} from "./helpers/chat-events-fixture";

const context = testContext();
const {
  bdd,
  chat,
  webhooks,
  entitledNativeChatActor,
  sendChatRun,
  claimChatRun,
  cancelChatRun,
} = createChatEventsFixture(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

describe("batched identity preload through chat entry", () => {
  it("preserves missing-Agent rejection with no metadata or plan and settles the empty preload", async () => {
    const actor = bdd.user();
    const result = await chat.requestSendEvent(
      actor,
      {
        agentId: randomUUID(),
        model: "claude-fable-5-1",
        prompt: "missing organization snapshots",
      },
      [404],
    );
    expect(result.body).toMatchObject({
      error: { code: "NOT_FOUND", message: "Agent not found" },
    });
    await expect(flushWaitUntilForTest()).resolves.toBeUndefined();
  });

  it("keeps independent member preferences and paid-tool snapshots in one organization with no slot subscriptions or expired credits", async () => {
    const owner = await entitledNativeChatActor();
    await accept(
      setupApp({ context, routes: paidToolsRoutes })(paidToolsContract).update({
        headers,
        params: { toolId: "social" },
        body: { disabled: true },
      }),
      [200],
    );
    const member = bdd.user({
      orgId: owner.actor.orgId,
      orgRole: "org:member",
    });
    const { agentId } = await bdd.createAgent(member, {
      displayName: "Second member",
      visibility: "private",
    });
    webhooks.configureClerkWebhookSecret();
    webhooks.verifyNextClerkWebhook({
      type: "organizationMembership.created",
      data: {
        id: `membership-${member.userId}-${member.orgId}`,
        organization: { id: member.orgId },
        public_user_data: { user_id: member.userId },
        role: "org:member",
        created_at: now(),
      },
    });
    await webhooks.requestClerkWebhook("{}", {}, [200]);
    await flushWaitUntilForTest();
    for (const entry of [
      { actor: owner.actor, agentId: owner.agentId, disabled: ["social"] },
      { actor: member, agentId, disabled: [] },
    ]) {
      const run = await sendChatRun(entry.actor, {
        agentId: entry.agentId,
        model: "claude-fable-5-1",
        prompt: "member snapshot isolation",
      });
      const claimed = await claimChatRun(owner.runnerGroup, run.runId);
      expect(
        JSON.parse(
          claimEnvironment(claimed.claim)[DISABLED_PAID_TOOLS_ENV_VAR] ??
            "null",
        ),
      ).toStrictEqual(entry.disabled);
      await expect(
        chat.readThreadMetadata(entry.actor, run.threadId),
      ).resolves.toMatchObject({
        modelSettings: {},
        cloudBrowserEnabled: true,
      });
      await cancelChatRun(entry.actor, run.runId, claimed.sandboxHeaders);
    }
  });
});
