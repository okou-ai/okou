import { createHash, randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { chatEventRowSchema } from "@okouai/api-contracts/contracts/chat-event-rows";
import { testChatEventRetentionContract } from "@okouai/api-contracts/contracts/test-chat-event-retention";
import { createStore } from "ccstate";
import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { accept, testContext } from "../../../__tests__/test-context";
import { createAppWithRoutes } from "../../../app-factory-core";
import { setupApp } from "../../../__tests__/test-helpers";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { mcpServerRoutes } from "../mcp-server";
import { testChatEventRetentionRoutes } from "../test-chat-event-retention";
import { seedRetentionOutputEvent$ } from "../../../test-fixtures/chat-event-retention";
import { updateChatEventSnapshotHead } from "./helpers/runtime-state";
import {
  deleteFakeChatEventObject,
  installFakeChatEventR2,
  writeFakeChatEventObject,
  type RecordedChatEventPut,
} from "./helpers/fake-chat-event-r2";
import {
  resource,
  rpc,
  requestBody,
  protocolHeaders,
  createMcpServerTestApi,
} from "./helpers/mcp-server";
import { createMcpServerFixtures } from "./helpers/mcp-server-fixtures";

const context = testContext();
const { fixture, callTool, structuredToolError, getMessages, searchMessages } =
  createMcpServerTestApi(context);
const { messageFixture, snapshotMessages, threadFixture } =
  createMcpServerFixtures(context);

describe("MCP canonical message reads", () => {
  it("reads retained snapshot records after their source rows have been deleted", async () => {
    const f = await threadFixture();
    installFakeChatEventR2(context);
    const thread = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
    });
    // Infrastructure exception: public writes cannot backdate an event beyond
    // the retention worker's database-clock cutoff. Reuse its centralized old
    // event fixture; projection, snapshot, retention and MCP reads stay real.
    const eventId = await createStore().set(
      seedRetentionOutputEvent$,
      {
        chatThreadId: thread.id,
        content: "Retained assistant content",
        offsetMs: -60_000,
      },
      context.signal,
    );
    await snapshotMessages(thread.id);
    const retained = await accept(
      setupApp({ context, routes: testChatEventRetentionRoutes })(
        testChatEventRetentionContract,
      ).retain({ body: { chat_thread_ids: [thread.id] } }),
      [200],
    );
    expect(retained.body.deleted).toBe(1);
    const messages = await getMessages(f.auth.token(), { threadId: thread.id });
    expect(messages.messages).toMatchObject([
      {
        ref: { eventId },
        text: "Retained assistant content",
        role: "assistant",
      },
    ]);
  });

  it.each(["archive", "archive and tail"] as const)(
    "rejects ambiguous duplicate message identities across %s until the canonical snapshot is repaired",
    async (source) => {
      const f = await messageFixture();
      const puts: RecordedChatEventPut[] = [];
      installFakeChatEventR2(context, puts);
      const sent = await f.send("First archived message");
      onTestFinished(async () => {
        await f.chat.deleteThread(f.actor, sent.threadId);
      });
      await f.send("Second archived message", sent.threadId);
      await snapshotMessages(sent.threadId);
      const archive = puts.at(-1);
      if (!archive) {
        throw new Error("Expected an archive for duplicate identity coverage");
      }
      if (source === "archive and tail") {
        await f.send("Current database tail", sent.threadId);
      }
      const token = f.auth.token();
      const args = { threadId: sent.threadId };
      const before = await getMessages(token, args);
      const firstId = before.messages[0]?.ref.eventId;
      const duplicateId = before.messages.at(-1)?.ref.eventId;
      if (!firstId || !duplicateId || firstId === duplicateId) {
        throw new Error("Expected distinct canonical visible message IDs");
      }
      // Infrastructure exception: legacy persisted archives can contain IDs
      // that the canonical snapshot writer must normalize. Public writes do
      // not produce duplicate live primary keys, so install that historical
      // storage state using the shared fake R2 and snapshot-head fixture.
      const rows = gunzipSync(archive.body)
        .toString("utf8")
        .trimEnd()
        .split("\n")
        .map((line) => {
          return chatEventRowSchema.parse(JSON.parse(line));
        });
      const body = gzipSync(
        Buffer.from(
          rows
            .map((row) => {
              return `${JSON.stringify({
                ...row,
                id: row.id === firstId ? duplicateId : row.id,
              })}\n`;
            })
            .join(""),
        ),
      );
      const last = rows.at(-1);
      if (!last) {
        throw new Error("Expected a nonempty historical archive");
      }
      const key = `chat-events/${sent.threadId}/${last.seqId.toString()}-${createHash("sha256").update(body).digest("hex")}.ndjson.gz`;
      writeFakeChatEventObject(key, body);
      onTestFinished(async () => {
        await deleteFakeChatEventObject(key);
      });
      await updateChatEventSnapshotHead(context, sent.threadId, key);

      const failed = await callTool(token, "get_chat_messages", args);
      expect(failed.isError).toBeTruthy();
      structuredToolError(failed);
      expect(failed.content[0]?.text).toContain("could not be read completely");
      for (const message of before.messages) {
        expect(JSON.stringify(failed)).not.toContain(message.text);
      }

      await snapshotMessages(sent.threadId);
      const repaired = await getMessages(token, args);
      expect(
        repaired.messages.map((message) => {
          return message.text;
        }),
      ).toStrictEqual(
        before.messages.map((message) => {
          return message.text;
        }),
      );
      expect(
        new Set(
          repaired.messages.map((message) => {
            return message.ref.eventId;
          }),
        ).size,
      ).toBe(repaired.messages.length);
    },
  );

  it("reports missing, corrupt or oversized archives instead of returning an apparently complete tail", async () => {
    const f = await messageFixture();
    const puts: RecordedChatEventPut[] = [];
    installFakeChatEventR2(context, puts);
    const sent = await f.send("Required archived source");
    await snapshotMessages(sent.threadId);
    const archive = puts.at(-1);
    if (!archive) {
      throw new Error("Expected stored archive");
    }
    await f.send("Visible tail alone is incomplete", sent.threadId);
    for (const body of [
      Buffer.from("not a gzip archive"),
      Buffer.alloc(8 * 1024 * 1024 + 1),
      null,
    ]) {
      if (body === null) {
        await deleteFakeChatEventObject(archive.key);
      } else {
        writeFakeChatEventObject(archive.key, body);
      }
      const failed = await callTool(f.auth.token(), "get_chat_messages", {
        threadId: sent.threadId,
      });
      expect(failed.isError).toBeTruthy();
      structuredToolError(failed);
      expect(JSON.stringify(failed)).not.toContain(
        "Visible tail alone is incomplete",
      );
    }
    writeFakeChatEventObject(archive.key, archive.body);
    expect(
      (await getMessages(f.auth.token(), { threadId: sent.threadId })).messages,
    ).toHaveLength(2);
  });

  it.each(["decoded bytes", "event rows"] as const)(
    "rejects archives exceeding the %s budget with an explicit resource error",
    async (budget) => {
      const f = await messageFixture();
      installFakeChatEventR2(context);
      const sent = await f.send("Archive resource limits");
      onTestFinished(async () => {
        await f.chat.deleteThread(f.actor, sent.threadId);
      });
      await snapshotMessages(sent.threadId);
      // Infrastructure exception: imported historical archives may exceed the
      // MCP envelope. The normal archiver compacts control rows, so install a
      // checksum-valid old-object boundary through its centralized head fixture.
      const count = budget === "event rows" ? 50_001 : 1;
      const body =
        budget === "decoded bytes"
          ? Buffer.alloc(32 * 1024 * 1024 + 1, "a")
          : Buffer.from(
              Array.from({ length: count }, (_, index) => {
                return (
                  JSON.stringify({
                    id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
                    chatThreadId: sent.threadId,
                    runId: null,
                    revokesEventId: null,
                    contextType: null,
                    contextId: null,
                    runEventSequenceNumber: null,
                    runEventId: null,
                    seqId: index + 1,
                    createdAt: "2026-09-01T00:00:00.000Z",
                    eventType: "output.message",
                    payload: { content: "a" },
                  }) + "\n"
                );
              }).join(""),
            );
      const compressed = gzipSync(body);
      expect(compressed.length).toBeLessThan(8 * 1024 * 1024);
      const key = `chat-events/${sent.threadId}/${count}-${createHash("sha256").update(compressed).digest("hex")}.ndjson.gz`;
      writeFakeChatEventObject(key, compressed);
      onTestFinished(async () => {
        await deleteFakeChatEventObject(key);
      });
      await updateChatEventSnapshotHead(
        context,
        sent.threadId,
        key,
        budget === "event rows" ? count : undefined,
      );
      const result = await callTool(f.auth.token(), "get_chat_messages", {
        threadId: sent.threadId,
        limit: 1,
      });
      expect(result.isError).toBeTruthy();
      structuredToolError(result);
      expect(result.content[0]?.text).toMatch(/budget|limit/u);
    },
  );

  it("rejects a historical database payload exceeding the read budget even for a one-message page", async () => {
    const f = await threadFixture();
    const thread = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
    });
    onTestFinished(async () => {
      await f.chat.deleteThread(f.actor, thread.id);
    });
    // Infrastructure exception: old/imported persisted rows can exceed today's
    // HTTP body bound. Seed that storage state through the retention fixture,
    // then assert the real authenticated tool fails without leaking a prefix.
    await createStore().set(
      seedRetentionOutputEvent$,
      { chatThreadId: thread.id, content: "x".repeat(32 * 1024 * 1024) },
      context.signal,
    );
    const result = await callTool(f.auth.token(), "get_chat_messages", {
      threadId: thread.id,
      limit: 1,
    });
    expect(result.isError).toBeTruthy();
    structuredToolError(result);
    expect(result.content[0]?.text).toContain("32 MiB");
  });

  it.each(["get_chat_messages", "search_chat_messages"] as const)(
    "propagates %s cancellation into a partially consumed archive and permits a later fresh read",
    async (toolName) => {
      const f = await messageFixture();
      const puts: RecordedChatEventPut[] = [];
      installFakeChatEventR2(context, puts);
      const sent = await f.send("Read after cancellation");
      await snapshotMessages(sent.threadId);
      const archive = puts.at(-1);
      if (!archive) {
        throw new Error("Expected archive for cancellation");
      }
      const args =
        toolName === "get_chat_messages"
          ? { threadId: sent.threadId }
          : { threadId: sent.threadId, query: "cancellation" };
      const firstChunkRead = createDeferredPromise<void>(context.signal);
      const storageAborted = createDeferredPromise<void>(context.signal);
      const controller = new AbortController();
      onTestFinished(() => {
        controller.abort();
      });
      context.mocks.s3.send.mockImplementation(
        (command: unknown, options: unknown) => {
          const input = z
            .object({ input: z.object({ Key: z.string() }) })
            .parse(command).input;
          expect(input.Key).toBe(archive.key);
          const providerSignal = z
            .object({ abortSignal: z.instanceof(AbortSignal) })
            .parse(options).abortSignal;
          return Promise.resolve({
            ContentLength: archive.body.length,
            Body: {
              async *[Symbol.asyncIterator]() {
                yield archive.body.subarray(0, 8);
                const held = createDeferredPromise<void>(providerSignal);
                providerSignal.addEventListener(
                  "abort",
                  () => {
                    storageAborted.resolve();
                  },
                  { once: true },
                );
                firstChunkRead.resolve();
                await held.promise;
              },
            },
          });
        },
      );
      const app = createAppWithRoutes({
        routes: mcpServerRoutes,
        signal: context.signal,
      });
      const pending = settleIncludingAbort(
        (async () => {
          const response = await app.request(
            new Request(resource, {
              method: "POST",
              headers: {
                ...protocolHeaders(
                  f.auth.token(),
                  "tools/call",
                  true,
                  toolName,
                ),
                "Content-Type": "application/json",
              },
              body: JSON.stringify(
                requestBody("tools/call", true, {
                  name: toolName,
                  arguments: args,
                }),
              ),
              signal: controller.signal,
            }),
          );
          return { status: response.status, body: await response.text() };
        })(),
      );
      await Promise.race([
        firstChunkRead.promise,
        pending.then((result) => {
          throw new Error(
            `MCP request ended before reading its archive: ${JSON.stringify(result)}`,
          );
        }),
      ]);
      controller.abort();
      await storageAborted.promise;
      const result = await pending;
      if (result.ok) {
        if (result.value.status === 200) {
          expect(rpc(result.value.body)).toMatchObject({
            result: { isError: true },
          });
        } else {
          expect(result.value.status).toBeGreaterThanOrEqual(400);
        }
      } else {
        expect(result.error).toMatchObject({ name: "AbortError" });
      }
      installFakeChatEventR2(context);
      const fresh =
        toolName === "get_chat_messages"
          ? (await getMessages(f.auth.token(), args)).messages[0]?.text
          : (await searchMessages(f.auth.token(), args)).matches[0]?.excerpt
              .text;
      expect(fresh).toBe("Read after cancellation");
    },
  );

  it.each([
    { limit: 0 },
    { limit: 51 },
    { around: {} },
    { around: { seqId: 0 } },
    { cursor: "x".repeat(4097) },
  ])("rejects malformed message arguments %j", async (invalid) => {
    const auth = await fixture();
    expect(
      (
        await callTool(auth.token(), "get_chat_messages", {
          threadId: randomUUID(),
          ...invalid,
        })
      ).isError,
    ).toBeTruthy();
  });
});
