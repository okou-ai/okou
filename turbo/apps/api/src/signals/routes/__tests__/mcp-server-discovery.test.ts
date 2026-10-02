import { randomUUID } from "node:crypto";
import {
  mcpGetChatIndicatorsOutputSchema,
  mcpListChatThreadsOutputSchema,
} from "@okouai/api-contracts/contracts/mcp-chat-threads";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import { modelPoliciesMainContract } from "@okouai/api-contracts/contracts/model-policies";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { now, withMockNowForTest } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { userModelPreferenceRoutes } from "../user-model-preference";
import { modelPoliciesRoutes } from "../model-policies";
import { insertBuiltInModelMirrorFixture } from "../../../test-fixtures/model-catalog";
import { createRouteMocks } from "./helpers/route-test";
import { seedOrgMetadata } from "../../../test-fixtures/system-config-seeds";
import { createBddApi } from "./helpers/api-bdd";
import { makeCodexAuthJson } from "./helpers/api-bdd-auth-device";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import {
  coolDownBuiltInCandidatesFixture,
  seedBuiltInModelCandidateKeys,
} from "./helpers/runtime-state";
import { SEEDED_SYSTEM_DEFAULT_MODEL } from "./helpers/seeded-system-default";
import {
  defaultScopes,
  expectSubstantialCompactSuccess,
  rpc,
  requestBody,
  protocolHeaders,
  createMcpServerTestApi,
} from "./helpers/mcp-server";
import {
  createMcpServerFixtures,
  NATIVE_RUNNER_MODEL,
} from "./helpers/mcp-server-fixtures";

const context = testContext();
const {
  client,
  fixture,
  callTool,
  structuredToolError,
  getIndicators,
  listThreads,
  getThread,
  getMessages,
  listAgents,
  listModels,
  createThread,
} = createMcpServerTestApi(context);
const { creationFixture, threadFixture, chatRunFixture } =
  createMcpServerFixtures(context);

describe("MCP chat discovery and creation", () => {
  it("lists only visible Agents with bounded descriptions and principal-bound pagination", async () => {
    const f = await threadFixture();
    const peer = f.bdd.user({ orgId: f.auth.orgId });
    const shared = await f.bdd.createAgent(peer, {
      displayName: "Shared Agent",
      visibility: "public",
      description: "Public description ".repeat(500),
    });
    const hidden = await f.bdd.createAgent(peer, {
      displayName: "PRIVATE_AGENT_CANARY",
      visibility: "private",
    });
    const otherOrg = f.bdd.user();
    const foreign = await f.bdd.createAgent(otherOrg, {
      displayName: "FOREIGN_ORG_CANARY",
      visibility: "public",
    });
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [
        {
          id: randomUUID(),
          role: "org:member",
          organization: { id: f.auth.orgId },
        },
      ],
      totalCount: 1,
    });
    const token = f.auth.token();
    let page = await listAgents(token, { limit: 1 });
    const firstCursor = page.nextCursor;
    if (!firstCursor) {
      throw new Error("Expected visible Agents to span multiple pages");
    }
    const agents = [...page.agents];
    while (page.nextCursor !== null) {
      expect(agents.length).toBeLessThan(10);
      page = await listAgents(token, { limit: 1, cursor: page.nextCursor });
      agents.push(...page.agents);
    }
    const ids = agents.map((agent) => {
      return agent.agentId;
    });
    expect(ids).toContain(f.agent.agentId);
    expect(ids).toContain(shared.agentId);
    expect(ids).not.toContain(hidden.agentId);
    expect(ids).not.toContain(foreign.agentId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      agents.find((agent) => {
        return agent.agentId === shared.agentId;
      }),
    ).toMatchObject({ name: "Shared Agent", descriptionTruncated: true });
    expect(JSON.stringify(agents)).not.toContain("CANARY");
    const tampered = `${firstCursor.startsWith("A") ? "B" : "A"}${firstCursor.slice(1)}`;
    for (const args of [
      { limit: 1, cursor: tampered },
      { limit: 2, cursor: firstCursor },
    ]) {
      expect((await callTool(token, "list_agents", args)).isError).toBeTruthy();
    }
    expect(
      (
        await callTool(f.auth.token({ sub: peer.userId }), "list_agents", {
          limit: 1,
          cursor: firstCursor,
        })
      ).isError,
    ).toBeTruthy();
    const longToken = f.auth.token({
      exp: Math.floor((now() + 2 * 24 * 60 * 60 * 1000) / 1000),
    });
    await withMockNowForTest(now() + 24 * 60 * 60 * 1000, async () => {
      expect(
        (
          await callTool(longToken, "list_agents", {
            limit: 1,
            cursor: firstCursor,
          })
        ).isError,
      ).toBeTruthy();
      expect((await listAgents(longToken)).agents.length).toBeGreaterThan(0);
    });
  });

  it("substantially reduces a 20-thread list result", async () => {
    const f = await threadFixture();
    await Promise.all(
      Array.from({ length: 20 }, (_, index) => {
        return f.chat.createThread(f.actor, {
          agentId: f.agent.agentId,
          title: `Payload measurement ${index}`,
        });
      }),
    );
    const result = await callTool(f.auth.token(), "list_chat_threads", {
      limit: 20,
    });
    expectSubstantialCompactSuccess(result);
    expect(
      mcpListChatThreadsOutputSchema.parse(result.structuredContent).threads,
    ).toHaveLength(20);
  });

  it("discovers the projected system default without stored policies", async () => {
    const auth = await fixture();
    const models = await listModels(auth.token());
    expect(models.defaultModel).toStrictEqual({
      model: SEEDED_SYSTEM_DEFAULT_MODEL,
      source: "org_default",
    });
  });

  it("lists connected personal subscription models for the Auto member", async () => {
    const f = await threadFixture();
    // Plan state is infrastructure-owned; Auto admits subscriptions on limited-free.
    await seedOrgMetadata({
      orgId: f.auth.orgId,
      tier: "limited-free-1",
      credits: 0,
    });
    await updateFeatureSwitchesForUser(
      context,
      { userId: f.auth.userId, orgId: f.auth.orgId },
      { [FeatureSwitchKey.OkouDebug]: true },
    );
    createRouteMocks(context).clerk.session(f.auth.userId, f.auth.orgId);
    await accept(
      setupApp({ context, routes: modelPoliciesRoutes })(
        modelPoliciesMainContract,
      ).updateMode({
        headers: { authorization: "Bearer clerk-session" },
        body: { mode: "auto" },
      }),
      [200],
    );
    await createMiscRoutesApi(context).upsertPersonalModelProvider(
      f.actor,
      { type: "claude-code-oauth-token", secret: "sk-ant-oat-mcp-member" },
      [200, 201],
    );
    const models = await listModels(f.auth.token());
    expect(models.models).toContainEqual(
      expect.objectContaining({
        id: "claude-sonnet-5-5",
        name: "Claude Sonnet 5.5",
        selectable: true,
        availability: "available",
      }),
    );
    expect(models.defaultModel).toStrictEqual({
      model: "okou-1.0",
      source: "org_default",
    });
  });

  it("projects built-in DeepSeek route availability in model discovery", async () => {
    const f = await threadFixture();
    const runs = createRunsApi(context);
    // A test-owned mirror of DeepSeek V4 Flash keeps candidate cooldowns
    // isolated from concurrent tests that route the real model.
    const { model, restore } =
      await insertBuiltInModelMirrorFixture("deepseek-v4-flash");
    onTestFinished(restore);
    await runs.grantProEntitlement(f.actor);
    await seedBuiltInModelCandidateKeys(context, model);
    await runs.updateOrgModelPolicies(f.actor, [
      {
        model,
        preferred: true,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);
    const token = f.auth.token();
    expect((await listModels(token)).models).toContainEqual(
      expect.objectContaining({
        id: model,
        availability: "available",
      }),
    );

    // A provider failure cools the eligible OpenRouter candidate down.
    await coolDownBuiltInCandidatesFixture(context, model, [
      {
        provider_type: "openrouter-codex",
        upstream_model: "deepseek/deepseek-v4-flash",
      },
    ]);
    const models = await listModels(token);
    expect(models.models).toContainEqual(
      expect.objectContaining({
        id: model,
        availability: "unavailable",
        reason:
          "The built-in model is temporarily unavailable. Retry later or select another model.",
      }),
    );
  });

  it("keeps a member subscription route selectable after a plan downgrade", async () => {
    const f = await threadFixture();
    const runs = createRunsApi(context);
    const { subscriptionId } = await runs.grantProEntitlement(f.actor);
    await runs.updateOrgModelPolicies(f.actor, [
      {
        model: "gpt-6-luna",
        preferred: true,
        defaultProviderType: "codex-oauth-token",
        credentialScope: "member",
        modelProviderId: null,
      },
    ]);
    const token = f.auth.token({ scope: defaultScopes });
    expect((await listModels(token)).models).toContainEqual(
      expect.objectContaining({
        id: "gpt-6-luna",
        selectable: true,
        availability: "connection_required",
      }),
    );
    await updateFeatureSwitchesForUser(
      context,
      { userId: f.auth.userId, orgId: f.auth.orgId },
      { [FeatureSwitchKey.PersonalModelProviderAccounts]: true },
    );
    await createMiscRoutesApi(context).upsertPersonalModelProvider(
      f.actor,
      {
        type: "codex-oauth-token",
        authMethod: "auth_json",
        secrets: {
          CODEX_AUTH_JSON: makeCodexAuthJson({
            accountId: `account-${randomUUID()}`,
          }),
        },
      },
      [200, 201],
    );
    createRouteMocks(context).clerk.session(f.auth.userId, f.auth.orgId);
    await accept(
      setupApp({ context, routes: userModelPreferenceRoutes })(
        userModelPreferenceContract,
      ).update({
        headers: { authorization: "Bearer clerk-session" },
        body: { selectedModel: "gpt-6-luna", serviceTier: "priority" },
      }),
      [200],
    );
    await createWebhookCallbackApi(context).postStripeEvent(
      {
        id: `evt_${randomUUID()}`,
        type: "customer.subscription.deleted",
        data: { object: { id: subscriptionId, metadata: {} } },
      },
      [200],
    );

    // The member's own connected subscription route is exempt from the free
    // plan restriction, so it stays available and remains the member default.
    const models = await listModels(token);
    expect(models.defaultModel).toStrictEqual({
      model: "gpt-6-luna",
      source: "member_default",
    });
    expect(models.models).toContainEqual(
      expect.objectContaining({
        id: "gpt-6-luna",
        selectable: true,
        availability: "available",
      }),
    );
    const created = await createThread(token, {
      requestId: randomUUID(),
      agentId: f.agent.agentId,
      title: "After plan synchronization",
      model: "gpt-6-luna",
    });
    expect(created.model.selectedModel).toBe("gpt-6-luna");
    expect(
      (await getMessages(token, { threadId: created.threadId })).messages,
    ).toStrictEqual([]);
  });

  it("projects the system default without a stored default policy", async () => {
    const f = await threadFixture();
    const runs = createRunsApi(context);
    await runs.grantProEntitlement(f.actor);
    await runs.updateOrgModelPolicies(f.actor, [
      {
        model: "claude-fable-5-1",
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);
    const token = f.auth.token({ scope: defaultScopes });

    const models = await listModels(token);
    expect(models.defaultModel).toStrictEqual({
      model: SEEDED_SYSTEM_DEFAULT_MODEL,
      source: "org_default",
    });
  });

  it("distinguishes configured models, missing member credentials and the member default", async () => {
    const f = await creationFixture();
    expect((await listModels(f.auth.token())).models).toContainEqual(
      expect.objectContaining({
        id: "claude-sonnet-5",
        selectable: true,
        availability: "plan_restricted",
        reason: expect.any(String),
      }),
    );
    await f.runs.grantProEntitlement(f.actor);
    await f.runs.updateOrgModelPolicies(f.actor, [
      {
        model: "claude-sonnet-5",
        preferred: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: f.providerId,
      },
      {
        model: "gpt-5.6-sol",
        defaultProviderType: "codex-oauth-token",
        credentialScope: "member",
        modelProviderId: null,
      },
    ]);
    const token = f.auth.token();
    const models = await listModels(token);
    expect(models).toMatchObject({
      defaultModel: { model: "claude-sonnet-5", source: "member_default" },
      admission: "checked_on_send",
    });
    expect(models.models).toContainEqual(
      expect.objectContaining({
        id: "claude-sonnet-5",
        selectable: true,
        availability: "available",
      }),
    );
    expect((await listModels(token)).models).toContainEqual(
      expect.objectContaining({
        id: "gpt-5.6-sol",
        selectable: true,
        availability: "connection_required",
      }),
    );
    const visible = JSON.stringify(models);
    expect(visible).not.toContain(f.providerId);
    expect(visible).not.toContain("test-anthropic-key");
    createRouteMocks(context).clerk.session(f.auth.userId, f.auth.orgId);
    await accept(
      setupApp({ context, routes: userModelPreferenceRoutes })(
        userModelPreferenceContract,
      ).update({
        headers: { authorization: "Bearer clerk-session" },
        body: { selectedModel: "gpt-5.6-sol", serviceTier: "priority" },
      }),
      [200],
    );
    await expect(listModels(token)).resolves.toMatchObject({
      defaultModel: { model: "gpt-5.6-sol", source: "member_default" },
    });
    expect((await listAgents(token)).agents).toContainEqual(
      expect.objectContaining({ isDefault: true }),
    );
  });
});

describe("external MCP entry", () => {
  it("filters before pagination and treats title wildcards literally", async () => {
    const f = await threadFixture();
    const first = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
      title: "Launch 100%_DONE first",
    });
    const second = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
      title: "Launch 100%_DONE second",
    });
    await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
      title: "Launch 100XX_DONE wildcard decoy",
    });
    await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
      title: "Most recent unrelated thread",
    });
    const otherAgent = await f.bdd.createAgent(f.actor, {
      displayName: "Other discovery agent",
      visibility: "private",
    });
    await f.chat.createThread(f.actor, {
      agentId: otherAgent.agentId,
      title: "Launch 100%_DONE different Agent",
    });
    const token = f.auth.token();
    const filters = {
      agentId: f.agent.agentId,
      title: "100%_done",
      limit: 1,
    };
    const page = await listThreads(token, filters);
    expect(
      page.threads.map((thread) => {
        return thread.threadId;
      }),
    ).toStrictEqual([second.id]);
    expect(page.nextCursor).not.toBeNull();
    const next = await listThreads(token, {
      ...filters,
      cursor: page.nextCursor,
    });
    expect(
      next.threads.map((thread) => {
        return thread.threadId;
      }),
    ).toStrictEqual([first.id]);
    expect(next.nextCursor).toBeNull();

    const current = await getThread(token, second.id);
    const instant = Date.parse(current.thread.lastMessageAt);
    const windowed = await listThreads(token, {
      ...filters,
      title: "second",
      since: new Date(instant - 1).toISOString(),
      before: new Date(instant + 1).toISOString(),
    });
    expect(
      windowed.threads.map((thread) => {
        return thread.threadId;
      }),
    ).toStrictEqual([second.id]);
    const outside = await listThreads(token, {
      ...filters,
      since: new Date(instant + 1).toISOString(),
    });
    expect(outside.threads).toStrictEqual([]);
  });

  it("reads empty threads and current metadata without changing read, pin or lifecycle state", async () => {
    const f = await threadFixture();
    const created = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
      title: "Original discovery title",
    });
    await f.chat.pinThread(f.actor, created.id);
    const before = {
      metadata: await f.chat.readThreadMetadata(f.actor, created.id),
      detail: await f.chat.readThread(f.actor, created.id),
      events: (await f.chat.requestThreadEvents(f.actor, {}, [200])).body,
      draft: await f.chat.readThreadDraft(f.actor, created.id),
    };
    const token = f.auth.token();
    const detail = await getThread(token, created.id);
    expect(detail.thread).toMatchObject({
      threadId: created.id,
      title: "Original discovery title",
      titleTruncated: false,
      agent: { agentId: f.agent.agentId, name: "MCP discovery agent" },
      model: {
        selectedModel: before.metadata.selectedModel,
        effectiveModel: before.metadata.selectedModel,
        source: "thread",
        admission: "checked_on_send",
      },
    });
    expect(new URL(detail.thread.url).pathname).toBe(`/chats/${created.id}`);
    expect((await listThreads(token)).threads).toStrictEqual([detail.thread]);
    await expect(getThread(token, created.id)).resolves.toStrictEqual(detail);
    expect({
      metadata: await f.chat.readThreadMetadata(f.actor, created.id),
      detail: await f.chat.readThread(f.actor, created.id),
      events: (await f.chat.requestThreadEvents(f.actor, {}, [200])).body,
      draft: await f.chat.readThreadDraft(f.actor, created.id),
    }).toStrictEqual(before);

    await f.chat.renameThread(f.actor, created.id, "Renamed discovery title");
    expect(
      (await listThreads(token, { title: "Original discovery title" })).threads,
    ).toStrictEqual([]);
    expect((await getThread(token, created.id)).thread.title).toBe(
      "Renamed discovery title",
    );
    await f.chat.deleteThread(f.actor, created.id);
    expect((await listThreads(token)).threads).toStrictEqual([]);
    const deleted = await callTool(token, "get_chat_thread", {
      threadId: created.id,
    });
    const missing = await callTool(token, "get_chat_thread", {
      threadId: randomUUID(),
    });
    expect(deleted.isError).toBeTruthy();
    expect(deleted).toStrictEqual(missing);
  });

  it("reflects a changed model pin and resolves a cleared pin without rewriting it", async () => {
    const f = await threadFixture();
    const runs = createRunsApi(context);
    const { providerId } = await runs.ensureOrgModelProvider(f.actor);
    await runs.updateOrgModelPolicies(
      f.actor,
      (["claude-sonnet-5", "claude-opus-5"] as const).map((model) => {
        return {
          model,
          preferred: model === "claude-sonnet-5",
          defaultProviderType: "anthropic-api-key",
          credentialScope: "org",
          modelProviderId: providerId,
        };
      }),
    );
    const created = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
      title: "Current model",
      model: "claude-sonnet-5",
    });
    const token = f.auth.token();
    await f.chat.updateThreadModelSelection(
      f.actor,
      created.id,
      "claude-opus-5",
    );
    expect((await getThread(token, created.id)).thread.model).toStrictEqual({
      selectedModel: "claude-opus-5",
      effectiveModel: "claude-opus-5",
      source: "thread",
      admission: "checked_on_send",
    });
    await f.chat.updateThreadModelSelection(f.actor, created.id, null);
    const before = await f.chat.readThreadMetadata(f.actor, created.id);
    const model = (await getThread(token, created.id)).thread.model;
    expect(model).toMatchObject({
      selectedModel: null,
      effectiveModel: SEEDED_SYSTEM_DEFAULT_MODEL,
      admission: "checked_on_send",
    });
    expect(model.source).toBe("org_default");
    await expect(
      f.chat.readThreadMetadata(f.actor, created.id),
    ).resolves.toStrictEqual(before);
  });

  it("rejects tampered, changed-filter and expired cursors with a fresh-traversal path", async () => {
    const f = await threadFixture();
    for (const title of ["Cursor first", "Cursor second", "Cursor third"]) {
      await f.chat.createThread(f.actor, { agentId: f.agent.agentId, title });
    }
    const filters = { title: "Cursor", limit: 1 };
    const first = await listThreads(f.auth.token(), filters);
    if (!first.nextCursor) {
      throw new Error("Expected a continuation cursor");
    }
    const cursor = first.nextCursor;
    const tampered = `${cursor.startsWith("A") ? "B" : "A"}${cursor.slice(1)}`;
    for (const args of [
      { ...filters, cursor: tampered },
      { ...filters, cursor, title: "different" },
      { ...filters, cursor, agentId: randomUUID() },
    ]) {
      const result = await callTool(f.auth.token(), "list_chat_threads", args);
      expect(result.isError).toBeTruthy();
      structuredToolError(result);
    }
    const second = await listThreads(f.auth.token(), { ...filters, cursor });
    const ids = [...first.threads, ...second.threads].map((thread) => {
      return thread.threadId;
    });
    expect(new Set(ids).size).toBe(2);
    const expiryToken = f.auth.token({
      exp: Math.floor((now() + 2 * 24 * 60 * 60 * 1000) / 1000),
    });
    await withMockNowForTest(now() + 24 * 60 * 60 * 1000, async () => {
      const expired = await callTool(expiryToken, "list_chat_threads", {
        ...filters,
        cursor,
      });
      expect(expired.isError).toBeTruthy();
      expect((await listThreads(expiryToken, filters)).threads).toHaveLength(1);
    });
  });

  it("never discloses a peer's or another organization's thread through list or detail", async () => {
    const f = await threadFixture();
    const own = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
      title: "Owned thread",
    });
    const ownSecond = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
      title: "Owned second thread",
    });
    const strangers = [
      f.bdd.user({ orgId: f.auth.orgId }),
      f.bdd.user({ userId: f.auth.userId }),
    ];
    const token = f.auth.token();
    const first = await listThreads(token, { limit: 1 });
    expect(first.nextCursor).not.toBeNull();
    const missing = await callTool(token, "get_chat_thread", {
      threadId: randomUUID(),
    });
    for (const actor of strangers) {
      const agent = await f.bdd.createAgent(actor, {
        displayName: "Hidden Agent",
        visibility: "private",
      });
      const thread = await f.chat.createThread(actor, {
        agentId: agent.agentId,
        title: "Hidden thread",
      });
      await expect(
        callTool(token, "get_chat_thread", { threadId: thread.id }),
      ).resolves.toStrictEqual(missing);
      expect(
        (await listThreads(token, { agentId: agent.agentId })).threads,
      ).toStrictEqual([]);
      if (!actor.orgId) {
        throw new Error("Expected an organization for a peer fixture");
      }
      context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue(
        {
          data: [f.auth.orgId, actor.orgId].map((orgId) => {
            return {
              id: randomUUID(),
              role: "org:member",
              organization: { id: orgId },
            };
          }),
          totalCount: 2,
        },
      );
      const foreignCursor = await callTool(
        f.auth.token({ sub: actor.userId, org_id: actor.orgId }),
        "list_chat_threads",
        { limit: 1, cursor: first.nextCursor },
      );
      expect(foreignCursor.isError).toBeTruthy();
    }
    expect(missing.isError).toBeTruthy();
    expect(
      (await listThreads(token)).threads.map((thread) => {
        return thread.threadId;
      }),
    ).toStrictEqual([ownSecond.id, own.id]);
  });

  it("bounds Unicode titles and preserves an allowed Unicode Agent name", async () => {
    const f = await threadFixture();
    const longName = "😀".repeat(256);
    const longTitle = "🚀".repeat(700);
    const agent = await f.bdd.createAgent(f.actor, {
      displayName: longName,
      visibility: "private",
    });
    const created = await f.chat.createThread(f.actor, {
      agentId: agent.agentId,
      title: longTitle,
    });
    const detail = await getThread(f.auth.token(), created.id);
    expect(detail.thread.titleTruncated).toBeTruthy();
    expect(detail.thread.agent.name).toBe(longName);
    expect(detail.thread.title?.length).toBeLessThanOrEqual(1000);
    expect(detail.thread.agent.name).toHaveLength(512);
    expect(detail.thread.title?.endsWith("🚀")).toBeTruthy();
    expect(detail.thread.agent.name.endsWith("😀")).toBeTruthy();
  });

  it("shares the App's active and unread indicators without changing read state", async () => {
    const f = await chatRunFixture();
    const { runId, threadId } = await createChatEventsFixture(
      context,
    ).sendChatRun(f.actor, {
      agentId: f.agent.agentId,
      prompt: "Track shared indicators",
    });
    await flushWaitUntilForTest();
    const active = await getIndicators(f.auth.token());
    expect(active).toStrictEqual(await f.chat.listIndicators(f.actor));
    expect(active.agents[f.agent.agentId]).toBe("active");
    expect(active.threads[threadId]).toBe("active");
    expect(active.unreadAt).toStrictEqual({});

    const retainedToken = f.auth.token({
      exp: Math.floor((now() + 9 * 24 * 60 * 60 * 1000) / 1000),
    });
    await withMockNowForTest(now() + 8 * 24 * 60 * 60 * 1000, async () => {
      const oldActive = await getIndicators(retainedToken);
      expect(oldActive).toStrictEqual(await f.chat.listIndicators(f.actor));
      expect(oldActive.threads[threadId]).toBe("active");
    });

    await f.runs.requestCancelRun(f.actor, runId, [200]);
    await flushWaitUntilForTest();
    await flushWaitUntilForTest();
    await expect(
      (async () => {
        return (await f.chat.listThreadEvents(f.actor, threadId)).events.some(
          (event) => {
            return event.eventType === "run.cancelled" && event.runId === runId;
          },
        );
      })(),
    ).resolves.toBeTruthy();
    await f.chat.markThreadUnread(f.actor, threadId);
    const before = await f.chat.readThread(f.actor, threadId);
    const unread = await getIndicators(f.auth.token());
    expect(unread).toStrictEqual(await f.chat.listIndicators(f.actor));
    expect(unread.agents[f.agent.agentId]).toBe("unread");
    expect(unread.threads[threadId]).toBe("unread");
    expect(unread.unreadAt[threadId]).toStrictEqual(expect.any(String));
    await expect(f.chat.readThread(f.actor, threadId)).resolves.toStrictEqual(
      before,
    );

    await withMockNowForTest(now() + 8 * 24 * 60 * 60 * 1000, async () => {
      const oldUnread = await getIndicators(retainedToken);
      expect(oldUnread).toStrictEqual(await f.chat.listIndicators(f.actor));
      expect(oldUnread).toStrictEqual({
        agents: {},
        threads: {},
        unreadAt: {},
      });
    });
    await f.chat.markThreadRead(f.actor, threadId);
    await expect(getIndicators(f.auth.token())).resolves.toStrictEqual({
      agents: {},
      threads: {},
      unreadAt: {},
    });
  });

  it("continues pagination through intervening rename and deletion", async () => {
    const f = await threadFixture();
    const threads: { id: string }[] = [];
    for (const title of ["Page first", "Page second", "Page third"]) {
      const thread = await f.chat.createThread(f.actor, {
        agentId: f.agent.agentId,
        title,
      });
      threads.push(thread);
    }
    const token = f.auth.token();
    const expected = threads
      .map((thread) => {
        return thread.id;
      })
      .reverse();
    const first = await listThreads(token, {
      agentId: f.agent.agentId,
      limit: 1,
    });
    expect(
      first.threads.map((thread) => {
        return thread.threadId;
      }),
    ).toStrictEqual(expected.slice(0, 1));
    const renamedId = expected[1];
    const deletedId = expected[2];
    if (!first.nextCursor || !renamedId || !deletedId) {
      throw new Error("Expected three threads and a continuation cursor");
    }
    await f.chat.renameThread(f.actor, renamedId, "Renamed between pages");
    await f.chat.deleteThread(f.actor, deletedId);
    const next = await listThreads(token, {
      agentId: f.agent.agentId,
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(
      next.threads.map((thread) => {
        return thread.threadId;
      }),
    ).toStrictEqual([renamedId]);
    expect(next.threads[0]?.title).toBe("Renamed between pages");
    expect(next.nextCursor).toBeNull();
    const fresh = await listThreads(token, { agentId: f.agent.agentId });
    expect(
      fresh.threads.map((thread) => {
        return thread.threadId;
      }),
    ).toStrictEqual(expected.slice(0, 2));
  });

  it("accepts a nonempty timestamp range smaller than one millisecond", async () => {
    const auth = await fixture();
    const page = await listThreads(auth.token(), {
      since: "2026-09-18T00:00:00.000001Z",
      before: "2026-09-18T00:00:00.000002Z",
    });
    expect(page.threads).toStrictEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it.each([
    { limit: 0 },
    { limit: 51 },
    { title: " \n\t " },
    { since: "2026-09-18T00:00:00Z", before: "2026-09-17T00:00:00Z" },
    { cursor: "x".repeat(4097) },
  ])("rejects invalid list arguments %j", async (args) => {
    const auth = await fixture();
    expect(
      structuredToolError(
        await callTool(auth.token(), "list_chat_threads", args),
      ),
    ).toMatchObject({ code: "invalid_arguments", retryable: false });
  });

  it("returns active indicators isolated to each signed organization", async () => {
    const auth = await fixture();
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    const callbacks = createChatCallbacksApi(context);
    runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    callbacks.acceptChatObjectStorage();
    callbacks.disableVapid();
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    const actors = [
      bdd.user({ userId: auth.userId, orgId: auth.orgId }),
      bdd.user({ userId: auth.userId, orgId: `org_${randomUUID()}` }),
    ];
    const expected: { threadId: string; agentId: string }[] = [];
    for (const actor of actors) {
      await runs.grantProEntitlement(actor);
      await runs.ensureOrgModelProvider(actor, { model: NATIVE_RUNNER_MODEL });
      const agent = await bdd.createAgent(actor, {
        displayName: "MCP organization activity",
        visibility: "private",
      });
      const sent = await createChatEventsFixture(context).sendChatRun(actor, {
        agentId: agent.agentId,
        prompt: "Check organization activity",
      });
      expected.push({ threadId: sent.threadId, agentId: agent.agentId });
    }
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: actors.map((actor) => {
        return {
          id: randomUUID(),
          role: "org:member",
          organization: { id: actor.orgId },
        };
      }),
      totalCount: 2,
    });
    const results = await Promise.all(
      actors.map((actor) => {
        return accept(
          client().request({
            extraHeaders: protocolHeaders(
              auth.token({ org_id: actor.orgId }),
              "tools/call",
              true,
              "get_chat_indicators",
            ),
            body: requestBody("tools/call", true, {
              name: "get_chat_indicators",
              arguments: {},
            }),
          }),
          [200],
        );
      }),
    );
    expect(
      results.map((result) => {
        const output = z
          .object({ result: z.object({ structuredContent: z.unknown() }) })
          .parse(rpc(result.body)).result.structuredContent;
        const indicators = mcpGetChatIndicatorsOutputSchema.parse(output);
        expect(Object.values(indicators.threads)).toStrictEqual(["active"]);
        expect(Object.values(indicators.agents)).toStrictEqual(["active"]);
        expect(indicators.unreadAt).toStrictEqual({});
        const threadId = Object.keys(indicators.threads)[0];
        const agentId = Object.keys(indicators.agents)[0];
        if (!threadId || !agentId) {
          throw new Error("Expected one owned active thread and Agent");
        }
        return { threadId, agentId };
      }),
    ).toStrictEqual(expected);
  });
});
