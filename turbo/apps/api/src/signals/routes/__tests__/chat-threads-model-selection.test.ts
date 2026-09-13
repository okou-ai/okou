import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { randomUUID } from "node:crypto";

import {
  chatThreadMetadataContract,
  chatThreadModelSelectionContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import { DEFAULT_IMAGE_MODEL } from "@okouai/core/image-model-catalog";
import { DEFAULT_VIDEO_MODEL } from "@okouai/core/video-model-catalog";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { chatThreadGetRoutes } from "../chat-threads-get";
import { chatThreadModelSelectionRoutes } from "../chat-threads-model-selection";

const context = testContext();
const store = createStore();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const api = createRunsApi(context);

interface ChatThreadFixture {
  readonly actor: ApiTestUser;
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly threadId: string;
}

/** Creates an agent and chat thread through the product routes. */
async function seedChatThread(title: string): Promise<ChatThreadFixture> {
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  const { providerId } = await api.ensureOrgModelProvider(actor);
  await api.updateOrgModelPolicies(
    actor,
    (["claude-sonnet-5", "claude-sonnet-4-6", "claude-opus-4-8"] as const).map(
      (model) => {
        return {
          model,
          isDefault: model === "claude-sonnet-5",
          defaultProviderType: "anthropic-api-key",
          credentialScope: "org",
          modelProviderId: providerId,
        };
      },
    ),
  );
  const agent = await bdd.createAgent(actor, {
    displayName: "Chat thread model selection agent",
    visibility: "private",
  });
  const thread = await chat.createThread(actor, {
    agentId: agent.agentId,
    title,
    model: "claude-sonnet-5",
  });
  if (!actor.orgId) {
    throw new Error("Expected the seeded actor to belong to an org");
  }
  await store.set(
    seedOrgMembership$,
    { orgId: actor.orgId, userId: actor.userId },
    context.signal,
  );
  return {
    actor,
    userId: actor.userId,
    orgId: actor.orgId,
    agentId: agent.agentId,
    threadId: thread.id,
  };
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function okouToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly capabilities: readonly Capability[];
}): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "okou",
    userId: args.userId,
    orgId: args.orgId,
    runId: `run_${randomUUID()}`,
    capabilities: [...args.capabilities],
    iat: seconds,
    exp: seconds + 600,
  });
}

function modelSelectionClient() {
  return setupApp({ context, routes: chatThreadModelSelectionRoutes })(
    chatThreadModelSelectionContract,
  );
}

function metadataClient() {
  return setupApp({ context, routes: chatThreadGetRoutes })(
    chatThreadMetadataContract,
  );
}

describe("POST /api/chat-threads/:id/model-selection", () => {
  it("rejects effort while disabled and unsupported levels while enabled", async () => {
    const fixture = await seedChatThread("Effort validation");
    const disabled = await chat.requestUpdateThreadModelSelection(
      fixture.actor,
      fixture.threadId,
      "claude-sonnet-5",
      [400],
      { reasoningEffort: "high" },
    );
    expect(disabled.body).toMatchObject({
      error: { message: "Reasoning effort selection is not enabled" },
    });
    await updateFeatureSwitchesForUser(context, fixture, {
      [FeatureSwitchKey.ChatReasoningEffort]: true,
    });
    for (const [model, reasoningEffort] of [
      ["claude-sonnet-4-6", "extra"],
      ["claude-sonnet-5", "xhigh"],
    ] as const) {
      const unsupported = await chat.requestUpdateThreadModelSelection(
        fixture.actor,
        fixture.threadId,
        model,
        [400],
        { reasoningEffort },
      );
      expect(unsupported.body).toMatchObject({
        error: {
          message: "Reasoning effort is not supported by the selected model",
        },
      });
    }
    for (const reasoningEffort of ["extra", "ultracode"] as const) {
      await chat.updateThreadModelSelection(
        fixture.actor,
        fixture.threadId,
        "claude-sonnet-5",
        { reasoningEffort },
      );
      await expect(
        chat.readThreadMetadata(fixture.actor, fixture.threadId),
      ).resolves.toMatchObject({
        modelSettings: { "claude-sonnet-5": { effort: reasoningEffort } },
      });
    }
  });

  it("persists independent model efforts and emits single-model patches", async () => {
    const fixture = await seedChatThread("Effort persistence");
    await updateFeatureSwitchesForUser(context, fixture, {
      [FeatureSwitchKey.ChatReasoningEffort]: true,
    });
    await chat.updateThreadModelSelection(
      fixture.actor,
      fixture.threadId,
      "claude-sonnet-5",
      { reasoningEffort: "high" },
    );
    await chat.updateThreadModelSelection(
      fixture.actor,
      fixture.threadId,
      "claude-opus-4-8",
    );
    await expect(
      chat.readThreadMetadata(fixture.actor, fixture.threadId),
    ).resolves.toMatchObject({
      selectedModel: "claude-opus-4-8",
      modelSettings: { "claude-sonnet-5": { effort: "high" } },
    });
    // Disabled rollout rejects explicit settings without erasing preferences.
    await updateFeatureSwitchesForUser(context, fixture, {
      [FeatureSwitchKey.ChatReasoningEffort]: false,
    });
    const disabledReset = await chat.requestUpdateThreadModelSelection(
      fixture.actor,
      fixture.threadId,
      "claude-opus-4-8",
      [400],
      { reasoningEffort: "low" },
    );
    expect(disabledReset.body).toMatchObject({
      error: { message: "Reasoning effort selection is not enabled" },
    });
    await expect(
      chat.readThreadMetadata(fixture.actor, fixture.threadId),
    ).resolves.toMatchObject({
      modelSettings: { "claude-sonnet-5": { effort: "high" } },
    });
    await updateFeatureSwitchesForUser(context, fixture, {
      [FeatureSwitchKey.ChatReasoningEffort]: true,
    });
    await chat.updateThreadModelSelection(
      fixture.actor,
      fixture.threadId,
      "claude-opus-4-8",
      { reasoningEffort: "extra" },
    );
    await expect(
      chat.readThreadMetadata(fixture.actor, fixture.threadId),
    ).resolves.toMatchObject({
      modelSettings: {
        "claude-sonnet-5": { effort: "high" },
        "claude-opus-4-8": { effort: "extra" },
      },
    });
    const events = await chat.requestThreadEvents(fixture.actor, {}, [200]);
    if (events.status !== 200) {
      throw new Error("Expected thread events");
    }
    expect(events.body.events).toContainEqual(
      expect.objectContaining({
        kind: "model_selection_updated",
        modelSettingsPatch: {
          model: "claude-sonnet-5",
          effort: "high",
        },
      }),
    );
    expect(events.body.events).toContainEqual(
      expect.objectContaining({
        kind: "model_selection_updated",
        modelSettingsPatch: {
          model: "claude-opus-4-8",
          effort: "extra",
        },
      }),
    );
  });

  it("preserves each model's effort on a model switch", async () => {
    const fixture = await seedChatThread("Effort model switch");
    await updateFeatureSwitchesForUser(context, fixture, {
      [FeatureSwitchKey.ChatReasoningEffort]: true,
    });
    await chat.updateThreadModelSelection(
      fixture.actor,
      fixture.threadId,
      "claude-sonnet-5",
      { reasoningEffort: "extra" },
    );
    await chat.updateThreadModelSelection(
      fixture.actor,
      fixture.threadId,
      "claude-sonnet-4-6",
    );
    const metadata = await chat.readThreadMetadata(
      fixture.actor,
      fixture.threadId,
    );
    expect(metadata).toMatchObject({
      selectedModel: "claude-sonnet-4-6",
      modelSettings: { "claude-sonnet-5": { effort: "extra" } },
    });
  });

  it("preserves the thread selection when an old client requests a retired model", async () => {
    const fixture = await seedChatThread("Model retirement");
    const token = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:read", "chat-thread:write"],
    });
    const headers = { authorization: `Bearer ${token}` };
    const rejected = await accept(
      modelSelectionClient().update({
        headers,
        params: { id: fixture.threadId },
        body: { model: "claude-fable-5" },
      }),
      [400],
    );
    expect(rejected.body.error.message).toBe(
      "Claude Fable 5 has been retired. Select Claude Fable 5.1.",
    );
    const thread = await accept(
      metadataClient().get({ headers, params: { id: fixture.threadId } }),
      [200],
    );
    expect(thread.body.selectedModel).toBe("claude-sonnet-5");
  });

  it("updates thread model selection with an Okou run token carrying chat-thread:write", async () => {
    const fixture = await seedChatThread("Launch plan");
    const token = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:read", "chat-thread:write"],
    });

    await accept(
      modelSelectionClient().update({
        headers: { authorization: `Bearer ${token}` },
        params: { id: fixture.threadId },
        body: {
          model: "claude-sonnet-5",
        },
      }),
      [204],
    );

    const response = await accept(
      metadataClient().get({
        headers: { authorization: `Bearer ${token}` },
        params: { id: fixture.threadId },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      id: fixture.threadId,
      agentId: fixture.agentId,
      title: "Launch plan",
      pinnedAt: null,
      selectedModel: "claude-sonnet-5",
      modelSettings: {},
      serviceTier: null,
      computerUseHostId: null,
      cloudBrowserEnabled: false,
      selectedVideoModel: DEFAULT_VIDEO_MODEL,
      selectedImageModel: DEFAULT_IMAGE_MODEL,
    });
  });

  it("rejects an Okou run token without chat-thread:write", async () => {
    const fixture = await seedChatThread("Launch plan");
    const token = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:read"],
    });

    const response = await accept(
      modelSelectionClient().update({
        headers: { authorization: `Bearer ${token}` },
        params: { id: fixture.threadId },
        body: {
          model: "claude-sonnet-5",
        },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        code: "FORBIDDEN",
        message: "Missing required capability: chat-thread:write",
      },
    });
  });
});
