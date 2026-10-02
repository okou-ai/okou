import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { chatEventRowSchema } from "@okouai/api-contracts/contracts/chat-event-rows";
import { testChatEventRetentionContract } from "@okouai/api-contracts/contracts/test-chat-event-retention";
import { http, HttpResponse } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now, withMockNowForTest } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { testChatEventRetentionRoutes } from "../test-chat-event-retention";
import { setQueuedUserMessageCreatedAtFixture } from "../../../test-fixtures/chat-events";
import { createBddApi } from "./helpers/api-bdd";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import {
  installFakeChatEventR2,
  type RecordedChatEventPut,
} from "./helpers/fake-chat-event-r2";
import {
  requiredScopes,
  defaultScopes,
  rpc,
  requestBody,
  protocolHeaders,
  expectFixedMcpTimestamp,
  fixedMcpTimestamp,
  createMcpServerTestApi,
} from "./helpers/mcp-server";
import { createMcpServerFixtures } from "./helpers/mcp-server-fixtures";

const context = testContext();
const {
  client,
  fixture,
  callTool,
  structuredToolError,
  getThread,
  getMessages,
  searchMessages,
  getStatus,
  updateThread,
  sendMessage,
  revokeMessage,
  cancelRun,
  waitForInputRunId,
  waitForRejectedInput,
} = createMcpServerTestApi(context);
const {
  projectSearchMessages,
  messageFixture,
  snapshotMessages,
  threadFixture,
  nativeRunnerChatActor,
  chatRunFixture,
} = createMcpServerFixtures(context);

describe("MCP chat mutations", () => {
  it("keeps the first signed client source on a cross-client retry without leaking the token", async () => {
    const f = await messageFixture();
    const archived: RecordedChatEventPut[] = [];
    installFakeChatEventR2(context, archived);
    const thread = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
    });
    const metadataUrl = "https://mcp-client.example.test/oauth/client.json";
    context.mocks.dns.lookupOverrides.set("mcp-client.example.test", [
      { address: "8.8.8.8", family: 4 },
    ]);
    const authorizationHeaders: (string | null)[] = [];
    server.use(
      http.get(metadataUrl, ({ request }) => {
        authorizationHeaders.push(request.headers.get("authorization"));
        return HttpResponse.json({
          client_id: metadataUrl,
          client_name: "  Claude   Code  ",
        });
      }),
    );
    const args = {
      threadId: thread.id,
      requestId: randomUUID(),
      text: "Source stays with the accepted message",
    };
    const token = f.auth.token({
      client_id: metadataUrl,
      scope: defaultScopes,
    });
    const receipt = await sendMessage(token, args);
    await waitForRejectedInput(token, receipt.inputRef);
    const original = (
      await f.chat.listThreadEvents(f.actor, thread.id)
    ).events.find((event) => {
      return event.id === args.requestId && event.eventType === "input.prompt";
    });
    if (original?.eventType !== "input.prompt") {
      throw new Error("Expected the MCP input event");
    }
    expect(original.userMessage).toStrictEqual({
      version: 1,
      parts: [
        { type: "text", text: args.text },
        {
          type: "source",
          kind: "mcp",
          clientId: metadataUrl,
          clientName: "Claude Code",
        },
      ],
    });
    expect(authorizationHeaders).toStrictEqual([null]);
    expect(
      (await getMessages(token, { threadId: thread.id })).messages,
    ).toMatchObject([{ text: args.text }]);

    // A later metadata edit cannot change the already accepted input.
    server.use(
      http.get(metadataUrl, () => {
        return HttpResponse.json({
          client_id: metadataUrl,
          client_name: "Renamed client",
        });
      }),
    );
    await expect(sendMessage(token, args)).resolves.toMatchObject({
      inputRef: receipt.inputRef,
      replayed: true,
    });
    const differentClient = f.auth.token({
      client_id: "another_signed_client",
      scope: defaultScopes,
    });
    await expect(sendMessage(differentClient, args)).resolves.toMatchObject({
      inputRef: receipt.inputRef,
      replayed: true,
    });
    expect(
      structuredToolError(
        await callTool(differentClient, "send_chat_message", {
          ...args,
          text: "A different message must still conflict",
        }),
      ),
    ).toMatchObject({ code: "request_id_conflict", retryable: false });
    const after = (
      await f.chat.listThreadEvents(f.actor, thread.id)
    ).events.find((event) => {
      return event.id === args.requestId && event.eventType === "input.prompt";
    });
    if (after?.eventType !== "input.prompt") {
      throw new Error("Expected the replayed MCP input event");
    }
    expect(after.userMessage).toStrictEqual(original.userMessage);
    // The canonical archive must retain the source and the MCP history must
    // remain readable after its raw input row is deleted. Raw Events correctly
    // return 410 for a cursor that predates retention, so inspect the captured
    // R2 write rather than attempting to read expired rows from sequence zero.
    // Only the cutoff needs a fixture: public MCP sends cannot backdate input.
    await setQueuedUserMessageCreatedAtFixture({
      eventId: args.requestId,
      createdAt: new Date(now() - 31 * 24 * 60 * 60 * 1000),
    });
    await snapshotMessages(thread.id);
    const archive = archived.at(-1);
    if (!archive) {
      throw new Error("Expected the canonical MCP archive");
    }
    const archivedInput = gunzipSync(archive.body)
      .toString("utf8")
      .trimEnd()
      .split("\n")
      .map((line) => {
        return chatEventRowSchema.parse(JSON.parse(line));
      })
      .find((row) => {
        return row.id === args.requestId;
      });
    expect(archivedInput?.payload?.userMessage).toStrictEqual(
      original.userMessage,
    );
    const retained = await accept(
      setupApp({ context, routes: testChatEventRetentionRoutes })(
        testChatEventRetentionContract,
      ).retain({ body: { chat_thread_ids: [thread.id] } }),
      [200],
    );
    expect(retained.body.deleted).toBe(1);
    expect(
      (await getMessages(token, { threadId: thread.id })).messages,
    ).toMatchObject([{ text: args.text }]);
  });

  it("keeps signed provenance but omits unsafe or mismatched client display metadata", async () => {
    const f = await messageFixture();
    const thread = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
    });
    const metadataUrl =
      "https://untrusted-client.example.test/oauth/client.json";
    context.mocks.dns.lookupOverrides.set("untrusted-client.example.test", [
      { address: "8.8.8.8", family: 4 },
    ]);
    server.use(
      http.get(metadataUrl, () => {
        return HttpResponse.json({
          client_id: "https://different.example.test/oauth/client.json",
          client_name: "Do not show this name",
        });
      }),
    );
    for (const clientId of [
      metadataUrl,
      "https://localhost/private",
      "mcp_non_url_client",
    ]) {
      const args = {
        threadId: thread.id,
        requestId: randomUUID(),
        text: `Missing metadata for ${clientId}`,
      };
      const token = f.auth.token({ client_id: clientId, scope: defaultScopes });
      const receipt = await sendMessage(token, args);
      await waitForRejectedInput(token, receipt.inputRef);
      const original = (
        await f.chat.listThreadEvents(f.actor, thread.id)
      ).events.find((event) => {
        return (
          event.id === args.requestId && event.eventType === "input.prompt"
        );
      });
      if (original?.eventType !== "input.prompt") {
        throw new Error("Expected the fallback MCP input event");
      }
      expect(original.userMessage).toStrictEqual({
        version: 1,
        parts: [
          { type: "text", text: args.text },
          { type: "source", kind: "mcp", clientId },
        ],
      });
    }

    // A matching client_id cannot make an oversized or unavailable name safe.
    for (const response of [
      HttpResponse.json({
        client_id: metadataUrl,
        client_name: "x".repeat(121),
      }),
      HttpResponse.json({
        client_id: metadataUrl,
        client_name: "A\u202eB",
      }),
      new HttpResponse(null, { status: 503 }),
    ]) {
      server.use(
        http.get(metadataUrl, () => {
          return response;
        }),
      );
      const requestId = randomUUID();
      const token = f.auth.token({
        client_id: metadataUrl,
        scope: defaultScopes,
      });
      const receipt = await sendMessage(token, {
        threadId: thread.id,
        requestId,
        text: "Still accepted without a display name",
      });
      await waitForRejectedInput(token, receipt.inputRef);
      const input = (
        await f.chat.listThreadEvents(f.actor, thread.id)
      ).events.find((event) => {
        return event.id === requestId;
      });
      if (input?.eventType !== "input.prompt") {
        throw new Error("Expected the fallback input event");
      }
      expect(input.userMessage.parts[1]).toStrictEqual({
        type: "source",
        kind: "mcp",
        clientId: metadataUrl,
      });
    }
  });

  it("keeps the display fallback when the metadata lookup deadline expires", async () => {
    const f = await messageFixture();
    const thread = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
    });
    const metadataUrl =
      "https://deadline-client.example.test/oauth/client.json";
    context.mocks.abortSignal.timeout.mockImplementation((milliseconds) => {
      return milliseconds === 2500
        ? AbortSignal.abort(new DOMException("Lookup deadline", "TimeoutError"))
        : undefined;
    });
    const token = f.auth.token({
      client_id: metadataUrl,
      scope: defaultScopes,
    });
    const receipt = await sendMessage(token, {
      threadId: thread.id,
      requestId: randomUUID(),
      text: "Deadline still accepts the input",
    });
    await waitForRejectedInput(token, receipt.inputRef);
    const input = (
      await f.chat.listThreadEvents(f.actor, thread.id)
    ).events.find((event) => {
      return event.id === receipt.inputRef.eventId;
    });
    if (input?.eventType !== "input.prompt") {
      throw new Error("Expected the accepted MCP input");
    }
    expect(input.userMessage.parts[1]).toStrictEqual({
      type: "source",
      kind: "mcp",
      clientId: metadataUrl,
    });
  });

  it("treats UUID letter case as the same submission identity", async () => {
    const f = await messageFixture();
    const thread = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
    });
    const requestId = randomUUID();
    const token = f.auth.token({ scope: defaultScopes });
    const text = "Preserve the message while normalizing its identifiers";
    const accepted = await sendMessage(token, {
      threadId: thread.id.toUpperCase(),
      requestId: requestId.toUpperCase(),
      text,
    });
    expect(accepted).toMatchObject({
      inputRef: { threadId: thread.id, eventId: requestId },
      replayed: false,
    });
    await waitForRejectedInput(token, accepted.inputRef);
    const replay = await sendMessage(token, {
      threadId: thread.id,
      requestId,
      text,
    });
    expect(replay).toStrictEqual({
      ...accepted,
      disposition: "rejected",
      runId: null,
      replayed: true,
    });
    expect(
      (await getMessages(token, { threadId: thread.id })).messages,
    ).toMatchObject([{ text }]);
  });

  it("correlates acceptance, visible-message, source-event, metadata, and activity times", async () => {
    const f = await messageFixture();
    const thread = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
    });
    const text = "  Keep my whitespace\n中文 😀  ";
    const requestId = randomUUID();
    const token = f.auth.token({ scope: defaultScopes });
    const beforeInput = await getThread(token, thread.id);
    const result = await sendMessage(token, {
      threadId: thread.id,
      text,
      requestId,
    });
    expect(result).toMatchObject({
      inputRef: { threadId: thread.id, eventId: requestId },
      replayed: false,
      runId: null,
    });
    // The send only enqueues; the background pick rejects the input.
    await waitForRejectedInput(token, result.inputRef);
    expectFixedMcpTimestamp(result.acceptedAt);
    expectFixedMcpTimestamp(result.retryUntil);
    expect(Date.parse(result.retryUntil) - Date.parse(result.acceptedAt)).toBe(
      24 * 60 * 60 * 1000,
    );
    expect(new URL(result.url).pathname).toBe(`/chats/${thread.id}`);
    const events = (await f.chat.listThreadEvents(f.actor, thread.id)).events;
    const original = events.find((event) => {
      return event.id === requestId;
    });
    expect(original).toMatchObject({
      seqId: result.inputRef.seqId,
      eventType: "input.prompt",
      userMessage: {
        version: 1,
        parts: [
          { type: "text", text },
          { type: "source", kind: "mcp", clientId: "mcp_test_client" },
        ],
      },
    });
    const [message] = (await getMessages(token, { threadId: thread.id }))
      .messages;
    if (!message) {
      throw new Error("Expected the visible rejected input");
    }
    expect(message).toMatchObject({
      text,
      eventType: "input.rejected",
      runId: null,
      messageAt: result.acceptedAt,
    });
    expectFixedMcpTimestamp(message.messageAt);

    const afterInput = await getThread(token, thread.id);
    expectFixedMcpTimestamp(afterInput.thread.createdAt);
    expectFixedMcpTimestamp(afterInput.thread.metadataUpdatedAt);
    expectFixedMcpTimestamp(afterInput.thread.lastMessageAt);
    expect(afterInput.thread.metadataUpdatedAt).toBe(
      beforeInput.thread.metadataUpdatedAt,
    );
    expect(Date.parse(afterInput.thread.lastMessageAt)).toBeGreaterThanOrEqual(
      Date.parse(beforeInput.thread.lastMessageAt),
    );

    await projectSearchMessages([thread.id]);
    const searched = await searchMessages(token, { query: "whitespace" });
    expect(searched.matches).toHaveLength(1);
    const [match] = searched.matches;
    if (!match) {
      throw new Error("Expected the indexed visible message");
    }
    expect(match.ref).toStrictEqual(message.ref);
    expectFixedMcpTimestamp(match.sourceEventAt);
    // The visible rejection replaces the accepted input, so its source event
    // is strictly later than the message time it keeps.
    expect(Date.parse(match.sourceEventAt)).toBeGreaterThan(
      Date.parse(message.messageAt),
    );
    expect(match.sourceEventAt).not.toBe(message.messageAt);
    const sourceEventTime = new Date(match.sourceEventAt);
    await expect(
      searchMessages(token, {
        query: "whitespace",
        since: sourceEventTime.toISOString(),
        before: new Date(sourceEventTime.getTime() + 1).toISOString(),
      }),
    ).resolves.toMatchObject({ matches: [{ ref: message.ref }] });
    await expect(
      searchMessages(token, {
        query: "whitespace",
        before: sourceEventTime.toISOString(),
      }),
    ).resolves.toMatchObject({ matches: [] });

    const activityBeforeMetadataUpdate = afterInput.thread.lastMessageAt;
    const update = await updateThread(token, {
      requestId: randomUUID(),
      threadId: thread.id,
      patch: { title: "Explicit timestamp semantics" },
    });
    expectFixedMcpTimestamp(update.metadataUpdatedAt);
    const afterMetadataUpdate = await getThread(token, thread.id);
    expect(afterMetadataUpdate.thread.metadataUpdatedAt).toBe(
      update.metadataUpdatedAt,
    );
    expect(afterMetadataUpdate.thread.lastMessageAt).toBe(
      activityBeforeMetadataUpdate,
    );

    const later = await sendMessage(token, {
      threadId: thread.id,
      text: "Later activity marker",
      requestId: randomUUID(),
    });
    await waitForRejectedInput(token, later.inputRef);
    const afterLaterActivity = await getThread(token, thread.id);
    expect(afterLaterActivity.thread.metadataUpdatedAt).toBe(
      afterMetadataUpdate.thread.metadataUpdatedAt,
    );
    expect(Date.parse(afterLaterActivity.thread.lastMessageAt)).toBeGreaterThan(
      Date.parse(afterMetadataUpdate.thread.lastMessageAt),
    );

    const status = await getStatus(token, {
      inputRef: result.inputRef,
    });
    expect(status).toMatchObject({
      lifecycle: { phase: "settled", outcome: "rejected", output: "none" },
      messages: null,
      retryAfterMs: null,
    });
    expectFixedMcpTimestamp(status.observedAt);
    const beforeReplayEvents = (
      await f.chat.listThreadEvents(f.actor, thread.id)
    ).events;
    const replay = await sendMessage(token, {
      threadId: thread.id,
      text,
      requestId,
    });
    expect(replay).toStrictEqual({
      ...result,
      disposition: "rejected",
      runId: null,
      replayed: true,
    });
    expect(
      (await f.chat.listThreadEvents(f.actor, thread.id)).events,
    ).toStrictEqual(beforeReplayEvents);
  });

  it("accepts refreshed authorization for the original receipt", async () => {
    const f = await messageFixture();
    const thread = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
    });
    const args = {
      threadId: thread.id,
      text: "One accepted message replayed with a refreshed token",
      requestId: randomUUID(),
    };
    const token = f.auth.token({ scope: defaultScopes });
    const original = await sendMessage(token, args);
    const refreshed = f.auth.token({
      scope: `${requiredScopes} okou:chat:send`,
      exp: Math.floor(now() / 1000) + 7200,
      jti: randomUUID(),
    });
    const replay = await sendMessage(refreshed, args);
    expect(replay.inputRef).toStrictEqual(original.inputRef);
    expect(replay.acceptedAt).toBe(original.acceptedAt);
    expect(replay.retryUntil).toBe(original.retryUntil);
    expect(replay.replayed).toBeTruthy();
    const messages = await getMessages(token, { threadId: thread.id });
    expect(messages.messages).toHaveLength(1);
    expect(messages.messages[0]?.text).toBe(args.text);
  });

  it("rejects same-identity changes of exact text or thread without changing either conversation", async () => {
    const f = await messageFixture();
    const first = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
    });
    const second = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
    });
    const args = {
      threadId: first.id,
      text: "Exact input",
      requestId: randomUUID(),
    };
    const token = f.auth.token({ scope: defaultScopes });
    const receipt = await sendMessage(token, args);
    await waitForRejectedInput(token, receipt.inputRef);
    for (const threadId of [first.id, second.id]) {
      await f.chat.patchThread(f.actor, threadId, {
        draftUserMessage: {
          version: 1,
          parts: [{ type: "text", text: "Keep this unsent draft" }],
        },
      });
    }
    const firstBefore = await f.chat.readThread(f.actor, first.id);
    const secondBefore = await f.chat.readThread(f.actor, second.id);
    const before = await f.chat.listThreadEvents(f.actor, first.id);
    for (const changed of [
      { ...args, text: "Exact input " },
      { ...args, threadId: second.id },
    ]) {
      const failed = await callTool(token, "send_chat_message", changed);
      expect(structuredToolError(failed)).toMatchObject({
        code: "request_id_conflict",
        retryable: false,
      });
    }
    await expect(
      f.chat.listThreadEvents(f.actor, first.id),
    ).resolves.toStrictEqual(before);
    expect(
      (await getMessages(token, { threadId: second.id })).messages,
    ).toStrictEqual([]);
    expect((await sendMessage(token, args)).inputRef).toStrictEqual(
      receipt.inputRef,
    );
    await expect(f.chat.readThread(f.actor, first.id)).resolves.toStrictEqual(
      firstBefore,
    );
    await expect(f.chat.readThread(f.actor, second.id)).resolves.toStrictEqual(
      secondBefore,
    );
  });

  it("keeps an owned first-party text input separate from MCP retry identity", async () => {
    const f = await messageFixture();
    const thread = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
    });
    const requestId = randomUUID();
    const text = "An existing first-party input";
    await f.chat.requestSendEvent(
      f.actor,
      {
        agentId: f.agent.agentId,
        threadId: thread.id,
        clientEventId: requestId,
        prompt: text,
      },
      [201],
    );
    await flushWaitUntilForTest();
    const before = await f.chat.listThreadEvents(f.actor, thread.id);
    const original = before.events.find((event) => {
      return event.id === requestId;
    });
    if (original?.eventType !== "input.prompt") {
      throw new Error("Expected the first-party input");
    }
    expect(original.userMessage).toStrictEqual({
      version: 1,
      parts: [{ type: "text", text }],
    });
    const token = f.auth.token({ scope: defaultScopes });
    for (let attempt = 0; attempt < 2; attempt++) {
      const failed = await callTool(token, "send_chat_message", {
        threadId: thread.id,
        text,
        requestId,
      });
      expect(structuredToolError(failed)).toMatchObject({
        code: "request_id_conflict",
        message: expect.stringContaining(
          "cannot be replayed as an MCP submission",
        ),
        retryable: false,
      });
    }
    await expect(
      f.chat.listThreadEvents(f.actor, thread.id),
    ).resolves.toStrictEqual(before);
  });

  it.each(["different text", "additional user context"] as const)(
    "rejects a first-party input with the same identity but %s",
    async (difference) => {
      const f = await messageFixture();
      const thread = await f.chat.createThread(f.actor, {
        agentId: f.agent.agentId,
      });
      const requestId = randomUUID();
      const text = "An existing first-party input";
      await f.chat.requestSendEvent(
        f.actor,
        {
          agentId: f.agent.agentId,
          threadId: thread.id,
          clientEventId: requestId,
          prompt: text,
          userMessage: {
            version: 1,
            parts: [
              { type: "text", text },
              ...(difference === "additional user context"
                ? [
                    {
                      type: "additional_info" as const,
                      text: "Original context",
                    },
                  ]
                : []),
            ],
          },
        },
        [201],
      );
      await flushWaitUntilForTest();
      const before = await f.chat.listThreadEvents(f.actor, thread.id);
      const failed = await callTool(
        f.auth.token({ scope: defaultScopes }),
        "send_chat_message",
        {
          threadId: thread.id,
          text: difference === "different text" ? `${text} changed` : text,
          requestId,
        },
      );
      expect(structuredToolError(failed)).toMatchObject({
        code: "request_id_conflict",
        retryable: false,
      });
      await expect(
        f.chat.listThreadEvents(f.actor, thread.id),
      ).resolves.toStrictEqual(before);
    },
  );

  it("expires an accepted identity after its absolute retry window without admitting another input", async () => {
    const f = await messageFixture();
    const thread = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
    });
    const args = {
      threadId: thread.id,
      text: "Absolute retry window",
      requestId: randomUUID(),
    };
    const receipt = await sendMessage(
      f.auth.token({ scope: defaultScopes }),
      args,
    );
    await waitForRejectedInput(
      f.auth.token({ scope: defaultScopes }),
      receipt.inputRef,
    );
    // Clerk validates real wall time while the receipt uses scoped app time.
    // Keep this credential valid across both clocks to isolate receipt expiry.
    const expiryToken = f.auth.token({
      scope: defaultScopes,
      exp: Math.floor((Date.parse(receipt.retryUntil) + 60_000) / 1000),
    });
    const before = await f.chat.listThreadEvents(f.actor, thread.id);
    await withMockNowForTest(Date.parse(receipt.retryUntil) - 1, async () => {
      const replay = await sendMessage(expiryToken, args);
      expect(replay).toStrictEqual({
        ...receipt,
        disposition: "rejected",
        runId: null,
        replayed: true,
      });
    });
    await withMockNowForTest(Date.parse(receipt.retryUntil) + 1, async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const expired = await callTool(expiryToken, "send_chat_message", args);
        expect(structuredToolError(expired)).toMatchObject({
          code: "request_expired",
          retryable: false,
        });
        expect(expired.content[0]?.text).toContain("expired");
      }
    });
    await expect(
      f.chat.listThreadEvents(f.actor, thread.id),
    ).resolves.toStrictEqual(before);
  });

  it("rechecks current thread authorization before disclosing an accepted receipt", async () => {
    const f = await messageFixture();
    const thread = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
    });
    const args = {
      threadId: thread.id,
      text: "PRIVATE_MCP_RECEIPT",
      requestId: randomUUID(),
    };
    const token = f.auth.token({ scope: defaultScopes });
    const submitted = await sendMessage(token, args);
    await waitForRejectedInput(token, submitted.inputRef);
    const strangers = [
      f.bdd.user({ orgId: f.auth.orgId }),
      f.bdd.user({ userId: f.auth.userId }),
    ];
    for (const actor of strangers) {
      if (!actor.orgId) {
        throw new Error("Expected an organization for an OAuth peer");
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
      const foreignToken = f.auth.token({
        sub: actor.userId,
        org_id: actor.orgId,
        scope: defaultScopes,
      });
      const failure = await callTool(foreignToken, "send_chat_message", args);
      const missing = await callTool(foreignToken, "send_chat_message", {
        ...args,
        threadId: randomUUID(),
      });
      expect(failure).toStrictEqual(missing);
      expect(failure.isError).toBeTruthy();
      expect(JSON.stringify(failure)).not.toContain("PRIVATE_MCP_RECEIPT");
      const hiddenStatus = await callTool(foreignToken, "get_chat_status", {
        inputRef: submitted.inputRef,
      });
      const missingThreadId = randomUUID();
      await expect(
        callTool(foreignToken, "get_chat_status", {
          inputRef: { ...submitted.inputRef, threadId: missingThreadId },
        }),
      ).resolves.toStrictEqual(hiddenStatus);
      expect(hiddenStatus.isError).toBeTruthy();
      structuredToolError(hiddenStatus);
      await expect(
        revokeMessage(foreignToken, submitted.inputRef),
      ).resolves.toMatchObject({ outcome: "unavailable", runId: null });
    }
    await f.chat.deleteThread(f.actor, thread.id);
    expect(
      (await callTool(token, "send_chat_message", args)).isError,
    ).toBeTruthy();
    expect(
      (
        await callTool(token, "get_chat_status", {
          inputRef: submitted.inputRef,
        })
      ).isError,
    ).toBeTruthy();
  });

  it.each([
    {
      name: "create_chat_thread",
      scope: "okou:chat:manage",
      args: {
        requestId: randomUUID(),
        agentId: randomUUID(),
        title: "Scope check",
        model: "claude-sonnet-5",
      },
    },
    {
      name: "update_chat_thread",
      scope: "okou:chat:manage",
      args: {
        requestId: randomUUID(),
        threadId: randomUUID(),
        patch: { title: "Scope check" },
      },
    },
    {
      name: "send_chat_message",
      scope: "okou:chat:send",
      args: {
        threadId: randomUUID(),
        text: "No grant",
        requestId: randomUUID(),
      },
    },
    {
      name: "revoke_queued_message",
      scope: "okou:run:cancel",
      args: {
        inputRef: {
          threadId: randomUUID(),
          eventId: randomUUID(),
          seqId: 1,
        },
      },
    },
    {
      name: "cancel_run",
      scope: "okou:run:cancel",
      args: { runId: randomUUID() },
    },
  ])(
    "requires $scope for manual $name invocation",
    async ({ name, scope, args }) => {
      const auth = await fixture();
      const token = auth.token({
        scope: defaultScopes
          .split(" ")
          .filter((value) => {
            return value !== scope;
          })
          .join(" "),
      });
      const listed = await accept(
        client().request({
          extraHeaders: protocolHeaders(token, "tools/list"),
          body: requestBody("tools/list"),
        }),
        [200],
      );
      const tools = z
        .object({
          result: z.object({ tools: z.array(z.object({ name: z.string() })) }),
        })
        .parse(rpc(listed.body)).result.tools;
      expect(
        tools.some((tool) => {
          return tool.name === name;
        }),
      ).toBeFalsy();
      expect(
        tools.some((tool) => {
          return tool.name === "get_chat_messages";
        }),
      ).toBeTruthy();
      const response = await accept(
        client().request({
          extraHeaders: protocolHeaders(token, "tools/call", true, name),
          body: requestBody("tools/call", true, { name, arguments: args }),
        }),
        [200],
      );
      expect(rpc(response.body)).toMatchObject({
        error: { message: expect.any(String) },
      });
    },
  );

  it("rejects unsupported send controls and invalid text before enqueueing", async () => {
    const f = await threadFixture();
    const thread = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
    });
    const token = f.auth.token({ scope: defaultScopes });
    const base = {
      threadId: thread.id,
      text: "Only ordinary user input",
      requestId: randomUUID(),
    };
    for (const args of [
      { ...base, text: " \n\t " },
      { ...base, text: "x".repeat(32_001) },
      { ...base, requestId: "not-a-uuid" },
      { ...base, model: "claude-sonnet-5" },
      { ...base, agentId: f.agent.agentId },
    ]) {
      const failed = await callTool(token, "send_chat_message", args);
      expect(structuredToolError(failed)).toMatchObject({
        code: "invalid_arguments",
        retryable: false,
      });
    }
    expect(
      (await getMessages(token, { threadId: thread.id })).messages,
    ).toStrictEqual([]);
  });

  it.each(["lowercase", "uppercase"] as const)(
    "withdraws pending input exactly once without cancelling its active run (%s UUIDs)",
    async (letterCase) => {
      const f = await chatRunFixture();
      const active = await createChatEventsFixture(context).sendChatRun(
        f.actor,
        { agentId: f.agent.agentId, prompt: "Keep this run active" },
      );
      const runId = active.runId;
      onTestFinished(async () => {
        await f.runs.requestCancelRun(f.actor, runId, [200]);
      });
      const token = f.auth.token({ scope: defaultScopes });
      const args = {
        threadId: active.threadId,
        text: "Withdraw only this pending input",
        requestId: randomUUID(),
      };
      const sent = await sendMessage(token, args);
      expect(sent).toMatchObject({ disposition: "queued", runId: null });
      await expect(
        getStatus(token, { inputRef: sent.inputRef }),
      ).resolves.toMatchObject({
        lifecycle: { phase: "queued", outcome: null, output: "pending" },
        messages: null,
      });
      const revoked = await revokeMessage(
        token,
        letterCase === "uppercase"
          ? {
              ...sent.inputRef,
              threadId: sent.inputRef.threadId.toUpperCase(),
              eventId: sent.inputRef.eventId.toUpperCase(),
            }
          : sent.inputRef,
      );
      expect(revoked).toMatchObject({
        inputRef: sent.inputRef,
        outcome: "revoked",
      });
      await expect(revokeMessage(token, sent.inputRef)).resolves.toMatchObject({
        outcome: "already_revoked",
      });
      await expect(sendMessage(token, args)).resolves.toMatchObject({
        inputRef: sent.inputRef,
        replayed: true,
        disposition: "revoked",
        runId: null,
      });
      await expect(
        getStatus(token, { inputRef: sent.inputRef }),
      ).resolves.toMatchObject({
        lifecycle: { phase: "settled", outcome: "revoked", output: "none" },
        messages: null,
        retryAfterMs: null,
      });
      expect(
        (await getMessages(token, { threadId: args.threadId })).messages.map(
          (message) => {
            return message.text;
          },
        ),
      ).toStrictEqual(["Keep this run active"]);
      await expect(f.runs.readRun(f.actor, runId)).resolves.toMatchObject({
        status: "pending",
      });
      expect(
        (await f.chat.listThreadEvents(f.actor, args.threadId)).events.filter(
          (event) => {
            return (
              event.eventType === "control.revoke" &&
              event.revokesEventId === args.requestId
            );
          },
        ),
      ).toHaveLength(1);
      const before = await f.chat.listThreadEvents(f.actor, args.threadId);
      await expect(
        revokeMessage(token, {
          ...sent.inputRef,
          eventId: randomUUID(),
        }),
      ).resolves.toMatchObject({ outcome: "unavailable" });
      await expect(
        revokeMessage(token, {
          ...sent.inputRef,
          seqId: sent.inputRef.seqId + 1,
        }),
      ).resolves.toMatchObject({ outcome: "unavailable" });
      await expect(
        f.chat.listThreadEvents(f.actor, args.threadId),
      ).resolves.toStrictEqual(before);
    },
  );

  it("starts an ordinary run and denies cancellation by another user or organization", async () => {
    const f = await chatRunFixture();
    const thread = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
    });
    const token = f.auth.token({ scope: defaultScopes });
    const args = {
      threadId: thread.id,
      text: "Start through the normal run scheduler",
      requestId: randomUUID(),
    };
    const sent = await sendMessage(token, args);
    // The send only enqueues; the background pick starts the run.
    expect(["queued", "associated"]).toContain(sent.disposition);
    const runId = await waitForInputRunId(token, sent.inputRef);
    onTestFinished(async () => {
      await f.runs.requestCancelRun(f.actor, runId, [200]);
    });
    await expect(sendMessage(token, args)).resolves.toMatchObject({
      inputRef: sent.inputRef,
      replayed: true,
      disposition: "associated",
      runId,
    });
    await expect(f.runs.readRun(f.actor, runId)).resolves.toMatchObject({
      status: "pending",
    });
    const bdd = createBddApi(context);
    for (const actor of [
      bdd.user({ orgId: f.auth.orgId }),
      bdd.user({ userId: f.auth.userId }),
    ]) {
      if (!actor.orgId) {
        throw new Error("Expected organization for cancellation authorization");
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
      const failure = await callTool(
        f.auth.token({
          scope: defaultScopes,
          sub: actor.userId,
          org_id: actor.orgId,
        }),
        "cancel_run",
        { runId },
      );
      expect(failure.isError).toBeTruthy();
      structuredToolError(failure);
      expect(failure.content[0]?.text).toContain("No such run");
    }
    await expect(f.runs.readRun(f.actor, runId)).resolves.toMatchObject({
      status: "pending",
    });
  });

  it("reports steered input as associated with the same active run after its declaration", async () => {
    const auth = await fixture();
    const f = createChatEventsFixture(context);
    const actor = await nativeRunnerChatActor(f, auth);
    const thread = await f.chat.createThread(actor.actor, {
      agentId: actor.agentId,
    });
    const token = auth.token({ scope: defaultScopes });
    const initial = await sendMessage(token, {
      threadId: thread.id,
      requestId: randomUUID(),
      text: "Active steer target",
    });
    const active = {
      threadId: thread.id,
      runId: await waitForInputRunId(token, initial.inputRef),
    };
    onTestFinished(async () => {
      await f.cancelChatRun(actor.actor, active.runId);
    });
    const claimed = await f.claimChatRun(actor.runnerGroup, active.runId);
    const args = {
      threadId: active.threadId,
      text: "Steer the current run",
      requestId: randomUUID(),
    };
    const sent = await sendMessage(token, args);
    expect(sent).toMatchObject({ disposition: "queued", runId: null });
    await expect(
      f.api.nextSteerableInput(claimed.claim.sandboxToken, active.runId),
    ).resolves.toStrictEqual({
      input: {
        eventId: args.requestId,
        prompt: expect.stringContaining(args.text),
      },
    });
    // Reading is read-only: the input stays queued until it is declared steered.
    await expect(sendMessage(token, args)).resolves.toMatchObject({
      inputRef: sent.inputRef,
      replayed: true,
      disposition: "queued",
      runId: null,
    });
    // Declare the steer on a later app clock so the associated source event
    // has a distinct, known time from the accepted input it replaces.
    const associatedSourceTime = new Date(Date.parse(sent.acceptedAt) + 10_000);
    await expect(
      withMockNowForTest(associatedSourceTime, async () => {
        const declared = await f.api.declareSteeredInput(
          claimed.claim.sandboxToken,
          active.runId,
          args.requestId,
        );
        await flushWaitUntilForTest();
        return declared;
      }),
    ).resolves.toStrictEqual({ outcome: "steered" });
    await expect(sendMessage(token, args)).resolves.toMatchObject({
      inputRef: sent.inputRef,
      replayed: true,
      disposition: "associated",
      runId: active.runId,
    });
    const delivered = await getStatus(token, {
      inputRef: sent.inputRef,
    });
    expect(delivered).toMatchObject({
      lifecycle: { phase: "running", outcome: null, output: "pending" },
      messages: {
        arguments: {
          threadId: active.threadId,
          runId: active.runId,
          limit: 20,
        },
      },
    });
    await expect(revokeMessage(token, sent.inputRef)).resolves.toMatchObject({
      outcome: "not_revocable",
      reason: "reserved_or_associated",
      runId: active.runId,
    });
    const associatedMessages = (
      await getMessages(token, { threadId: args.threadId })
    ).messages;
    expect(associatedMessages).toMatchObject([
      { text: "Active steer target", runId: active.runId },
      { text: args.text, runId: active.runId },
    ]);
    const associatedMessage = associatedMessages.find((message) => {
      return message.text === args.text;
    });
    if (!associatedMessage) {
      throw new Error("Expected the associated visible input");
    }
    expect(associatedMessage.messageAt).toBe(sent.acceptedAt);
    expectFixedMcpTimestamp(associatedMessage.messageAt);
    await projectSearchMessages([args.threadId]);
    const associatedSearch = await searchMessages(token, {
      query: "Steer the current run",
      threadId: args.threadId,
    });
    expect(associatedSearch.matches).toHaveLength(1);
    expect(associatedSearch.matches[0]).toMatchObject({
      ref: associatedMessage.ref,
      sourceEventAt: fixedMcpTimestamp(associatedSourceTime),
    });
    expect(associatedSearch.matches[0]?.sourceEventAt).not.toBe(
      associatedMessage.messageAt,
    );
    await expect(
      f.api.readRun(actor.actor, active.runId),
    ).resolves.toMatchObject({
      status: "running",
    });
    await f.webhooks.requestAgentEvents(
      {
        runId: active.runId,
        events: Array.from({ length: 21 }, (_, sequenceNumber) => {
          return {
            type: "assistant",
            sequenceNumber,
            message: {
              content: [
                { type: "text", text: `Shared output ${sequenceNumber}` },
              ],
            },
          };
        }),
      },
      claimed.sandboxHeaders,
      [200],
    );
    const steered = await getStatus(token, {
      inputRef: sent.inputRef,
    });
    const launched = await getStatus(token, {
      inputRef: initial.inputRef,
    });
    expect(launched.lifecycle).toStrictEqual({
      phase: "running",
      outcome: null,
      output: "partial",
    });
    expect(steered.lifecycle).toStrictEqual(launched.lifecycle);
    expect(steered.messages).toStrictEqual(launched.messages);
    if (!steered.messages) {
      throw new Error("Expected shared output retrieval instructions");
    }
    const page = await getMessages(token, steered.messages.arguments);
    expect(page.messages).toHaveLength(20);
    expect(
      page.messages.every((message) => {
        return message.role === "assistant";
      }),
    ).toBeTruthy();
    expect(page.olderCursor).not.toBeNull();
    installFakeChatEventR2(context, []);
    // Infrastructure exception: public sends cannot backdate acceptance past
    // the database retention cutoff. Retaining this settled source also removes
    // its delivery receipt, while canonical archived replacement links survive.
    await setQueuedUserMessageCreatedAtFixture({
      eventId: sent.inputRef.eventId,
      createdAt: new Date(now() - 31 * 24 * 60 * 60 * 1000),
    });
    await snapshotMessages(args.threadId);
    const retained = await accept(
      setupApp({ context, routes: testChatEventRetentionRoutes })(
        testChatEventRetentionContract,
      ).retain({ body: { chat_thread_ids: [args.threadId] } }),
      [200],
    );
    expect(retained.body.deleted).toBe(1);
    const archived = await getStatus(token, {
      inputRef: sent.inputRef,
    });
    expect(archived.lifecycle).toStrictEqual(steered.lifecycle);
    expect(archived.messages).toStrictEqual(steered.messages);
  });

  it.each(["lowercase", "uppercase"] as const)(
    "cancels an owned run cooperatively and keeps repeated cancellation idempotent (%s UUIDs)",
    async (letterCase) => {
      const auth = await fixture();
      const f = createChatEventsFixture(context);
      const actor = await nativeRunnerChatActor(f, auth);
      const active = await f.sendChatRun(actor.actor, {
        agentId: actor.agentId,
        prompt: "Cancel this whole run",
      });
      const claimed = await f.claimChatRun(actor.runnerGroup, active.runId);
      const token = auth.token({ scope: defaultScopes });
      const result = await cancelRun(
        token,
        letterCase === "uppercase" ? active.runId.toUpperCase() : active.runId,
      );
      expect(result).toMatchObject({
        runId: active.runId,
        status: "cancelled",
        alreadyCancelled: false,
      });
      await flushWaitUntilForTest();
      await expect(
        f.api.readRun(actor.actor, active.runId),
      ).resolves.toMatchObject({
        status: "cancelled",
      });
      await expect(
        f.api.readRunnerCancellation(
          claimed.claim.sandboxToken,
          active.runId,
          actor.runnerGroup,
        ),
      ).resolves.toMatchObject({ state: "present", mode: "cooperative" });
      await expect(cancelRun(token, active.runId)).resolves.toMatchObject({
        runId: active.runId,
        status: "cancelled",
        alreadyCancelled: true,
      });
      await flushWaitUntilForTest();
      expect(
        (
          await f.chat.listThreadEvents(actor.actor, active.threadId)
        ).events.filter((event) => {
          return (
            event.eventType === "run.cancelled" && event.runId === active.runId
          );
        }),
      ).toHaveLength(1);
    },
  );

  it("rejects cancellation of a completed run without rewriting its terminal state", async () => {
    const auth = await fixture();
    const f = createChatEventsFixture(context);
    const actor = await nativeRunnerChatActor(f, auth);
    const active = await f.sendChatRun(actor.actor, {
      agentId: actor.agentId,
      prompt: "Complete normally",
    });
    const claimed = await f.claimChatRun(actor.runnerGroup, active.runId);
    await f.completeChatRunOk(active.runId, claimed.sandboxHeaders);
    await flushWaitUntilForTest();
    const result = await callTool(
      auth.token({ scope: defaultScopes }),
      "cancel_run",
      { runId: active.runId },
    );
    expect(result.isError).toBeTruthy();
    structuredToolError(result);
    await expect(
      f.api.readRun(actor.actor, active.runId),
    ).resolves.toMatchObject({
      status: "completed",
    });
  });
});
