import { randomUUID } from "node:crypto";
import {
  mcpCreateChatThreadOutputSchema,
  mcpCreateChatWithMessageOutputSchema,
} from "@okouai/api-contracts/contracts/mcp-chat-creation";
import { v5 as uuidv5 } from "uuid";
import { describe, expect, it, onTestFinished } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { withMockNowForTest } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { setOrgDefaultAgentFixture } from "../../../test-fixtures/org-metadata";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { deleteFeatureSwitchesForUser } from "./helpers/feature-switches";
import { deleteDiscordFixture } from "./helpers/discord";
import {
  discordChatThreads,
  discordMessageForTest,
  mockDiscordProvider,
  postDiscordMessage,
  setupConnectedDiscordActor,
} from "./helpers/discord-fixture";
import { SEEDED_SYSTEM_DEFAULT_MODEL } from "./helpers/seeded-system-default";
import {
  requiredScopes,
  defaultScopes,
  expectSubstantialCompactSuccess,
  createMcpServerTestApi,
} from "./helpers/mcp-server";
import {
  createMcpServerFixtures,
  NATIVE_RUNNER_MODEL,
} from "./helpers/mcp-server-fixtures";

const context = testContext();
const {
  fixture,
  callTool,
  structuredToolError,
  listThreads,
  getThread,
  getMessages,
  getStatus,
  createThread,
  updateThread,
  sendMessage,
  waitForInputRunId,
} = createMcpServerTestApi(context);
const { creationFixture, threadFixture } = createMcpServerFixtures(context);

const mcpCreationNamespace = "107f0e3c-b577-40c5-b2e8-0ebdcce13242";

function mcpCreationEventId(input: {
  readonly requestId: string;
  readonly agentId?: string;
  readonly title?: string;
  readonly model?: string;
  readonly message?: string;
}): string {
  const optionalIdentity = (value: string | undefined) => {
    return value === undefined ? ["omitted"] : ["present", value];
  };
  return uuidv5(
    JSON.stringify([
      "create_chat_thread",
      input.requestId,
      optionalIdentity(input.agentId),
      optionalIdentity(input.title),
      optionalIdentity(input.model),
      "message" in input ? ["present", input.message] : ["omitted"],
    ]),
    mcpCreationNamespace,
  );
}

describe("MCP chat discovery and creation", () => {
  it("creates an empty conversation using an explicit model and returns a send handoff", async () => {
    const f = await creationFixture();
    const requestId = randomUUID();
    const token = f.auth.token({ scope: defaultScopes });
    const createdResult = await callTool(
      f.auth.token({ scope: `${requiredScopes} okou:chat:manage` }),
      "create_chat_thread",
      {
        requestId: requestId.toUpperCase(),
        agentId: f.agent.agentId.toUpperCase(),
        title: "Review the quarterly plan",
        model: "claude-opus-5",
      },
    );
    expectSubstantialCompactSuccess(createdResult);
    const created = mcpCreateChatThreadOutputSchema.parse(
      createdResult.structuredContent,
    );
    expect(created).toMatchObject({
      threadId: requestId,
      agentId: f.agent.agentId,
      title: "Review the quarterly plan",
      titleTruncated: false,
      model: {
        selectedModel: "claude-opus-5",
        effectiveModel: "claude-opus-5",
        source: "thread",
        admission: "checked_on_send",
      },
      replayed: false,
      nextAction: {
        tool: "send_chat_message",
        arguments: { threadId: requestId },
      },
    });
    expect(Date.parse(created.retryUntil) - Date.parse(created.createdAt)).toBe(
      24 * 60 * 60 * 1000,
    );
    expect(new URL(created.url).pathname).toBe(`/chats/${requestId}`);
    await expect(
      getStatus(token, { threadId: requestId }),
    ).resolves.toMatchObject({
      lifecycle: { phase: "idle", outcome: null, output: "none" },
      messages: null,
    });
    expect(
      (await getMessages(token, { threadId: requestId })).messages,
    ).toStrictEqual([]);
    const sent = await sendMessage(token, {
      ...created.nextAction.arguments,
      requestId: randomUUID(),
      text: "This first message contains its own context.",
    });
    expect(sent.inputRef.threadId).toBe(requestId);
  });

  it("creates an untitled empty conversation using Agent and model defaults", async () => {
    const f = await creationFixture({ withDefaultAgent: true });
    const token = f.auth.token({ scope: defaultScopes });
    const args = { requestId: randomUUID() };

    await expect(createThread(token, args)).resolves.toMatchObject({
      threadId: args.requestId,
      agentId: f.defaultAgentId,
      title: null,
      model: {
        selectedModel: "claude-sonnet-5",
        effectiveModel: "claude-sonnet-5",
        source: "thread",
        admission: "checked_on_send",
      },
      replayed: false,
      nextAction: {
        tool: "send_chat_message",
        arguments: { threadId: args.requestId },
      },
    });
    await expect(createThread(token, args)).resolves.toMatchObject({
      threadId: args.requestId,
      agentId: f.defaultAgentId,
      title: null,
      replayed: true,
    });
  });

  it("atomically creates a conversation with its first message and resolves defaults", async () => {
    const f = await creationFixture({ withDefaultAgent: true });
    f.runs.configureRunnerGroup();
    f.runs.acceptStorageDownloads();
    const token = f.auth.token({ scope: defaultScopes });
    const args = {
      requestId: randomUUID(),
      message: "  Preserve this exact first message. 中文 😀  ",
    };
    const created = await createThread(token, args);
    expect(created).toMatchObject({
      threadId: args.requestId,
      agentId: f.defaultAgentId,
      title: null,
      model: {
        selectedModel: "claude-sonnet-5",
        effectiveModel: "claude-sonnet-5",
        source: "thread",
        admission: "checked_on_send",
      },
      replayed: false,
      input: {
        inputRef: { threadId: args.requestId, eventId: expect.any(String) },
      },
      nextAction: {
        tool: "get_chat_status",
        arguments: {
          inputRef: expect.objectContaining({ threadId: args.requestId }),
        },
      },
    });
    const combined = mcpCreateChatWithMessageOutputSchema.parse(created);
    expect(combined.nextAction.arguments.inputRef).toStrictEqual(
      combined.input.inputRef,
    );
    // The message is only enqueued; its run starts in a background pick.
    expect(["queued", "associated"]).toContain(combined.input.disposition);
    const runId = await waitForInputRunId(
      token,
      combined.nextAction.arguments.inputRef,
    );
    const status = await getStatus(token, combined.nextAction.arguments);
    expect(status).toMatchObject({
      threadId: args.requestId,
      messages: {
        arguments: {
          threadId: args.requestId,
          runId,
          limit: 20,
        },
      },
    });
    expect(
      Date.parse(combined.input.retryUntil) -
        Date.parse(combined.input.acceptedAt),
    ).toBe(24 * 60 * 60 * 1000);
    expect(
      (await getMessages(token, { threadId: args.requestId })).messages,
    ).toMatchObject([{ text: args.message }]);
    const original = (
      await f.chat.listThreadEvents(f.actor, args.requestId)
    ).events.find((event) => {
      return (
        event.id === combined.input.inputRef.eventId &&
        event.eventType === "input.prompt"
      );
    });
    if (original?.eventType !== "input.prompt") {
      throw new Error("Expected the combined input event");
    }
    expect(original.userMessage).toStrictEqual({
      version: 1,
      parts: [
        { type: "text", text: args.message },
        { type: "source", kind: "mcp", clientId: "mcp_test_client" },
      ],
    });

    await f.runs.updateOrgModelPolicies(f.actor, [
      {
        model: "claude-sonnet-5",
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: f.providerId,
      },
      {
        model: "claude-opus-5",
        preferred: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: f.providerId,
      },
    ]);

    const replay = await createThread(token, args);
    expect(replay).toMatchObject({
      threadId: args.requestId,
      agentId: f.defaultAgentId,
      model: {
        selectedModel: "claude-sonnet-5",
        effectiveModel: "claude-sonnet-5",
        source: "thread",
      },
      replayed: true,
      input: {
        inputRef: combined.input.inputRef,
        acceptedAt: combined.input.acceptedAt,
        disposition: "associated",
        runId,
      },
    });
    expect(
      (await getMessages(token, { threadId: args.requestId })).messages,
    ).toHaveLength(1);
    const after = (
      await f.chat.listThreadEvents(f.actor, args.requestId)
    ).events.find((event) => {
      return (
        event.id === combined.input.inputRef.eventId &&
        event.eventType === "input.prompt"
      );
    });
    if (after?.eventType !== "input.prompt") {
      throw new Error("Expected the replayed combined input event");
    }
    expect(after.userMessage).toStrictEqual(original.userMessage);
    const differentClient = f.auth.token({
      client_id: "different_combined_client",
      scope: defaultScopes,
    });
    await expect(createThread(differentClient, args)).resolves.toMatchObject({
      threadId: args.requestId,
      replayed: true,
      input: { inputRef: combined.input.inputRef },
    });
    const unchanged = (
      await f.chat.listThreadEvents(f.actor, args.requestId)
    ).events.find((event) => {
      return event.id === combined.input.inputRef.eventId;
    });
    if (unchanged?.eventType !== "input.prompt") {
      throw new Error("Expected the original combined input event");
    }
    expect(unchanged.userMessage).toStrictEqual(original.userMessage);
  });

  it("conflicts on changed intent or mode for a combined creation request", async () => {
    const f = await creationFixture();
    const token = f.auth.token({ scope: defaultScopes });
    const args = {
      requestId: randomUUID(),
      agentId: f.agent.agentId,
      title: "One combined operation",
      model: "claude-sonnet-5",
      message: "Create and submit exactly once",
    };
    await createThread(token, args);

    const secondAgent = await f.bdd.createAgent(f.actor, {
      displayName: "Another combined creation Agent",
      visibility: "private",
    });
    for (const conflicting of [
      { ...args, title: "Changed title" },
      { ...args, title: undefined },
      { ...args, message: "Changed message" },
      { ...args, agentId: secondAgent.agentId },
      { ...args, agentId: undefined },
      { ...args, model: "claude-opus-5" },
      { ...args, model: undefined },
      {
        requestId: args.requestId,
        agentId: args.agentId,
        title: args.title,
        model: args.model,
      },
    ]) {
      expect(
        structuredToolError(
          await callTool(token, "create_chat_thread", conflicting),
        ),
      ).toMatchObject({ code: "request_id_conflict", retryable: false });
    }

    const emptyRequestId = randomUUID();
    const empty = {
      requestId: emptyRequestId,
      agentId: f.agent.agentId,
      title: "Empty mode stays empty",
      model: "claude-sonnet-5",
    };
    await createThread(token, empty);
    expect(
      structuredToolError(
        await callTool(token, "create_chat_thread", {
          ...empty,
          message: "Changing to combined mode must conflict",
        }),
      ),
    ).toMatchObject({ code: "request_id_conflict", retryable: false });
  });

  it("requires send scope only for the message branch", async () => {
    const f = await creationFixture();
    const token = f.auth.token({
      scope: `${requiredScopes} okou:chat:manage`,
    });
    const empty = await createThread(token, {
      requestId: randomUUID(),
      agentId: f.agent.agentId,
      title: "Manage-only empty conversation",
      model: "claude-sonnet-5",
    });
    expect(empty.nextAction.tool).toBe("send_chat_message");

    const combinedId = randomUUID();
    expect(
      structuredToolError(
        await callTool(token, "create_chat_thread", {
          requestId: combinedId,
          title: "Must not be created",
          message: "Send scope is required",
        }),
      ),
    ).toMatchObject({ code: "insufficient_scope", retryable: false });
    expect(
      (await listThreads(f.auth.token({ scope: defaultScopes }))).threads.map(
        (thread) => {
          return thread.threadId;
        },
      ),
    ).not.toContain(combinedId);
  });

  it("deduplicates simultaneous creation and replays current mutable settings without overwriting them", async () => {
    const f = await creationFixture();
    const args = {
      requestId: randomUUID(),
      agentId: f.agent.agentId,
      title: "Original title",
      model: "claude-sonnet-5",
    };
    const token = f.auth.token({ scope: defaultScopes });
    const results = await Promise.all([
      createThread(token, args),
      createThread(token, args),
    ]);
    expect(
      results
        .map((result) => {
          return result.replayed;
        })
        .sort(),
    ).toStrictEqual([false, true]);
    expect(results[0]?.threadId).toBe(args.requestId);
    expect(results[1]?.threadId).toBe(args.requestId);
    expect((await listThreads(token)).threads).toHaveLength(1);
    await f.chat.renameThread(
      f.actor,
      args.requestId,
      "Renamed after creation",
    );
    await f.chat.updateThreadModelSelection(
      f.actor,
      args.requestId,
      "claude-opus-5",
    );
    const before = await f.chat.readThreadMetadata(f.actor, args.requestId);
    await expect(createThread(token, args)).resolves.toMatchObject({
      threadId: args.requestId,
      replayed: true,
      title: "Renamed after creation",
      model: {
        selectedModel: "claude-opus-5",
        effectiveModel: "claude-opus-5",
      },
    });
    await expect(
      f.chat.readThreadMetadata(f.actor, args.requestId),
    ).resolves.toStrictEqual(before);
    for (const conflicting of [
      { ...args, title: "Different intent" },
      { ...args, title: undefined },
      { ...args, agentId: undefined },
      { ...args, model: "claude-opus-5" },
      { ...args, model: undefined },
    ]) {
      const result = await callTool(token, "create_chat_thread", conflicting);
      expect(structuredToolError(result)).toMatchObject({
        code: "request_id_conflict",
        retryable: false,
      });
    }
    await expect(
      f.chat.readThreadMetadata(f.actor, args.requestId),
    ).resolves.toStrictEqual(before);
    expect((await listThreads(token)).threads).toHaveLength(1);
  });

  it("atomically updates sparse metadata and replays without reverting newer state", async () => {
    const f = await creationFixture();
    const token = f.auth.token({ scope: defaultScopes });
    const created = await createThread(token, {
      requestId: randomUUID(),
      agentId: f.agent.agentId,
      title: "Original metadata",
      model: "claude-sonnet-5",
    });
    const firstId = randomUUID();
    const first = await updateThread(token, {
      requestId: firstId,
      threadId: created.threadId,
      patch: { title: "Manual MCP title" },
    });
    expect(first).toMatchObject({
      requestId: firstId,
      threadId: created.threadId,
      title: "Manual MCP title",
      titleTruncated: false,
      model: {
        selectedModel: "claude-sonnet-5",
        effectiveModel: "claude-sonnet-5",
        source: "thread",
      },
      replayed: false,
    });
    expect(Date.parse(first.retryUntil) - Date.parse(first.acceptedAt)).toBe(
      24 * 60 * 60 * 1000,
    );

    const second = await updateThread(token, {
      requestId: randomUUID(),
      threadId: created.threadId,
      patch: {
        title: "Newer combined state",
        model: "claude-opus-5",
      },
    });
    expect(second).toMatchObject({
      title: "Newer combined state",
      model: {
        selectedModel: "claude-opus-5",
        effectiveModel: "claude-opus-5",
      },
      replayed: false,
    });

    await expect(
      updateThread(token, {
        requestId: firstId,
        threadId: created.threadId,
        patch: { title: "Manual MCP title" },
      }),
    ).resolves.toMatchObject({
      acceptedAt: first.acceptedAt,
      title: "Newer combined state",
      model: { selectedModel: "claude-opus-5" },
      replayed: true,
    });
    expect(
      (
        await callTool(token, "update_chat_thread", {
          requestId: firstId,
          threadId: created.threadId,
          patch: { title: "Conflicting reuse" },
        })
      ).isError,
    ).toBeTruthy();

    const cleared = await updateThread(token, {
      requestId: randomUUID(),
      threadId: created.threadId,
      patch: { model: null },
    });
    expect(cleared).toMatchObject({
      title: "Newer combined state",
      model: {
        selectedModel: null,
        effectiveModel: SEEDED_SYSTEM_DEFAULT_MODEL,
        source: "org_default",
      },
    });
    await expect(getThread(token, created.threadId)).resolves.toMatchObject({
      thread: {
        title: "Newer combined state",
        model: {
          selectedModel: null,
          effectiveModel: SEEDED_SYSTEM_DEFAULT_MODEL,
        },
      },
    });
  });

  it("replays accepted metadata after an integration thread moves to a new default agent", async () => {
    const auth = fixture();
    const actor = await setupConnectedDiscordActor(context, auth);
    const provider = mockDiscordProvider(actor);
    const chat = createChatFilesBddApi(context);
    const runs = createRunsApi(context);
    onTestFinished(async () => {
      await flushWaitUntilForTest();
      await deleteDiscordFixture(context, actor.fixture);
      await deleteFeatureSwitchesForUser(context, actor);
    });
    const firstMessage = discordMessageForTest(actor, {
      channelId: provider.dmChannelId,
      guild: false,
      content: "start the main DM before the default agent changes",
    });
    provider.messages.set(firstMessage.id, firstMessage);
    await postDiscordMessage(context, firstMessage);
    await flushWaitUntilForTest();
    const [thread] = await discordChatThreads(context, actor);
    if (!thread) {
      throw new Error("Expected the main Discord DM thread");
    }
    const token = auth.token({ scope: defaultScopes });
    const args = {
      requestId: randomUUID(),
      threadId: thread.id,
      patch: { title: "Accepted MCP title", model: NATIVE_RUNNER_MODEL },
    };
    const accepted = await updateThread(token, args);
    const firstRunId = (await getStatus(token, { threadId: thread.id }))
      .messages?.arguments.runId;
    if (!firstRunId) {
      throw new Error("Expected the original DM run");
    }
    await runs.requestCancelRun(actor.actor, firstRunId, [200]);
    await flushWaitUntilForTest();

    const replacement = await createBddApi(context).createAgent(actor.actor, {
      displayName: "Replacement default for MCP replay",
      visibility: "public",
    });
    // Default reassignment has no public API; admission and metadata replay
    // use their real entry points after this historical-state transition.
    await setOrgDefaultAgentFixture({
      orgId: actor.orgId,
      agentId: replacement.agentId,
    });
    const nextMessage = discordMessageForTest(actor, {
      channelId: provider.dmChannelId,
      guild: false,
      content: "continue the existing DM with the current default agent",
    });
    provider.messages.set(nextMessage.id, nextMessage);
    await postDiscordMessage(context, nextMessage);
    await flushWaitUntilForTest();
    await expect(discordChatThreads(context, actor)).resolves.toMatchObject([
      { id: thread.id, agentId: replacement.agentId },
    ]);
    await chat.renameThread(actor.actor, thread.id, "Newer web title");
    const before = await chat.requestThreadEvents(actor.actor, {}, [200]);

    await expect(updateThread(token, args)).resolves.toMatchObject({
      acceptedAt: accepted.acceptedAt,
      retryUntil: accepted.retryUntil,
      title: "Newer web title",
      replayed: true,
    });
    expect(
      structuredToolError(
        await callTool(token, "update_chat_thread", {
          ...args,
          patch: { ...args.patch, title: "Conflicting retry" },
        }),
      ),
    ).toMatchObject({ code: "request_id_conflict", retryable: false });
    await expect(
      chat.requestThreadEvents(actor.actor, {}, [200]),
    ).resolves.toMatchObject({ body: before.body });
    const nextRunId = (await getStatus(token, { threadId: thread.id })).messages
      ?.arguments.runId;
    if (!nextRunId) {
      throw new Error("Expected the rebound DM run");
    }
    await runs.requestCancelRun(actor.actor, nextRunId, [200]);
  });

  it("preserves Fast, reasoning and browser settings", async () => {
    const f = await threadFixture();
    const model = "gpt-6-luna";
    await createRunsApi(context).updateOrgModelPolicies(f.actor, [
      {
        model,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);
    const created = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
      title: "Preserve settings",
      model,
    });
    await f.chat.updateThreadModelSelection(f.actor, created.id, model, {
      reasoningEffort: "high",
      codexServiceTier: "fast",
    });
    const before = await f.chat.readThreadMetadata(f.actor, created.id);
    expect(before).toMatchObject({
      modelSettings: { [model]: { effort: "high" } },
      serviceTier: "priority",
    });

    await updateThread(f.auth.token({ scope: defaultScopes }), {
      requestId: randomUUID(),
      threadId: created.id,
      patch: { title: "Still preserved", model },
    });

    await expect(
      f.chat.readThreadMetadata(f.actor, created.id),
    ).resolves.toMatchObject({
      modelSettings: before.modelSettings,
      serviceTier: before.serviceTier,
      computerUseHostId: before.computerUseHostId,
      cloudBrowserEnabled: before.cloudBrowserEnabled,
    });
  });

  it("rejects update replay after its 24-hour window without reapplying intent", async () => {
    const f = await creationFixture();
    const currentToken = f.auth.token({ scope: defaultScopes });
    const created = await createThread(currentToken, {
      requestId: randomUUID(),
      agentId: f.agent.agentId,
      title: "Before expiry",
      model: "claude-sonnet-5",
    });
    const requestId = randomUUID();
    const first = await updateThread(currentToken, {
      requestId,
      threadId: created.threadId,
      patch: { title: "Accepted title" },
    });
    await updateThread(currentToken, {
      requestId: randomUUID(),
      threadId: created.threadId,
      patch: { title: "Later title" },
    });
    const futureToken = f.auth.token({
      scope: defaultScopes,
      exp: Math.floor((Date.parse(first.retryUntil) + 60_000) / 1000),
    });

    await withMockNowForTest(Date.parse(first.retryUntil) + 1, async () => {
      const replay = await callTool(futureToken, "update_chat_thread", {
        requestId,
        threadId: created.threadId,
        patch: { title: "Accepted title" },
      });
      expect(replay.isError).toBeTruthy();
      structuredToolError(replay);
    });
    await expect(
      getThread(currentToken, created.threadId),
    ).resolves.toMatchObject({ thread: { title: "Later title" } });
  });

  it("validates thread update patches before changing metadata", async () => {
    const f = await creationFixture();
    const token = f.auth.token({ scope: defaultScopes });
    const created = await createThread(token, {
      requestId: randomUUID(),
      agentId: f.agent.agentId,
      title: "Unchanged metadata",
      model: "claude-sonnet-5",
    });
    const eventsResponse = await f.chat.requestThreadEvents(f.actor, {}, [200]);
    if (eventsResponse.status !== 200) {
      throw new Error("Expected chat thread events to load");
    }
    const eventsBefore = eventsResponse.body;
    const createdEventId = eventsBefore.events.find((event) => {
      return (
        event.kind === "created" && event.chatThreadId === created.threadId
      );
    })?.id;
    if (!createdEventId) {
      throw new Error("Expected the MCP creation event");
    }
    for (const patch of [
      {},
      { title: " " },
      { title: "x".repeat(201) },
      { model: " \n\t " },
      { title: "Unknown field", extra: true },
    ]) {
      const result = await callTool(token, "update_chat_thread", {
        requestId: randomUUID(),
        threadId: created.threadId,
        patch,
      });
      expect(structuredToolError(result)).toMatchObject({
        code: "invalid_arguments",
        retryable: false,
      });
    }
    for (const patch of [
      { model: "not-a-supported-model" },
      { title: "Must roll back", model: "not-a-supported-model" },
      { title: "Must roll back denied model", model: "claude-opus-5-5" },
    ]) {
      const result = await callTool(token, "update_chat_thread", {
        requestId: randomUUID(),
        threadId: created.threadId,
        patch,
      });
      expect(structuredToolError(result)).toMatchObject({
        code: "selection_unavailable",
        retryable: false,
      });
    }
    expect(
      (
        await callTool(token, "update_chat_thread", {
          requestId: createdEventId,
          threadId: created.threadId,
          patch: { title: "Event collision must roll back" },
        })
      ).isError,
    ).toBeTruthy();
    await expect(getThread(token, created.threadId)).resolves.toMatchObject({
      thread: {
        title: "Unchanged metadata",
        model: { selectedModel: "claude-sonnet-5" },
      },
    });
    await expect(
      f.chat.requestThreadEvents(f.actor, {}, [200]),
    ).resolves.toMatchObject({ body: eventsBefore });
  });

  it("deduplicates simultaneous identical thread updates", async () => {
    const f = await creationFixture();
    const token = f.auth.token({ scope: defaultScopes });
    const created = await createThread(token, {
      requestId: randomUUID(),
      agentId: f.agent.agentId,
      title: "Concurrent metadata",
      model: "claude-sonnet-5",
    });
    const args = {
      requestId: randomUUID(),
      threadId: created.threadId,
      patch: { title: "One accepted update", model: "claude-opus-5" },
    };
    const results = await Promise.all([
      updateThread(token, args),
      updateThread(token, args),
    ]);
    expect(
      results
        .map((result) => {
          return result.replayed;
        })
        .sort(),
    ).toStrictEqual([false, true]);
    await expect(getThread(token, created.threadId)).resolves.toMatchObject({
      thread: {
        title: "One accepted update",
        model: { selectedModel: "claude-opus-5" },
      },
    });
  });

  it.each([
    { kind: "empty", message: undefined },
    { kind: "combined", message: "Retain one expiring initial input" },
  ] as const)(
    "expires $kind creation retries after 24 hours and does not recreate deleted conversations",
    async ({ message }) => {
      const f = await creationFixture();
      const args = {
        requestId: randomUUID(),
        agentId: f.agent.agentId,
        title: "Retry window",
        model: "claude-sonnet-5",
        ...(message === undefined ? {} : { message }),
      };
      const created = await createThread(
        f.auth.token({ scope: defaultScopes }),
        args,
      );
      // Settle a combined message's background pick before the thread moves
      // through replay, expiry, and deletion.
      await flushWaitUntilForTest();
      const token = f.auth.token({
        scope: defaultScopes,
        exp: Math.floor((Date.parse(created.retryUntil) + 60_000) / 1000),
      });
      await withMockNowForTest(Date.parse(created.retryUntil) - 1, async () => {
        await expect(createThread(token, args)).resolves.toMatchObject({
          replayed: true,
        });
      });
      await withMockNowForTest(Date.parse(created.retryUntil) + 1, async () => {
        const expired = await callTool(token, "create_chat_thread", args);
        expect(expired.isError).toBeTruthy();
        structuredToolError(expired);
      });
      await f.chat.deleteThread(f.actor, created.threadId);
      expect(
        (await callTool(token, "create_chat_thread", args)).isError,
      ).toBeTruthy();
      expect((await listThreads(token)).threads).toStrictEqual([]);
    },
  );

  it("rejects an unrelated created-event collision and an existing thread without matching creation evidence", async () => {
    const f = await creationFixture();
    const token = f.auth.token({ scope: defaultScopes });
    const args = {
      requestId: randomUUID(),
      agentId: f.agent.agentId,
      title: "MCP creation intent",
      model: "claude-sonnet-5",
    };
    const first = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
      title: "Other event owner",
      model: "claude-sonnet-5",
      eventId: mcpCreationEventId(args),
    });
    expect(
      (await callTool(token, "create_chat_thread", args)).isError,
    ).toBeTruthy();
    expect(
      (await callTool(token, "get_chat_thread", { threadId: args.requestId }))
        .isError,
    ).toBeTruthy();
    const existingId = randomUUID();
    const existing = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
      title: args.title,
      model: "claude-sonnet-5",
      clientThreadId: existingId,
      eventId: randomUUID(),
    });
    expect(
      (
        await callTool(token, "create_chat_thread", {
          ...args,
          requestId: existingId,
        })
      ).isError,
    ).toBeTruthy();
    const ids = (await listThreads(token)).threads.map((thread) => {
      return thread.threadId;
    });
    expect(new Set(ids)).toStrictEqual(new Set([first.id, existing.id]));
    expect(
      (await getMessages(token, { threadId: existing.id })).messages,
    ).toStrictEqual([]);
  });

  it("does not disclose private Agents or let another principal reuse a creation identity", async () => {
    const f = await creationFixture();
    const token = f.auth.token({ scope: defaultScopes });
    const args = {
      requestId: randomUUID(),
      agentId: f.agent.agentId,
      title: "Owner's conversation",
      model: "claude-sonnet-5",
    };
    await createThread(token, args);
    const second = await f.bdd.createAgent(f.actor, {
      displayName: "Another owned Agent",
      visibility: "private",
    });
    expect(
      (
        await callTool(token, "create_chat_thread", {
          ...args,
          agentId: second.agentId,
        })
      ).isError,
    ).toBeTruthy();
    const missing = await callTool(token, "create_chat_thread", {
      ...args,
      requestId: randomUUID(),
      agentId: randomUUID(),
    });
    for (const actor of [
      f.bdd.user({ orgId: f.auth.orgId }),
      f.bdd.user({ userId: f.auth.userId }),
    ]) {
      if (!actor.orgId) {
        throw new Error("Expected the peer's organization");
      }
      const hidden = await f.bdd.createAgent(actor, {
        displayName: "Private selection",
        visibility: "private",
      });
      await expect(
        callTool(token, "create_chat_thread", {
          ...args,
          requestId: randomUUID(),
          agentId: hidden.agentId,
        }),
      ).resolves.toStrictEqual(missing);
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
      const foreignToken = f.auth.token({
        sub: actor.userId,
        org_id: actor.orgId,
        scope: defaultScopes,
      });
      const failed = await callTool(foreignToken, "create_chat_thread", {
        ...args,
        agentId: hidden.agentId,
      });
      expect(failed.isError).toBeTruthy();
      expect(JSON.stringify(failed)).not.toContain("Owner's conversation");
    }
    expect((await listThreads(token)).threads).toHaveLength(1);
  });

  it("validates optional creation choices and rejects unrelated execution controls", async () => {
    const f = await creationFixture();
    const token = f.auth.token({ scope: defaultScopes });
    const args = {
      requestId: randomUUID(),
      agentId: f.agent.agentId,
      title: "A new conversation",
      model: "claude-sonnet-5",
    };
    for (const invalid of [
      { ...args, title: "  " },
      { ...args, title: "x".repeat(201) },
      { ...args, model: " \n\t " },
      { ...args, requestId: undefined },
      { ...args, prompt: "Must not execute" },
      { ...args, orgId: f.auth.orgId },
      {
        requestId: randomUUID(),
        title: "Blank initial input",
        message: "  ",
      },
      {
        requestId: randomUUID(),
        title: "Oversized initial input",
        message: "x".repeat(32_001),
      },
    ]) {
      const result = await callTool(token, "create_chat_thread", invalid);
      expect(structuredToolError(result)).toMatchObject({
        code: "invalid_arguments",
        retryable: false,
        issues: expect.any(Array),
      });
    }
    const unavailableModel = await callTool(token, "create_chat_thread", {
      ...args,
      model: "not-a-supported-model",
    });
    expect(structuredToolError(unavailableModel)).toMatchObject({
      code: "selection_unavailable",
      retryable: false,
    });
    expect((await listThreads(token)).threads).toStrictEqual([]);
    const invalidLimit = await callTool(token, "list_agents", { limit: 51 });
    expect(structuredToolError(invalidLimit)).toMatchObject({
      code: "invalid_arguments",
      retryable: false,
      issues: [expect.objectContaining({ path: ["limit"], code: "too_big" })],
    });
    const invalidModelInput = await callTool(token, "list_models", {
      orgId: f.auth.orgId,
    });
    expect(structuredToolError(invalidModelInput)).toMatchObject({
      code: "invalid_arguments",
      retryable: false,
      issues: [
        expect.objectContaining({ path: [], code: "unrecognized_keys" }),
      ],
    });
  });
});
