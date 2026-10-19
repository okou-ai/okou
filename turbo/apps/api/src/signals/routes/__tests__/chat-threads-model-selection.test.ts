import { randomUUID } from "node:crypto";
import { agentsMainContract } from "@okouai/api-contracts/contracts/agents";
import {
  chatThreadMetadataContract,
  chatThreadModelSelectionContract,
  type ChatThreadEvent,
} from "@okouai/api-contracts/contracts/chat-threads";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { agentsRoutes } from "../agents";
import { createRouteMocks } from "./helpers/route-test";
import { mockClerkUsers } from "./helpers/clerk-users";
import {
  createAuthDeviceApiActions,
  mockCodexDeviceAuthProvider,
} from "./helpers/api-bdd-auth-device";
import { mockNow } from "../../../lib/time";
import { chatThreadGetRoutes } from "../chat-threads-get";
import { chatThreadModelSelectionRoutes } from "../chat-threads-model-selection";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createClaimedRunCredentials } from "./helpers/claimed-run-credentials";
import { seedOrgMembership$ } from "./helpers/org-membership";

const context = testContext();
const claimedToken = createClaimedRunCredentials(context).okouToken;
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
  const app = await setupApp({
    context,
    routes: agentsRoutes,
    isolatePg: true,
  });
  const actor = bdd.user();
  if (!actor.orgId) {
    throw new Error("Expected the seeded actor to belong to an org");
  }
  await store.set(
    seedOrgMembership$,
    { orgId: actor.orgId, userId: actor.userId },
    context.signal,
  );
  bdd.acceptAgentStorageWrites();
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  mockClerkUsers(context, [
    {
      id: actor.userId,
      emailAddresses: [{ id: "email", emailAddress: actor.email }],
      primaryEmailAddressId: "email",
    },
  ]);
  const created = await accept(
    app(agentsMainContract).create({
      headers: { authorization: "Bearer clerk-session" },
      body: {
        displayName: "Chat thread model selection agent",
        visibility: "private",
      },
    }),
    [201],
  );
  const agent = created.body;
  await api.ensurePersonalSubscriptionModel(actor);
  const thread = await chat.createThread(actor, {
    agentId: agent.agentId,
    title,
    model: "claude-sonnet-5-5",
  });
  return {
    actor,
    userId: actor.userId,
    orgId: actor.orgId,
    agentId: agent.agentId,
    threadId: thread.id,
  };
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

async function threadEvents(fixture: ChatThreadFixture) {
  const response = await chat.requestThreadEvents(fixture.actor, {}, [200]);
  if (response.status !== 200) {
    throw new Error("Expected thread events");
  }
  return response.body.events.filter((event) => {
    return event.chatThreadId === fixture.threadId;
  });
}

function expectAdjacentPair(events: readonly ChatThreadEvent[]) {
  const [model, tier] = events;
  if (!model || !tier) {
    throw new Error("Expected a model and service-tier event pair");
  }
  expect(tier.seqId).toBe(model.seqId + 1);
  expect(tier.createdAt).toBe(model.createdAt);
}

async function connectCodex(fixture: ChatThreadFixture) {
  mockCodexDeviceAuthProvider({ accountId: `metadata-${randomUUID()}` });
  const auth = createAuthDeviceApiActions(context);
  const started = await auth.requestCodexStart(
    fixture.actor,
    "personal",
    [200],
    { mode: "add" },
  );
  if (started.status !== 200) {
    throw new Error("Expected Codex consent start");
  }
  const completed = await auth.requestCodexComplete(
    fixture.actor,
    started.body.sessionToken,
    [200],
  );
  expect(completed.body).toMatchObject({ status: "complete" });
  await api.updateUserModelPreference(fixture.actor, "gpt-6-luna");
}

describe("POST /api/chat-threads/:id/model-selection", () => {
  it("retains concurrent per-model efforts and publishes adjacent event pairs for each save", async () => {
    const fixture = await seedChatThread("Concurrent model efforts");
    await connectCodex(fixture);
    const saves = [
      {
        model: "claude-sonnet-5-5",
        effort: "high",
        codexServiceTier: null,
        serviceTier: null,
        eventId: randomUUID(),
        serviceTierEventId: randomUUID(),
      },
      {
        model: "gpt-6-luna",
        effort: "high",
        codexServiceTier: "fast",
        serviceTier: "priority",
        eventId: randomUUID(),
        serviceTierEventId: randomUUID(),
      },
    ] as const;
    const operationTime = new Date("2026-10-16T08:30:00.123Z");
    mockNow(operationTime);
    await Promise.all(
      saves.map((save) => {
        return chat.updateThreadModelSelection(
          fixture.actor,
          fixture.threadId,
          save.model,
          {
            reasoningEffort: save.effort,
            codexServiceTier: save.codexServiceTier,
            eventId: save.eventId,
            serviceTierEventId: save.serviceTierEventId,
          },
        );
      }),
    );
    const ids = new Set<string>(
      saves.flatMap((save) => {
        return [save.eventId, save.serviceTierEventId];
      }),
    );
    const events = (await threadEvents(fixture)).filter((event) => {
      return ids.has(event.id);
    });
    expect(events).toHaveLength(4);
    for (const save of saves) {
      const pair = events.filter((event) => {
        return (
          event.id === save.eventId || event.id === save.serviceTierEventId
        );
      });
      expect(pair).toStrictEqual([
        expect.objectContaining({
          id: save.eventId,
          kind: "model_selection_updated",
          agentId: fixture.agentId,
          selectedModel: save.model,
          modelSettingsPatch: { model: save.model, effort: save.effort },
          createdAt: operationTime.toISOString(),
        }),
        expect.objectContaining({
          id: save.serviceTierEventId,
          kind: "service_tier_updated",
          agentId: fixture.agentId,
          serviceTier: save.serviceTier,
          createdAt: operationTime.toISOString(),
        }),
      ]);
      expectAdjacentPair(pair);
    }
    const winner = events
      .filter((event) => {
        return event.kind === "model_selection_updated";
      })
      .at(-1);
    const finalTier = events.at(-1);
    if (!winner || !finalTier) {
      throw new Error(
        "Expected both successful saves in the public event stream",
      );
    }
    await expect(
      chat.readThreadMetadata(fixture.actor, fixture.threadId),
    ).resolves.toMatchObject({
      selectedModel: winner.selectedModel,
      serviceTier: finalTier.serviceTier,
      modelSettings: {
        "claude-sonnet-5-5": { effort: "high" },
        "gpt-6-luna": { effort: "high" },
      },
    });
  });

  it("deduplicates repeated event IDs and permits a later save with new IDs", async () => {
    const fixture = await seedChatThread("Event identity deduplication");
    const ids = { eventId: randomUUID(), serviceTierEventId: randomUUID() };
    await chat.updateThreadModelSelection(
      fixture.actor,
      fixture.threadId,
      "claude-opus-5-5",
      { ...ids, reasoningEffort: "extra" },
    );
    const saved = await chat.readThreadMetadata(
      fixture.actor,
      fixture.threadId,
    );
    const published = await threadEvents(fixture);
    await chat.updateThreadModelSelection(
      fixture.actor,
      fixture.threadId,
      "claude-opus-5-5",
      { ...ids, reasoningEffort: "extra" },
    );
    await expect(
      chat.readThreadMetadata(fixture.actor, fixture.threadId),
    ).resolves.toStrictEqual(saved);
    await expect(threadEvents(fixture)).resolves.toStrictEqual(published);
    const next = { eventId: randomUUID(), serviceTierEventId: randomUUID() };
    await chat.updateThreadModelSelection(
      fixture.actor,
      fixture.threadId,
      "claude-sonnet-5-5",
      { ...next, reasoningEffort: "high" },
    );
    const events = await threadEvents(fixture);
    expect(events).toStrictEqual([
      ...published,
      expect.objectContaining({
        id: next.eventId,
        kind: "model_selection_updated",
        selectedModel: "claude-sonnet-5-5",
        modelSettingsPatch: { model: "claude-sonnet-5-5", effort: "high" },
      }),
      expect.objectContaining({
        id: next.serviceTierEventId,
        kind: "service_tier_updated",
        serviceTier: null,
      }),
    ]);
    const nextPair = events.slice(-2);
    expectAdjacentPair(nextPair);
    const previous = published.at(-1);
    const nextModel = nextPair[0];
    if (!previous || !nextModel) {
      throw new Error("Expected the previous and new event groups");
    }
    // Repeated IDs reserve their positions even though their events already exist.
    expect(nextModel.seqId).toBe(previous.seqId + 3);
    await expect(
      chat.readThreadMetadata(fixture.actor, fixture.threadId),
    ).resolves.toMatchObject({
      selectedModel: "claude-sonnet-5-5",
      modelSettings: {
        "claude-opus-5-5": { effort: "extra" },
        "claude-sonnet-5-5": { effort: "high" },
      },
    });
  });

  it("refuses missing, foreign-owned and wrong-org targets without metadata or event effects", async () => {
    const fixture = await seedChatThread("Ownership boundary");
    const saved = await chat.readThreadMetadata(
      fixture.actor,
      fixture.threadId,
    );
    const published = await threadEvents(fixture);
    const foreign = bdd.user({ orgId: fixture.orgId });
    const wrongOrg = bdd.user({ userId: fixture.userId });
    for (const [actor, threadId] of [
      [fixture.actor, randomUUID()],
      [foreign, fixture.threadId],
      [wrongOrg, fixture.threadId],
    ] as const) {
      const before = await chat.requestThreadEvents(actor, {}, [200]);
      await chat.requestUpdateThreadModelSelection(
        actor,
        threadId,
        "claude-sonnet-5-5",
        [404],
        {
          reasoningEffort: "high",
          eventId: randomUUID(),
          serviceTierEventId: randomUUID(),
        },
      );
      const after = await chat.requestThreadEvents(actor, {}, [200]);
      expect(after.body).toStrictEqual(before.body);
      await expect(
        chat.readThreadMetadata(fixture.actor, fixture.threadId),
      ).resolves.toStrictEqual(saved);
      await expect(threadEvents(fixture)).resolves.toStrictEqual(published);
    }
  });

  it("saves and emits actual Codex Fast, preserves it for effort, and resets to standard", async () => {
    const fixture = await seedChatThread("Codex service tiers");
    await connectCodex(fixture);
    const stages = [
      {
        options: { codexServiceTier: "fast" as const },
        serviceTier: "priority",
      },
      {
        options: { reasoningEffort: "high" as const },
        serviceTier: "priority",
      },
      { options: {}, serviceTier: null },
    ] as const;
    const expected = [];
    for (const stage of stages) {
      const eventId = randomUUID();
      const serviceTierEventId = randomUUID();
      await chat.updateThreadModelSelection(
        fixture.actor,
        fixture.threadId,
        "gpt-6-luna",
        { ...stage.options, eventId, serviceTierEventId },
      );
      await expect(
        chat.readThreadMetadata(fixture.actor, fixture.threadId),
      ).resolves.toMatchObject({
        selectedModel: "gpt-6-luna",
        serviceTier: stage.serviceTier,
      });
      expected.push(
        expect.objectContaining({
          id: eventId,
          kind: "model_selection_updated",
          agentId: fixture.agentId,
          selectedModel: "gpt-6-luna",
        }),
        expect.objectContaining({
          id: serviceTierEventId,
          kind: "service_tier_updated",
          agentId: fixture.agentId,
          serviceTier: stage.serviceTier,
        }),
      );
    }
    const events = (await threadEvents(fixture)).filter((event) => {
      return event.kind !== "created";
    });
    expect(events).toStrictEqual(expected);
    for (let i = 0; i < events.length; i += 2) {
      expectAdjacentPair(events.slice(i, i + 2));
    }
    await chat.updateThreadModelSelection(
      fixture.actor,
      fixture.threadId,
      "gpt-6-luna",
      { codexServiceTier: "fast" },
    );
    const saved = await chat.readThreadMetadata(
      fixture.actor,
      fixture.threadId,
    );
    const before = await threadEvents(fixture);
    for (const options of [
      { reasoningEffort: "high" as const },
      { codexServiceTier: "fast" as const },
    ]) {
      const refused = await chat.requestUpdateThreadModelSelection(
        fixture.actor,
        fixture.threadId,
        "claude-sonnet-5-5",
        [400],
        options,
      );
      expect(refused.body).toMatchObject({
        error: { message: "Fast mode is unavailable for this model route" },
      });
      await expect(
        chat.readThreadMetadata(fixture.actor, fixture.threadId),
      ).resolves.toStrictEqual(saved);
      await expect(threadEvents(fixture)).resolves.toStrictEqual(before);
    }
  });

  it("rejects an unavailable personal subscription without mutating selection", async () => {
    const fixture = await seedChatThread("Personal subscription availability");

    const rejected = await chat.requestUpdateThreadModelSelection(
      fixture.actor,
      fixture.threadId,
      "gpt-6-luna",
      [400],
    );
    expect(rejected.body).toMatchObject({
      error: {
        message:
          "Select Auto or a model from your connected personal subscription",
      },
    });
    await expect(
      chat.readThreadMetadata(fixture.actor, fixture.threadId),
    ).resolves.toMatchObject({ selectedModel: "claude-sonnet-5-5" });

    await chat.updateThreadModelSelection(
      fixture.actor,
      fixture.threadId,
      "claude-opus-5-5",
    );
    await expect(
      chat.readThreadMetadata(fixture.actor, fixture.threadId),
    ).resolves.toMatchObject({ selectedModel: "claude-opus-5-5" });
  });

  it("rejects unsupported effort levels and persists supported ones", async () => {
    const fixture = await seedChatThread("Effort validation");
    for (const [model, reasoningEffort] of [
      ["claude-opus-5-5", "xhigh"],
      ["claude-sonnet-5-5", "xhigh"],
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
        "claude-sonnet-5-5",
        { reasoningEffort },
      );
      await expect(
        chat.readThreadMetadata(fixture.actor, fixture.threadId),
      ).resolves.toMatchObject({
        modelSettings: { "claude-sonnet-5-5": { effort: reasoningEffort } },
      });
    }
  });

  it("persists independent model efforts and emits single-model patches", async () => {
    const fixture = await seedChatThread("Effort persistence");
    await chat.updateThreadModelSelection(
      fixture.actor,
      fixture.threadId,
      "claude-sonnet-5-5",
      { reasoningEffort: "high" },
    );
    await chat.updateThreadModelSelection(
      fixture.actor,
      fixture.threadId,
      "claude-opus-5-5",
    );
    await expect(
      chat.readThreadMetadata(fixture.actor, fixture.threadId),
    ).resolves.toMatchObject({
      selectedModel: "claude-opus-5-5",
      modelSettings: { "claude-sonnet-5-5": { effort: "high" } },
    });
    await chat.updateThreadModelSelection(
      fixture.actor,
      fixture.threadId,
      "claude-opus-5-5",
      { reasoningEffort: "extra" },
    );
    await expect(
      chat.readThreadMetadata(fixture.actor, fixture.threadId),
    ).resolves.toMatchObject({
      modelSettings: {
        "claude-sonnet-5-5": { effort: "high" },
        "claude-opus-5-5": { effort: "extra" },
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
          model: "claude-sonnet-5-5",
          effort: "high",
        },
      }),
    );
    expect(events.body.events).toContainEqual(
      expect.objectContaining({
        kind: "model_selection_updated",
        modelSettingsPatch: {
          model: "claude-opus-5-5",
          effort: "extra",
        },
      }),
    );
  });

  it("preserves each model's effort on a model switch", async () => {
    const fixture = await seedChatThread("Effort model switch");
    await chat.updateThreadModelSelection(
      fixture.actor,
      fixture.threadId,
      "claude-sonnet-5-5",
      { reasoningEffort: "extra" },
    );
    await chat.updateThreadModelSelection(
      fixture.actor,
      fixture.threadId,
      "claude-opus-5-5",
    );
    const metadata = await chat.readThreadMetadata(
      fixture.actor,
      fixture.threadId,
    );
    expect(metadata).toMatchObject({
      selectedModel: "claude-opus-5-5",
      modelSettings: { "claude-sonnet-5-5": { effort: "extra" } },
    });
  });

  it.each([
    ["claude-fable-5", "claude-fable-5-1"],
    ["claude-sonnet-4-6", "claude-sonnet-5-5"],
    ["claude-opus-4-8", "claude-opus-5-5"],
  ] as const)(
    "stores and records the replacement when an old client requests retired %s",
    async (retiredModel, replacement) => {
      const fixture = await seedChatThread("Model retirement");

      const token = await claimedToken({
        userId: fixture.userId,
        orgId: fixture.orgId,
      });
      const headers = { authorization: `Bearer ${token}` };
      await accept(
        modelSelectionClient().update({
          headers,
          params: { id: fixture.threadId },
          body: { model: retiredModel },
        }),
        [204],
      );
      const thread = await accept(
        metadataClient().get({ headers, params: { id: fixture.threadId } }),
        [200],
      );
      expect(thread.body.selectedModel).toBe(replacement);
      // The event carries the stored model, so replay never restores the
      // retired id.
      const events = await chat.requestThreadEvents(fixture.actor, {}, [200]);
      if (events.status !== 200) {
        throw new Error("Expected thread events");
      }
      expect(
        events.body.events.filter((event) => {
          return (
            event.chatThreadId === fixture.threadId &&
            event.kind === "model_selection_updated"
          );
        }),
      ).toStrictEqual([
        expect.objectContaining({ selectedModel: replacement }),
      ]);
    },
  );

  it("updates thread model selection with an Okou run token carrying chat-thread:write", async () => {
    const fixture = await seedChatThread("Launch plan");
    const token = await claimedToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
    });

    await accept(
      modelSelectionClient().update({
        headers: { authorization: `Bearer ${token}` },
        params: { id: fixture.threadId },
        body: {
          model: "claude-sonnet-5-5",
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
      archived: false,
      hidden: false,
      muted: false,
      selectedModel: "claude-sonnet-5-5",
      modelSettings: {},
      serviceTier: null,
      computerUseHostId: null,
      cloudBrowserEnabled: true,
    });
  });
});
