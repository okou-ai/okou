import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { userModelPreferenceRoutes } from "../user-model-preference";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";

const context = testContext();
const {
  bdd,
  api,
  chat,
  misc,
  webhooks,
  entitledNativeChatActor,
  sendChatRun,
  cancelChatRun,
} = createChatEventsFixture(context);

function preferencesClient() {
  return setupApp({ context, routes: userModelPreferenceRoutes })(
    userModelPreferenceContract,
  );
}

const headers = Object.freeze({ authorization: "Bearer clerk-session" });

describe("new chat event member defaults", () => {
  it("uses empty model settings and enables cloud browser without a saved member preference", async () => {
    const owner = await entitledNativeChatActor();
    const actor = bdd.user({ orgId: owner.actor.orgId, orgRole: "org:member" });
    // Connect this member without writing model/preferences so absent defaults remain real.
    await api.createPersonalModelProvider(actor, {
      type: "claude-code-oauth-token",
      secret: "bdd-member-defaults-claude-token",
    });
    const { agentId } = await bdd.createAgent(actor, {
      displayName: "Member without saved preferences",
      description: "Uses absent preference defaults",
      visibility: "private",
    });
    // The membership entry initializes memory without creating Web preferences.
    webhooks.configureClerkWebhookSecret();
    webhooks.verifyNextClerkWebhook({
      type: "organizationMembership.created",
      data: {
        id: `membership-${actor.userId}-${actor.orgId}`,
        organization: { id: actor.orgId },
        public_user_data: { user_id: actor.userId },
        role: "org:member",
        created_at: now(),
      },
    });
    await webhooks.requestClerkWebhook("{}", {}, [200]);
    await flushWaitUntilForTest();
    const preference = await accept(
      preferencesClient().get({ headers }),
      [200],
    );
    expect(preference.body.updatedAt).toBeNull();

    const run = await sendChatRun(actor, {
      agentId,
      model: "claude-fable-5-1",
      prompt: "use missing member defaults",
    });
    await expect(
      chat.readThreadMetadata(actor, run.threadId),
    ).resolves.toMatchObject({
      modelSettings: {},
      cloudBrowserEnabled: true,
    });
    await cancelChatRun(actor, run.runId);
  });

  it.each([true, false])(
    "captures saved model settings and cloud browser (%s), retaining them on continuation",
    async (enabled) => {
      const { actor, agentId } = await entitledNativeChatActor();
      await misc.updatePreferences(
        actor,
        { cloudBrowserEnabledByDefault: enabled },
        [200],
      );
      await accept(
        preferencesClient().update({
          headers,
          body: {
            selectedModel: "claude-fable-5-1",
            serviceTier: null,
            modelSettingsPatch: { model: "claude-fable-5-1", effort: "high" },
          },
        }),
        [200],
      );
      const first = await sendChatRun(actor, {
        agentId,
        prompt: "capture saved member defaults",
      });
      await expect(
        chat.readThreadMetadata(actor, first.threadId),
      ).resolves.toMatchObject({
        modelSettings: { "claude-fable-5-1": { effort: "high" } },
        cloudBrowserEnabled: enabled,
      });
      await cancelChatRun(actor, first.runId);

      await misc.updatePreferences(
        actor,
        { cloudBrowserEnabledByDefault: !enabled },
        [200],
      );
      await accept(
        preferencesClient().update({
          headers,
          body: {
            selectedModel: "claude-fable-5-1",
            serviceTier: null,
            modelSettingsPatch: { model: "claude-fable-5-1", effort: "low" },
          },
        }),
        [200],
      );
      const continued = await sendChatRun(actor, {
        agentId,
        threadId: first.threadId,
        prompt: "keep the thread snapshot",
      });
      await expect(
        chat.readThreadMetadata(actor, continued.threadId),
      ).resolves.toMatchObject({
        modelSettings: { "claude-fable-5-1": { effort: "high" } },
        cloudBrowserEnabled: enabled,
      });
      await cancelChatRun(actor, continued.runId);

      const next = await sendChatRun(actor, {
        agentId,
        prompt: "observe the next member snapshot",
      });
      await expect(
        chat.readThreadMetadata(actor, next.threadId),
      ).resolves.toMatchObject({
        modelSettings: { "claude-fable-5-1": { effort: "low" } },
        cloudBrowserEnabled: !enabled,
      });
      await cancelChatRun(actor, next.runId);
    },
  );
});
