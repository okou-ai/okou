import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { chatEventRowSchema } from "@okouai/api-contracts/contracts/chat-event-rows";
import { testChatEventRetentionContract } from "@okouai/api-contracts/contracts/test-chat-event-retention";
import { createStore } from "ccstate";
import { describe, expect, it, onTestFinished } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { testChatEventRetentionRoutes } from "../test-chat-event-retention";
import { seedRetentionOutputEvent$ } from "../../../test-fixtures/chat-event-retention";
import {
  rejectSearchablePromptFixture,
  updateChatSearchSourceThreadFixture,
} from "../../../test-fixtures/chat-event-search";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { updateChatEventSnapshotHead } from "./helpers/runtime-state";
import {
  deleteFakeChatEventObject,
  installFakeChatEventR2,
  writeFakeChatEventObject,
  type RecordedChatEventPut,
} from "./helpers/fake-chat-event-r2";
import { createMcpServerTestApi } from "./helpers/mcp-server";
import { createMcpServerFixtures } from "./helpers/mcp-server-fixtures";

const context = testContext();
const { fixture, callTool, structuredToolError, getMessages, searchMessages } =
  createMcpServerTestApi(context);
const {
  projectSearchMessages,
  messageFixture,
  snapshotMessages,
  threadFixture,
  nativeRunnerChatActor,
  chatRunFixture,
} = createMcpServerFixtures(context);

describe("MCP message search", () => {
  it("never returns stale revoked or replaced inputs before the index catches up", async () => {
    const f = await chatRunFixture();
    const { runId, threadId } = await createChatEventsFixture(
      context,
    ).sendChatRun(f.actor, {
      agentId: f.agent.agentId,
      prompt: "Active unrelated task",
    });
    for (const prompt of [
      "staleneedle recall",
      "staleneedle replace",
      "staleneedle unchanged",
    ]) {
      await f.chat.requestSendEvent(
        f.actor,
        { agentId: f.agent.agentId, threadId, prompt },
        [201],
      );
    }
    await projectSearchMessages([threadId]);
    const token = f.auth.token();
    const original = await searchMessages(token, { query: "staleneedle" });
    expect(original.matches).toHaveLength(3);
    const recalled = original.matches.find((match) => {
      return match.excerpt.text.endsWith("recall");
    });
    const replaced = original.matches.find((match) => {
      return match.excerpt.text.endsWith("replace");
    });
    if (!recalled || !replaced) {
      throw new Error("Expected both queued search targets");
    }
    await f.chat.requestSendEvent(
      f.actor,
      {
        agentId: f.agent.agentId,
        threadId,
        revokesEventId: recalled.ref.eventId,
      },
      [201],
    );
    // Infrastructure exception: normal sends cannot author an arbitrary
    // internal replacement. Reuse the canonical writer fixture to reconstruct
    // the legacy replacement state that can outlive its indexed source row.
    await rejectSearchablePromptFixture({
      chatThreadId: threadId,
      eventId: replaced.ref.eventId,
      text: "replacementneedle current text",
    });
    const stale = await searchMessages(token, { query: "staleneedle" });
    expect(
      stale.matches.map(({ excerpt }) => {
        return excerpt.text;
      }),
    ).toStrictEqual(["staleneedle unchanged"]);
    expect(stale.nextCursor).toBeNull();
    expect(
      (await searchMessages(token, { query: "replacementneedle" })).matches,
    ).toStrictEqual([]);
    await projectSearchMessages([threadId]);
    const current = await searchMessages(token, { query: "replacementneedle" });
    expect(current.matches).toHaveLength(1);
    expect(current.matches[0]?.ref.eventId).not.toBe(replaced.ref.eventId);

    // Releasing this run can pick the remaining input. Settle that work
    // before test teardown clears its Runner and storage configuration.
    await f.runs.requestCancelRun(f.actor, runId, [200]);
    await flushWaitUntilForTest();
  });

  it("finds retained source messages with valid context references and fails explicitly on a missing archive", async () => {
    const f = await threadFixture();
    const puts: RecordedChatEventPut[] = [];
    installFakeChatEventR2(context, puts);
    const thread = await f.chat.createThread(f.actor, {
      agentId: f.agent.agentId,
    });
    // Infrastructure exception: public writes cannot backdate the event beyond
    // the retention worker's database-clock cutoff. All projection, archival,
    // retention, search and context reads below use their real HTTP routes.
    const eventId = await createStore().set(
      seedRetentionOutputEvent$,
      {
        chatThreadId: thread.id,
        content: "retainedsearchneedle canonical answer",
        offsetMs: -60_000,
      },
      context.signal,
    );
    await snapshotMessages(thread.id);
    const retained = await accept(
      setupApp({ context, routes: testChatEventRetentionRoutes })(
        testChatEventRetentionContract,
      ).retain({
        body: { chat_thread_ids: [thread.id] },
      }),
      [200],
    );
    expect(retained.body.deleted).toBe(1);
    const token = f.auth.token();
    const args = { query: "retainedsearchneedle" };
    const page = await searchMessages(token, args);
    expect(page.matches).toMatchObject([
      {
        ref: { eventId, threadId: thread.id },
        role: "assistant",
        excerpt: { text: "retainedsearchneedle canonical answer" },
      },
    ]);
    const match = page.matches[0];
    const archive = puts.at(-1);
    if (!match || !archive) {
      throw new Error("Expected a retained match and its canonical archive");
    }
    expect(
      (
        await getMessages(token, {
          threadId: thread.id,
          around: { eventId, seqId: match.ref.seqId },
          limit: 1,
        })
      ).messages[0]?.ref,
    ).toStrictEqual(match.ref);
    await deleteFakeChatEventObject(archive.key);
    const missing = await callTool(token, "search_chat_messages", args);
    expect(missing.isError).toBeTruthy();
    structuredToolError(missing);
    expect(JSON.stringify(missing)).not.toContain("canonical answer");
  });

  it("enforces one aggregate history budget across individually readable search matches", async () => {
    const f = await messageFixture();
    const puts: RecordedChatEventPut[] = [];
    installFakeChatEventR2(context, puts);
    const threadIds: string[] = [];
    for (let index = 0; index < 2; index++) {
      const text = `aggregatebudgetneedle VISIBLE_EXCERPT_CANARY_${index}`;
      const sent = await f.send(text);
      threadIds.push(sent.threadId);
      onTestFinished(async () => {
        await f.chat.deleteThread(f.actor, sent.threadId);
      });
      await snapshotMessages(sent.threadId);
      const archive = puts.at(-1);
      if (!archive) {
        throw new Error("Expected a genuine indexed message archive");
      }
      // Infrastructure exception: historical imported archives can exceed the
      // current HTTP envelope. Preserve the actual indexed event coordinates
      // and visible text, adding only private context that is never searchable.
      const rows = gunzipSync(archive.body)
        .toString("utf8")
        .trimEnd()
        .split("\n")
        .map((line) => {
          return chatEventRowSchema.parse(JSON.parse(line));
        });
      const expanded = Buffer.from(
        rows
          .map((row) => {
            return `${JSON.stringify(
              row.eventType === "input.rejected"
                ? {
                    ...row,
                    payload: {
                      ...row.payload,
                      userMessage: {
                        version: 1,
                        parts: [
                          { type: "text", text },
                          {
                            type: "additional_info",
                            text: "x".repeat(17 * 1024 * 1024),
                          },
                        ],
                      },
                    },
                  }
                : row,
            )}\n`;
          })
          .join(""),
      );
      expect(expanded.length).toBeGreaterThan(17 * 1024 * 1024);
      expect(expanded.length).toBeLessThan(18 * 1024 * 1024);
      const body = gzipSync(expanded);
      expect(body.length).toBeLessThan(8 * 1024 * 1024);
      const last = rows.at(-1);
      if (!last) {
        throw new Error("Expected the original archive's terminal coordinate");
      }
      const key = `chat-events/${sent.threadId}/${last.seqId.toString()}-${createHash("sha256").update(body).digest("hex")}.ndjson.gz`;
      writeFakeChatEventObject(key, body);
      onTestFinished(async () => {
        await deleteFakeChatEventObject(key);
      });
      await updateChatEventSnapshotHead(context, sent.threadId, key);
    }
    const token = f.auth.token();
    const query = "aggregatebudgetneedle";
    for (const threadId of threadIds) {
      const narrow = await searchMessages(token, { query, threadId });
      expect(narrow.matches).toHaveLength(1);
      expect(narrow.matches[0]?.ref.threadId).toBe(threadId);
      expect(narrow.matches[0]?.excerpt.text).toContain(
        "VISIBLE_EXCERPT_CANARY_",
      );
    }
    const combined = await callTool(token, "search_chat_messages", { query });
    expect(combined.isError).toBeTruthy();
    structuredToolError(combined);
    expect(combined.content[0]?.text).toMatch(/budget|limit/u);
    expect(JSON.stringify(combined)).not.toContain("VISIBLE_EXCERPT_CANARY_");
  });

  it("continues after a full scan of lexical false positives without hiding an older exact match", async () => {
    const auth = await fixture();
    const f = createChatEventsFixture(context);
    const actor = await nativeRunnerChatActor(f, auth);
    const query = "scanbudgetneedle 上海滩";
    const sent = await f.sendChatRun(actor.actor, {
      agentId: actor.agentId,
      prompt: `${query} visible older input`,
    });
    onTestFinished(async () => {
      await f.cancelChatRun(actor.actor, sent.runId);
    });
    const token = auth.token();
    const claimed = await f.claimChatRun(actor.runnerGroup, sent.runId);
    const before = await getMessages(token, { threadId: sent.threadId });
    expect(before.messages).toHaveLength(1);
    const visible = before.messages[0];
    if (!visible) {
      throw new Error("Expected the canonical older input reference");
    }
    // One runner batch creates 100 indexed candidates with the same CJK
    // bigrams; canonical phrase verification rejects their disconnected text.
    await f.webhooks.requestAgentEvents(
      {
        runId: sent.runId,
        events: Array.from({ length: 100 }, (_, sequenceNumber) => {
          return {
            type: "assistant" as const,
            sequenceNumber,
            message: {
              content: [
                {
                  type: "text" as const,
                  text: `scanbudgetneedle 上海 海滩 candidate ${sequenceNumber}`,
                },
              ],
            },
          };
        }),
      },
      claimed.sandboxHeaders,
      [200],
    );
    await flushWaitUntilForTest();
    await projectSearchMessages([sent.threadId]);
    const args = { query, limit: 1 };
    const first = await searchMessages(token, args);
    expect(first.matches).toStrictEqual([]);
    expect(first.scanLimited).toBeTruthy();
    expect(first.nextCursor).not.toBeNull();
    const next = await searchMessages(token, {
      ...args,
      cursor: first.nextCursor,
    });
    expect(next).toMatchObject({
      matches: [
        {
          ref: visible.ref,
          excerpt: { text: `${query} visible older input` },
        },
      ],
      scanLimited: false,
      nextCursor: null,
    });
  });

  it("rechecks current ownership and Agent organization when indexed labels are stale", async () => {
    const f = await messageFixture();
    const ownerChanged = await f.send("transfersearchneedle owner moved");
    const agentChanged = await f.send("transfersearchneedle Agent moved");
    await projectSearchMessages([ownerChanged.threadId, agentChanged.threadId]);
    const token = f.auth.token();
    expect(
      (await searchMessages(token, { query: "transfersearchneedle" })).matches,
    ).toHaveLength(2);
    const peer = f.bdd.user({ orgId: f.auth.orgId });
    const otherOrganization = f.bdd.user({ userId: f.auth.userId });
    const otherAgent = await f.bdd.createAgent(otherOrganization, {
      displayName: "Agent from another organization",
      visibility: "private",
    });
    // Infrastructure exception: no product writer currently transfers thread
    // ownership or Agent identity. This existing fixture models historical or
    // future transfers without letting stale projected labels grant access.
    await updateChatSearchSourceThreadFixture({
      chatThreadId: ownerChanged.threadId,
      userId: peer.userId,
      agentId: f.agent.agentId,
    });
    await updateChatSearchSourceThreadFixture({
      chatThreadId: agentChanged.threadId,
      userId: f.auth.userId,
      agentId: otherAgent.agentId,
    });
    for (const args of [
      { query: "transfersearchneedle" },
      { query: "transfersearchneedle", threadId: ownerChanged.threadId },
      { query: "transfersearchneedle", threadId: agentChanged.threadId },
      { query: "transfersearchneedle", agentId: f.agent.agentId },
    ]) {
      expect((await searchMessages(token, args)).matches).toStrictEqual([]);
    }
  });
});
