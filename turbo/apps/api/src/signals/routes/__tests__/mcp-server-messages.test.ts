import { randomUUID } from "node:crypto";
import { mcpGetChatMessagesOutputSchema } from "@okouai/api-contracts/contracts/mcp-chat-messages";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { now, withMockNowForTest } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { chatEventDisplayText } from "./helpers/chat-event";
import {
  installFakeChatEventR2,
  type RecordedChatEventPut,
} from "./helpers/fake-chat-event-r2";
import { createMcpServerTestApi } from "./helpers/mcp-server";
import { createMcpServerFixtures } from "./helpers/mcp-server-fixtures";

const context = testContext();
const { fixture, callTool, structuredToolError, getMessages } =
  createMcpServerTestApi(context);
const {
  messageFixture,
  snapshotMessages,
  threadFixture,
  nativeRunnerChatActor,
  assistantMessagesFixture,
  chatRunFixture,
} = createMcpServerFixtures(context);

describe("MCP canonical message reads", () => {
  it("pages latest and earlier messages with the default 20-message limit", async () => {
    const f = await assistantMessagesFixture(
      "Message 0",
      Array.from({ length: 22 }, (_, index) => {
        return `Message ${index + 1}`;
      }),
    );
    const token = f.auth.token();
    const canonical = await f.chat.listThreadEvents(f.actor, f.threadId);
    const latest = await getMessages(token, { threadId: f.threadId });
    expect(latest.messages).toHaveLength(20);
    expect(
      latest.messages.map((message) => {
        return message.text;
      }),
    ).toStrictEqual(
      Array.from({ length: 20 }, (_, index) => {
        return `Message ${index + 3}`;
      }),
    );
    expect(latest.newerCursor).toBeNull();
    expect(latest.olderCursor).not.toBeNull();
    const older = await getMessages(token, {
      threadId: f.threadId,
      cursor: latest.olderCursor,
    });
    expect(
      older.messages.map((message) => {
        return message.text;
      }),
    ).toStrictEqual(["Message 0", "Message 1", "Message 2"]);
    expect(older.olderCursor).toBeNull();
    const all = [...older.messages, ...latest.messages];
    expect(
      new Set(
        all.map((message) => {
          return message.ref.eventId;
        }),
      ).size,
    ).toBe(23);
    for (const message of all) {
      const original = canonical.events.find((event) => {
        return (
          (event.eventType === "input.prompt" ||
            event.eventType === "output.message") &&
          event.runId === f.runId &&
          chatEventDisplayText(event) === message.text
        );
      });
      expect(original).toBeDefined();
      expect(message.ref).toStrictEqual({
        threadId: f.threadId,
        eventId: original?.id,
        seqId: original?.seqId,
      });
      expect(new URL(message.url).pathname).toBe(`/chats/${f.threadId}`);
    }
  });

  it("preserves rejected input references and original timestamps across message pages", async () => {
    const f = await messageFixture();
    const sent = await f.send("Message 0");
    await f.send("Message 1", sent.threadId);
    const token = f.auth.token();
    const canonical = await f.chat.listThreadEvents(f.actor, sent.threadId);
    const args = { threadId: sent.threadId, limit: 1 };
    const latest = await getMessages(token, args);
    expect(latest.messages).toHaveLength(1);
    expect(latest.messages[0]?.text).toBe("Message 1");
    expect(latest.olderCursor).not.toBeNull();
    const older = await getMessages(token, {
      ...args,
      cursor: latest.olderCursor,
    });
    expect(older.messages).toHaveLength(1);
    expect(older.messages[0]?.text).toBe("Message 0");
    for (const message of [...older.messages, ...latest.messages]) {
      const original = canonical.events.find((event) => {
        return (
          event.eventType === "input.rejected" &&
          chatEventDisplayText(event) === message.text
        );
      });
      const initialInput = canonical.events.find((event) => {
        return (
          event.eventType === "input.prompt" &&
          event.userMessage.parts.some((part) => {
            return part.type === "text" && part.text === message.text;
          })
        );
      });
      expect(original).toBeDefined();
      expect(initialInput).toBeDefined();
      expect(message).toMatchObject({
        ref: {
          threadId: sent.threadId,
          eventId: original?.id,
          seqId: original?.seqId,
        },
        messageAt: expect.any(String),
        eventType: "input.rejected",
        role: "user",
        runId: null,
        textOffset: 0,
        textComplete: true,
        fileOffset: 0,
        filesComplete: true,
        nextContentCursor: null,
      });
      expect(Date.parse(message.messageAt)).toBe(
        Date.parse(initialInput?.createdAt ?? ""),
      );
      expect(new URL(message.url).pathname).toBe(`/chats/${sent.threadId}`);
    }
  });

  it("reads around either coordinate and traverses both directions without repeating the anchor", async () => {
    const f = await messageFixture();
    const sent = await f.send("Around 0");
    for (let index = 1; index < 9; index++) {
      await f.send(`Around ${index}`, sent.threadId);
    }
    const token = f.auth.token();
    const all = await getMessages(token, { threadId: sent.threadId });
    const anchor = all.messages[4];
    if (!anchor) {
      throw new Error("Expected middle message");
    }
    const filters = { threadId: sent.threadId, limit: 3 };
    const centered = await getMessages(token, {
      ...filters,
      around: { eventId: anchor.ref.eventId },
    });
    expect(
      centered.messages.map((message) => {
        return message.text;
      }),
    ).toStrictEqual(["Around 3", "Around 4", "Around 5"]);
    expect(
      (
        await getMessages(token, {
          ...filters,
          around: { seqId: anchor.ref.seqId },
        })
      ).messages,
    ).toStrictEqual(centered.messages);
    const older = await getMessages(token, {
      ...filters,
      cursor: centered.olderCursor,
    });
    const newer = await getMessages(token, {
      ...filters,
      cursor: centered.newerCursor,
    });
    expect([
      ...older.messages,
      ...centered.messages,
      ...newer.messages,
    ]).toStrictEqual(all.messages);
    for (const around of [
      { eventId: randomUUID() },
      { eventId: anchor.ref.eventId, seqId: anchor.ref.seqId + 1 },
    ]) {
      const failure = await callTool(token, "get_chat_messages", {
        ...filters,
        around,
      });
      expect(failure.isError).toBeTruthy();
      structuredToolError(failure);
    }
  });

  it("returns an empty owned thread without changing any read or lifecycle state", async () => {
    const f = await threadFixture();
    const thread = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
    });
    const before = await f.chat.readThread(f.actor, thread.id);
    await expect(
      getMessages(f.auth.token(), { threadId: thread.id }),
    ).resolves.toMatchObject({
      messages: [],
      olderCursor: null,
      newerCursor: null,
    });
    await expect(f.chat.readThread(f.actor, thread.id)).resolves.toStrictEqual(
      before,
    );
  });

  it("excludes private user context and private citation markup while retaining assistant work and artifact links", async () => {
    const auth = await fixture();
    const f = createChatEventsFixture(context);
    const actor = await nativeRunnerChatActor(f, auth);
    const sent = await f.sendChatRun(actor.actor, {
      agentId: actor.agentId,
      prompt: "Visible request",
      userMessage: {
        version: 1,
        parts: [
          { type: "text", text: "Visible request" },
          { type: "additional_info", text: "PRIVATE_USER_CONTEXT_CANARY" },
        ],
      },
    });
    const claimed = await f.claimChatRun(actor.runnerGroup, sent.runId);
    const artifact = `/artifacts/${randomUUID()}?view=original`;
    await f.webhooks.requestAgentEvents(
      {
        runId: sent.runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 0,
            message: {
              content: [
                { type: "text", text: "I have checked the source material." },
                { type: "thinking", thinking: "PRIVATE_THINKING_CANARY" },
              ],
            },
          },
          {
            type: "assistant",
            sequenceNumber: 1,
            message: {
              content: [
                {
                  type: "text",
                  text: `Download [the report](${artifact}).<oai-mem-citation><citation_entries>PRIVATE_CITATION_CANARY</citation_entries></oai-mem-citation>`,
                },
              ],
            },
          },
        ],
      },
      claimed.sandboxHeaders,
      [200],
    );
    await flushWaitUntilForTest();
    const page = await getMessages(auth.token(), {
      threadId: sent.threadId,
      runId: sent.runId,
    });
    expect(
      page.messages.map((message) => {
        return message.role;
      }),
    ).toStrictEqual(["user", "assistant", "assistant"]);
    expect(page.messages[1]?.text).toBe("I have checked the source material.");
    expect(page.messages[2]?.text).toContain(`[the report](${artifact})`);
    expect(JSON.stringify(page)).not.toContain("PRIVATE_");
    expect(JSON.stringify(page)).not.toContain("oai-mem-citation");
    const filters = { threadId: sent.threadId, runId: sent.runId, limit: 1 };
    const partial = await getMessages(auth.token(), filters);
    await f.webhooks.requestAgentEvents(
      {
        runId: sent.runId,
        events: [
          {
            type: "item.completed",
            sequenceNumber: 2,
            item: {
              id: "private-reasoning",
              type: "reasoning",
              text: "PRIVATE_REASONING_EVENT",
            },
          },
        ],
      },
      claimed.sandboxHeaders,
      [200],
    );
    await flushWaitUntilForTest();
    const before = await f.chat.readThread(actor.actor, sent.threadId);
    expect(
      (
        await getMessages(auth.token(), {
          ...filters,
          cursor: partial.olderCursor,
        })
      ).messages[0]?.text,
    ).toBe("I have checked the source material.");
    expect(
      page.messages.every((message) => {
        return message.runId === sent.runId;
      }),
    ).toBeTruthy();
    expect(
      (
        await getMessages(auth.token(), {
          threadId: sent.threadId,
          runId: randomUUID(),
        })
      ).messages,
    ).toStrictEqual([]);
    await expect(
      f.chat.readThread(actor.actor, sent.threadId),
    ).resolves.toStrictEqual(before);
    await f.cancelChatRun(actor.actor, sent.runId);
  });

  it("recalls queued input from the visible stream and invalidates its previous reference", async () => {
    const f = await chatRunFixture();
    const active = await createChatEventsFixture(context).sendChatRun(f.actor, {
      agentId: f.agent.agentId,
      prompt: "Active request",
    });
    await flushWaitUntilForTest();
    const queued = await f.chat.requestSendEvent(
      f.actor,
      {
        agentId: f.agent.agentId,
        threadId: active.threadId,
        prompt: `Recall this queued request\n${"😀".repeat(6000)}`,
      },
      [201],
    );
    expect(queued.status).toBe(201);
    const token = f.auth.token();
    const before = await getMessages(token, { threadId: active.threadId });
    const target = before.messages.find((message) => {
      return message.text.startsWith("Recall this queued request\n");
    });
    if (!target) {
      throw new Error("Expected queued visible input");
    }
    expect(target.nextContentCursor).not.toBeNull();
    await f.chat.requestSendEvent(
      f.actor,
      {
        agentId: f.agent.agentId,
        threadId: active.threadId,
        revokesEventId: target.ref.eventId,
      },
      [201],
    );
    const after = await getMessages(token, { threadId: active.threadId });
    expect(
      after.messages.some((message) => {
        return message.ref.eventId === target.ref.eventId;
      }),
    ).toBeFalsy();
    const staleContent = await callTool(token, "get_chat_messages", {
      threadId: active.threadId,
      cursor: target.nextContentCursor,
    });
    expect(staleContent.isError).toBeTruthy();
    structuredToolError(staleContent);
    expect(
      (
        await callTool(token, "get_chat_messages", {
          threadId: active.threadId,
          around: { eventId: target.ref.eventId },
        })
      ).isError,
    ).toBeTruthy();
    await f.runs.requestCancelRun(f.actor, active.runId, [200]);
    await flushWaitUntilForTest();
  });

  it("binds cursors to the owner, organization, thread, page size and filters, with absolute expiry", async () => {
    const f = await messageFixture();
    const sent = await f.send("Cursor first");
    await f.send("Cursor second", sent.threadId);
    const args = { threadId: sent.threadId, limit: 1 };
    const page = await getMessages(f.auth.token(), args);
    const cursor = page.olderCursor;
    if (!cursor) {
      throw new Error("Expected older cursor");
    }
    const other = await f.send("Other thread");
    for (const invalid of [
      { ...args, cursor: `${cursor[0] === "A" ? "B" : "A"}${cursor.slice(1)}` },
      { ...args, cursor, limit: 2 },
      { ...args, cursor, runId: randomUUID() },
      { ...args, cursor, threadId: other.threadId },
      { ...args, cursor, around: { seqId: 1 } },
    ]) {
      const failed = await callTool(
        f.auth.token(),
        "get_chat_messages",
        invalid,
      );
      expect(failed.isError).toBeTruthy();
      structuredToolError(failed);
    }
    await expect(
      getMessages(f.auth.token(), { ...args, cursor }),
    ).resolves.toMatchObject({ messages: [{ text: "Cursor first" }] });
    const longToken = f.auth.token({
      exp: Math.floor((now() + 2 * 24 * 60 * 60 * 1000) / 1000),
    });
    await withMockNowForTest(now() + 24 * 60 * 60 * 1000, async () => {
      expect(
        (await callTool(longToken, "get_chat_messages", { ...args, cursor }))
          .isError,
      ).toBeTruthy();
      expect((await getMessages(longToken, args)).messages).toHaveLength(1);
    });
  });

  it("does not reveal foreign messages through either references or a signed cursor", async () => {
    const f = await messageFixture();
    const sent = await f.send("Owned message");
    await f.send("Another owned message", sent.threadId);
    const token = f.auth.token();
    const args = { threadId: sent.threadId, limit: 1 };
    const cursor = (await getMessages(token, args)).olderCursor;
    const missing = await callTool(token, "get_chat_messages", {
      threadId: randomUUID(),
    });
    for (const actor of [
      f.bdd.user({ orgId: f.auth.orgId }),
      f.bdd.user({ userId: f.auth.userId }),
    ]) {
      const agent = await f.bdd.createAgent(actor, {
        displayName: "Foreign messages",
        visibility: "private",
      });
      const thread = await f.chat.createThread(actor, {
        agentId: agent.agentId,
      });
      await expect(
        callTool(token, "get_chat_messages", { threadId: thread.id }),
      ).resolves.toStrictEqual(missing);
      if (!actor.orgId) {
        throw new Error("Expected organization");
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
      const denied = await callTool(
        f.auth.token({ sub: actor.userId, org_id: actor.orgId }),
        "get_chat_messages",
        { ...args, cursor },
      );
      expect(denied.isError).toBeTruthy();
      expect(JSON.stringify(denied)).not.toContain("Owned message");
    }
  });

  it("invalidates pagination on visible appends while preserving cursors through metadata-only changes", async () => {
    const f = await messageFixture();
    const sent = await f.send("View first");
    await f.send("View second", sent.threadId);
    const token = f.auth.token();
    const args = { threadId: sent.threadId, limit: 1 };
    const page = await getMessages(token, args);
    await f.chat.renameThread(f.actor, sent.threadId, "Metadata only");
    expect(
      (await getMessages(token, { ...args, cursor: page.olderCursor }))
        .messages[0]?.text,
    ).toBe("View first");
    await f.send("Visible append", sent.threadId);
    const changed = await callTool(token, "get_chat_messages", {
      ...args,
      cursor: page.olderCursor,
    });
    expect(changed.isError).toBeTruthy();
    structuredToolError(changed);
    expect((await getMessages(token, args)).messages[0]?.text).toBe(
      "Visible append",
    );
  });

  it("delivers long Unicode text without loss through content cursors, even after unrelated appends", async () => {
    const f = await messageFixture();
    const text = "𠮷😀中文é\n".repeat(12_000);
    const sent = await f.send(text);
    const token = f.auth.token();
    const args = { threadId: sent.threadId, limit: 1 };
    const first = await getMessages(token, args);
    const initial = first.messages[0];
    if (!initial?.nextContentCursor) {
      throw new Error("Expected content continuation");
    }
    expect(initial.textComplete).toBeFalsy();
    expect(initial.textOffset).toBe(0);
    await f.send("Unrelated appended message", sent.threadId);
    let combined = initial.text;
    let cursor: string | null = initial.nextContentCursor;
    let segments = 1;
    while (cursor !== null) {
      expect(segments++).toBeLessThan(100);
      const page = await getMessages(token, { ...args, cursor });
      expect(page.messages).toHaveLength(1);
      const segment = page.messages[0];
      if (!segment) {
        throw new Error("Expected continuation segment");
      }
      expect(segment.ref).toStrictEqual(initial.ref);
      expect(segment.text).not.toContain("\uFFFD");
      expect(segment.textOffset).toBeGreaterThan(0);
      combined += segment.text;
      cursor = segment.nextContentCursor;
      if (cursor === null) {
        expect(segment.textComplete).toBeTruthy();
      }
    }
    expect(combined).toBe(text);
  });

  it("keeps byte-bounded pages complete through continuation and retains the requested middle anchor", async () => {
    const f = await messageFixture();
    const sent = await f.send(`Message 0\n${"😀".repeat(6000)}`);
    for (let index = 1; index < 12; index++) {
      await f.send(`Message ${index}\n${"😀".repeat(6000)}`, sent.threadId);
    }
    const token = f.auth.token();
    const args = { threadId: sent.threadId, limit: 50 };
    let page = await getMessages(token, args);
    expect(page.messages.length).toBeLessThan(12);
    const messages = [...page.messages];
    while (page.olderCursor !== null) {
      expect(messages.length).toBeLessThan(12);
      const result = await callTool(token, "get_chat_messages", {
        ...args,
        cursor: page.olderCursor,
      });
      expect(result.isError).not.toBeTruthy();
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(
        512 * 1024,
      );
      page = mcpGetChatMessagesOutputSchema.parse(result.structuredContent);
      messages.unshift(...page.messages);
    }
    expect(
      messages.map((message) => {
        return message.text.split("\n")[0];
      }),
    ).toStrictEqual(
      Array.from({ length: 12 }, (_, index) => {
        return `Message ${index}`;
      }),
    );
    expect(
      new Set(
        messages.map((message) => {
          return message.ref.eventId;
        }),
      ).size,
    ).toBe(12);
    for (const message of messages) {
      expect(message.textComplete).toBeFalsy();
      expect(message.nextContentCursor).not.toBeNull();
    }
    const anchor = messages[5];
    if (!anchor) {
      throw new Error("Expected middle large message");
    }
    const centeredResult = await callTool(token, "get_chat_messages", {
      ...args,
      around: { eventId: anchor.ref.eventId },
    });
    expect(centeredResult.isError).not.toBeTruthy();
    expect(Buffer.byteLength(JSON.stringify(centeredResult))).toBeLessThan(
      512 * 1024,
    );
    const centered = mcpGetChatMessagesOutputSchema.parse(
      centeredResult.structuredContent,
    );
    expect(centered.messages.length).toBeLessThan(12);
    expect(
      centered.messages.map((message) => {
        return message.ref.eventId;
      }),
    ).toContain(anchor.ref.eventId);
    expect(
      centered.olderCursor !== null || centered.newerCursor !== null,
    ).toBeTruthy();
  });

  it("continues file metadata without dropping original or annotated identities", async () => {
    const f = await messageFixture();
    const files = Array.from({ length: 75 }, (_, index) => {
      return {
        id: randomUUID(),
        filename: `source-${index}.png`,
        size: 42,
      };
    });
    const annotatedFileId = randomUUID();
    f.chat.mockCompletedUploadObjects(f.actor, [
      ...files,
      { id: annotatedFileId, filename: "annotated.png", size: 42 },
    ]);
    const parts: UserMessageDocument["parts"] = files.map((file, index) => {
      return {
        type: "file",
        fileId: file.id,
        filenameSnapshot: file.filename,
        contentType: "image/png",
        ...(index === 0 ? { annotatedFileId, annotations: { marks: [] } } : {}),
      };
    });
    const sent = await f.send("Review these images", undefined, {
      version: 1,
      parts: [{ type: "text", text: "Review these images" }, ...parts],
    });
    const args = { threadId: sent.threadId, limit: 1 };
    const token = f.auth.token();
    let page = await getMessages(token, args);
    const collected: {
      fileId: string;
      filename: string;
      contentType: string;
      annotatedFileId?: string;
    }[] = [];
    let segments = 0;
    for (;;) {
      expect(segments++).toBeLessThan(100);
      const message = page.messages[0];
      if (!message) {
        throw new Error("Expected file segment");
      }
      expect(message.fileOffset).toBe(collected.length);
      collected.push(...message.files);
      if (message.nextContentCursor === null) {
        expect(message.filesComplete).toBeTruthy();
        break;
      }
      page = await getMessages(token, {
        ...args,
        cursor: message.nextContentCursor,
      });
    }
    expect(segments).toBeGreaterThan(1);
    expect(collected).toStrictEqual(
      files.map((file, index) => {
        return {
          fileId: file.id,
          filename: file.filename,
          contentType: "image/png",
          ...(index === 0 ? { annotatedFileId } : {}),
        };
      }),
    );
  });

  it("preserves pages when canonical history moves into a snapshot and merges its PostgreSQL tail", async () => {
    const f = await messageFixture();
    const puts: RecordedChatEventPut[] = [];
    installFakeChatEventR2(context, puts);
    const sent = await f.send("Archived first");
    await f.send("Archived second", sent.threadId);
    const args = { threadId: sent.threadId, limit: 1 };
    const token = f.auth.token();
    const page = await getMessages(token, args);
    await snapshotMessages(sent.threadId);
    expect(puts.length).toBeGreaterThan(0);
    expect(
      (await getMessages(token, { ...args, cursor: page.olderCursor }))
        .messages[0]?.text,
    ).toBe("Archived first");
    await f.send("PostgreSQL tail", sent.threadId);
    const all = await getMessages(token, { threadId: sent.threadId });
    expect(
      all.messages.map((message) => {
        return message.text;
      }),
    ).toStrictEqual(["Archived first", "Archived second", "PostgreSQL tail"]);
    expect(
      new Set(
        all.messages.map((message) => {
          return message.ref.eventId;
        }),
      ).size,
    ).toBe(3);
  });

  it("continues text and individually bounded file metadata when their combined segment is oversized", async () => {
    const f = await messageFixture();
    const fileId = randomUUID();
    const filename = "f".repeat(60_000);
    const text = "Read this file. ".repeat(600);
    f.chat.mockCompletedUploadObject(f.actor, fileId, "source.png", 42);
    const sent = await f.send(text, undefined, {
      version: 1,
      parts: [
        { type: "text", text },
        {
          type: "file",
          fileId,
          filenameSnapshot: filename,
          contentType: "image/png",
        },
      ],
    });
    const args = { threadId: sent.threadId, limit: 1 };
    const token = f.auth.token();
    let page = await getMessages(token, args);
    let collectedText = "";
    const collectedFiles: { fileId: string; filename: string }[] = [];
    let segments = 0;
    for (;;) {
      expect(segments++).toBeLessThan(20);
      const message = page.messages[0];
      if (!message) {
        throw new Error("Expected a recoverable text/file segment");
      }
      expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThanOrEqual(
        64 * 1024,
      );
      expect(message.textOffset).toBe(collectedText.length);
      expect(message.fileOffset).toBe(collectedFiles.length);
      expect(message.text.length + message.files.length).toBeGreaterThan(0);
      collectedText += message.text;
      collectedFiles.push(...message.files);
      if (message.nextContentCursor === null) {
        expect(message.textComplete).toBeTruthy();
        expect(message.filesComplete).toBeTruthy();
        break;
      }
      page = await getMessages(token, {
        ...args,
        cursor: message.nextContentCursor,
      });
    }
    expect(segments).toBeGreaterThan(1);
    expect(collectedText).toBe(`${text}\n\n[File: ${filename}]`);
    expect(collectedFiles).toStrictEqual([
      { fileId, filename, contentType: "image/png" },
    ]);
  });

  it("reports oversized file metadata explicitly without losing content behind a missing continuation", async () => {
    const f = await messageFixture();
    const fileId = randomUUID();
    f.chat.mockCompletedUploadObject(f.actor, fileId, "source.png", 42);
    const sent = await f.send("Large file metadata", undefined, {
      version: 1,
      parts: [
        { type: "text", text: "Large file metadata" },
        {
          type: "file",
          fileId,
          filenameSnapshot: "📎".repeat(20_000),
          contentType: "image/png",
        },
      ],
    });
    const result = await callTool(f.auth.token(), "get_chat_messages", {
      threadId: sent.threadId,
    });
    expect(result.isError).toBeTruthy();
    structuredToolError(result);
    expect(result.content[0]?.text).toContain("metadata");
  });
});
