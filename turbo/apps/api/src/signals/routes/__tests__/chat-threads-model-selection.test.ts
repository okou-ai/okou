import { randomUUID } from "node:crypto";
import {
  chatThreadMetadataContract,
  chatThreadModelSelectionContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { chatThreadRoutes } from "../chat-threads";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClaudeCodeTokenEndpoint } from "./helpers/api-bdd-auth-device";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { credentials } from "./helpers/codex-reset-credit-expiry";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

const app = setupApp({
  context,
  routes: [...chatThreadRoutes, ...meModelProvidersUpsertRoutes],
});
const threadsApi = app(chatThreadsContract);
const metadataApi = app(chatThreadMetadataContract);
const modelSelectionApi = app(chatThreadModelSelectionContract);
const providersApi = app(personalModelProvidersMainContract);

function signIn(user: ApiTestUser, orgIdOverride?: string) {
  createRouteMocks(context).clerk.session(
    user.userId,
    orgIdOverride ?? user.orgId,
    user.orgRole ?? "org:admin",
  );
  return headers;
}

async function connectClaude(user: ApiTestUser): Promise<void> {
  mockClaudeCodeTokenEndpoint();
  await createRunsApi(context).createPersonalModelProvider(user, {
    type: "claude-code-oauth-token",
    secret: `claude-token-${randomUUID()}`,
  });
}

async function connectCodex(user: ApiTestUser): Promise<void> {
  server.use(
    http.get("https://chatgpt.com/backend-api/wham/usage", () => {
      return HttpResponse.json({ plan_type: "pro" });
    }),
  );
  await accept(
    providersApi.upsert({
      headers: signIn(user),
      body: {
        type: "codex-oauth-token",
        authMethod: "auth_json",
        secrets: { CODEX_AUTH_JSON: credentials().raw },
      },
    }),
    [201],
  );
}

async function readMetadata(user: ApiTestUser, threadId: string) {
  const response = await accept(
    metadataApi.get({
      headers: signIn(user),
      params: { id: threadId },
    }),
    [200],
  );
  return response.body;
}

async function readFeed(user: ApiTestUser, orgIdOverride?: string) {
  const response = await accept(
    threadsApi.events({
      headers: signIn(user, orgIdOverride),
      query: {},
    }),
    [200],
  );
  return response.body;
}

describe("POST /api/chat-threads/:id/model-selection", () => {
  it("chat-threads-model-selection-005 rejects an unavailable personal subscription without mutating selection", async () => {
    const member = bdd.user();
    await connectClaude(member);

    const created = await accept(
      threadsApi.create({
        headers: signIn(member),
        body: { title: "Unavailable personal", model: "claude-sonnet-5-5" },
      }),
      [201],
    );
    const threadId = created.body.id;

    const rejected = await accept(
      modelSelectionApi.update({
        headers: signIn(member),
        params: { id: threadId },
        body: { model: "gpt-6-luna" },
      }),
      [400],
    );
    expect(rejected.body.error.message).toMatch(/Auto/);
    expect(rejected.body.error.message).toMatch(/connect/i);

    expect((await readMetadata(member, threadId)).selectedModel).toBe(
      "claude-sonnet-5-5",
    );

    await accept(
      modelSelectionApi.update({
        headers: signIn(member),
        params: { id: threadId },
        body: { model: "claude-opus-5-5" },
      }),
      [204],
    );

    expect((await readMetadata(member, threadId)).selectedModel).toBe(
      "claude-opus-5-5",
    );
  });

  it("chat-threads-model-selection-003 refuses missing, foreign-owned and wrong-org targets without metadata or event effects", async () => {
    const owner = bdd.user();
    if (!owner.orgId) {
      throw new Error("Expected owner orgId");
    }
    const peer = bdd.user({ orgId: owner.orgId, orgRole: "org:member" });
    const otherOrgId = `org_${randomUUID()}`;
    await connectClaude(owner);

    const created = await accept(
      threadsApi.create({
        headers: signIn(owner),
        body: { title: "Owned thread", model: "claude-sonnet-5-5" },
      }),
      [201],
    );
    const threadId = created.body.id;

    const ownerMetadataBefore = await readMetadata(owner, threadId);
    const ownerFeedBefore = await readFeed(owner);
    const peerFeedBefore = await readFeed(peer);
    const otherOrgFeedBefore = await readFeed(owner, otherOrgId);

    await accept(
      modelSelectionApi.update({
        headers: signIn(owner),
        params: { id: randomUUID() },
        body: { model: null },
      }),
      [404],
    );
    await accept(
      modelSelectionApi.update({
        headers: signIn(peer),
        params: { id: threadId },
        body: { model: null },
      }),
      [404],
    );
    await accept(
      modelSelectionApi.update({
        headers: signIn(owner, otherOrgId),
        params: { id: threadId },
        body: { model: null },
      }),
      [404],
    );

    await expect(readMetadata(owner, threadId)).resolves.toStrictEqual(
      ownerMetadataBefore,
    );
    await expect(readFeed(owner)).resolves.toStrictEqual(ownerFeedBefore);
    await expect(readFeed(peer)).resolves.toStrictEqual(peerFeedBefore);
    await expect(readFeed(owner, otherOrgId)).resolves.toStrictEqual(
      otherOrgFeedBefore,
    );
  });

  it("chat-threads-model-selection-008 preserves each model's effort on a model switch", async () => {
    const member = bdd.user();
    await connectClaude(member);

    const created = await accept(
      threadsApi.create({
        headers: signIn(member),
        body: { title: "Effort switch", model: "claude-sonnet-5-5" },
      }),
      [201],
    );
    const threadId = created.body.id;

    await accept(
      modelSelectionApi.update({
        headers: signIn(member),
        params: { id: threadId },
        body: { model: "claude-sonnet-5-5", reasoningEffort: "extra" },
      }),
      [204],
    );

    await accept(
      modelSelectionApi.update({
        headers: signIn(member),
        params: { id: threadId },
        body: { model: "claude-opus-5-5" },
      }),
      [204],
    );

    const metadata = await readMetadata(member, threadId);
    expect(metadata.selectedModel).toBe("claude-opus-5-5");
    expect(metadata.modelSettings["claude-sonnet-5-5"]).toStrictEqual({
      effort: "extra",
    });
  });

  it("chat-threads-model-selection-004 saves and emits actual Codex Fast, preserves it for effort, and resets to standard", async () => {
    const owner = bdd.user();
    await connectClaude(owner);
    await connectCodex(owner);

    const created = await accept(
      threadsApi.create({
        headers: signIn(owner),
        body: { title: "Codex Fast", model: "gpt-6-luna" },
      }),
      [201],
    );
    const threadId = created.body.id;

    const fastModelEventId = randomUUID();
    const fastTierEventId = randomUUID();
    await accept(
      modelSelectionApi.update({
        headers: signIn(owner),
        params: { id: threadId },
        body: {
          model: "gpt-6-luna",
          codexServiceTier: "fast",
          eventId: fastModelEventId,
          serviceTierEventId: fastTierEventId,
        },
      }),
      [204],
    );
    const stage1 = await readMetadata(owner, threadId);
    expect(stage1.serviceTier).toBe("priority");

    const effortModelEventId = randomUUID();
    const effortTierEventId = randomUUID();
    await accept(
      modelSelectionApi.update({
        headers: signIn(owner),
        params: { id: threadId },
        body: {
          model: "gpt-6-luna",
          reasoningEffort: "high",
          eventId: effortModelEventId,
          serviceTierEventId: effortTierEventId,
        },
      }),
      [204],
    );
    const stage2 = await readMetadata(owner, threadId);
    expect(stage2.serviceTier).toBe("priority");

    const resetModelEventId = randomUUID();
    const resetTierEventId = randomUUID();
    await accept(
      modelSelectionApi.update({
        headers: signIn(owner),
        params: { id: threadId },
        body: {
          model: "gpt-6-luna",
          eventId: resetModelEventId,
          serviceTierEventId: resetTierEventId,
        },
      }),
      [204],
    );
    const stage3 = await readMetadata(owner, threadId);
    expect(stage3.serviceTier).toBeNull();

    const feedAfterReset = await readFeed(owner);
    const pairs = [
      {
        modelEventId: fastModelEventId,
        tierEventId: fastTierEventId,
        tier: "priority",
      },
      {
        modelEventId: effortModelEventId,
        tierEventId: effortTierEventId,
        tier: "priority",
      },
      {
        modelEventId: resetModelEventId,
        tierEventId: resetTierEventId,
        tier: null,
      },
    ] as const;
    for (const pair of pairs) {
      const idx = feedAfterReset.events.findIndex((event) => {
        return event.id === pair.modelEventId;
      });
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(feedAfterReset.events[idx]).toMatchObject({
        id: pair.modelEventId,
        kind: "model_selection_updated",
        selectedModel: "gpt-6-luna",
      });
      expect(feedAfterReset.events[idx + 1]).toMatchObject({
        id: pair.tierEventId,
        kind: "service_tier_updated",
        serviceTier: pair.tier,
      });
    }

    await accept(
      modelSelectionApi.update({
        headers: signIn(owner),
        params: { id: threadId },
        body: { model: "gpt-6-luna", codexServiceTier: "fast" },
      }),
      [204],
    );
    const metadataBeforeSonnet = await readMetadata(owner, threadId);
    const feedBeforeSonnet = await readFeed(owner);

    const sonnetWithEffort = await accept(
      modelSelectionApi.update({
        headers: signIn(owner),
        params: { id: threadId },
        body: { model: "claude-sonnet-5-5", reasoningEffort: "high" },
      }),
      [400],
    );
    expect(sonnetWithEffort.body.error.message).toBe(
      "Fast mode is unavailable for this model route",
    );

    const sonnetWithFast = await accept(
      modelSelectionApi.update({
        headers: signIn(owner),
        params: { id: threadId },
        body: { model: "claude-sonnet-5-5", codexServiceTier: "fast" },
      }),
      [400],
    );
    expect(sonnetWithFast.body.error.message).toBe(
      "Fast mode is unavailable for this model route",
    );

    await expect(readMetadata(owner, threadId)).resolves.toStrictEqual(
      metadataBeforeSonnet,
    );
    await expect(readFeed(owner)).resolves.toStrictEqual(feedBeforeSonnet);
  });
});
