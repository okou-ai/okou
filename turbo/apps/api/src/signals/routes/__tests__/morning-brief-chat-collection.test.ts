import { randomUUID } from "node:crypto";

import { morningBriefChatCollectionPreviewContract } from "@okouai/api-contracts/contracts/morning-brief-chat-collection-preview";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createStore } from "ccstate";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now, nowDate } from "../../../lib/time";
import {
  bindMorningBriefThreadFixture,
  clearChatThreadProvenanceFixture,
  deleteSeededChatThreadFixture,
  excludeMorningBriefChatThreadFixture,
  markChatThreadReadFixture,
  renameChatThreadFixture,
  seedFinishedChatRunFixture$,
  seedMorningBriefChatMemberFixture,
  seedOrdinaryChatThreadFixture$,
  setUnsupportedChatThreadProvenanceFixture,
  startActiveChatRunFixture$,
  type MorningBriefChatMember,
} from "../../../test-fixtures/morning-brief-chat-collection";
import { morningBriefChatCollectionPreviewRoutes } from "../morning-brief-chat-collection-preview";
import { createRouteMocks } from "./helpers/route-test";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

/**
 * The unread Chat collection preview, through the route an operator invokes.
 *
 * Every case here is a statement about what the endpoint releases: which
 * threads may contribute content at all, what the envelope says about the
 * threads it refused, and that the endpoint does not exist in production.
 */
describe("POST /api/morning-brief/preview/chat-collection", () => {
  const context = testContext();
  const store = createStore();

  function client() {
    return setupApp({
      context,
      routes: morningBriefChatCollectionPreviewRoutes,
    })(morningBriefChatCollectionPreviewContract);
  }

  function authHeaders() {
    return { authorization: "Bearer clerk-session" };
  }

  function authenticate(member: {
    readonly orgId: string;
    readonly userId: string;
  }) {
    createRouteMocks(context).clerk.session(member.userId, member.orgId);
  }

  async function enableSimpleMorningBrief(member: {
    readonly orgId: string;
    readonly userId: string;
  }) {
    await updateFeatureSwitchesForUser(context, member, {
      [FeatureSwitchKey.SimpleMorningBrief]: true,
    });
  }

  function anchor() {
    return nowDate().toISOString();
  }

  async function collect(member: MorningBriefChatMember) {
    authenticate(member);
    const response = await accept(
      client().collect({
        headers: authHeaders(),
        body: { scheduledFor: anchor() },
      }),
      [200],
    );
    return response.body;
  }

  async function refuseCollection(member: MorningBriefChatMember) {
    authenticate(member);
    const response = await accept(
      client().collect({
        headers: authHeaders(),
        body: { scheduledFor: anchor() },
      }),
      [403],
    );
    return response.body;
  }

  /** A member with an enabled Morning Brief and the implementation switch on. */
  async function briefMember() {
    const member = await seedMorningBriefChatMemberFixture();
    await enableSimpleMorningBrief(member);
    return member;
  }

  async function seedUnreadThread(
    member: MorningBriefChatMember,
    args: {
      readonly title?: string;
      readonly prompt: string;
      readonly reply: string;
    },
  ) {
    const threadId = await store.set(
      seedOrdinaryChatThreadFixture$,
      { member, ...(args.title === undefined ? {} : { title: args.title }) },
      context.signal,
    );
    const run = await store.set(
      seedFinishedChatRunFixture$,
      {
        chatThreadId: threadId,
        prompt: args.prompt,
        reply: args.reply,
        thinking: "private reasoning that must never leave the server",
      },
      context.signal,
    );
    return { threadId, run };
  }

  it("does not exist in production, even with the switch on", async () => {
    const member = await briefMember();
    mockEnv("ENV", "production");
    authenticate(member);

    const response = await client().collect({
      headers: authHeaders(),
      body: { scheduledFor: anchor() },
    });

    expect(response.status).toBe(404);
  });

  it("rejects an unauthenticated caller", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });

    const response = await client().collect({
      headers: {},
      body: { scheduledFor: anchor() },
    });

    expect(response.status).toBe(401);
  });

  it("refuses a member whose implementation switch is off", async () => {
    const member = await seedMorningBriefChatMemberFixture();

    await expect(refuseCollection(member)).resolves.toMatchObject({
      error: { code: "FORBIDDEN" },
    });
  });

  it("refuses a member with no enabled Morning Brief", async () => {
    const member = await seedMorningBriefChatMemberFixture({ enabled: false });
    await enableSimpleMorningBrief(member);

    await expect(refuseCollection(member)).resolves.toMatchObject({
      error: { code: "FORBIDDEN" },
    });
  });

  it("rejects an anchor outside the collectable window", async () => {
    const member = await briefMember();
    authenticate(member);

    const response = await accept(
      client().collect({
        headers: authHeaders(),
        body: {
          scheduledFor: new Date(now() + 86_400_000).toISOString(),
        },
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
  });

  it("reports an empty inbox differently from unread threads that released nothing", async () => {
    const member = await briefMember();

    const empty = await collect(member);
    expect(empty).toMatchObject({
      source: "chat",
      result: "empty",
      coverage: "complete",
      items: [],
      skipped: [],
    });

    const { threadId } = await seedUnreadThread(member, {
      prompt: "historical prompt",
      reply: "historical reply",
    });
    await clearChatThreadProvenanceFixture(threadId);

    const unknown = await collect(member);
    expect(unknown).toMatchObject({
      result: "no-eligible-content",
      coverage: "partial",
      items: [],
      skipped: [{ threadId, reason: "unknown_thread_provenance" }],
    });
  });

  it("returns the visible messages of an unread ordinary thread", async () => {
    const member = await briefMember();
    const { threadId, run } = await seedUnreadThread(member, {
      title: "Okou Morning Brief",
      prompt: "what changed in the billing rollout?",
      reply: "The rollout paused on the invoice migration.",
    });

    const response = await collect(member);

    expect(response).toMatchObject({
      result: "collected",
      coverage: "complete",
      scope: { unreadCandidates: 1, inspectedThreads: 1 },
      skipped: [],
    });
    const [item] = response.items;
    expect(item).toMatchObject({
      threadId,
      agentId: member.agentId,
      provenance: "ordinary",
      terminal: { eventId: run.terminalEventId, runId: run.runId },
    });
    expect(item?.excerpts).toStrictEqual([
      expect.objectContaining({
        eventId: run.promptEventId,
        role: "user",
        text: "what changed in the billing rollout?",
      }),
      expect.objectContaining({
        eventId: run.outputEventId,
        role: "assistant",
        text: "The rollout paused on the invoice migration.",
      }),
    ]);
    // A Morning Brief title is not provenance, and thinking is not a message.
    expect(JSON.stringify(response)).not.toContain("private reasoning");
  });

  it("caps excerpt count and excerpt size, and says so", async () => {
    const member = await briefMember();
    const threadId = await store.set(
      seedOrdinaryChatThreadFixture$,
      { member },
      context.signal,
    );
    const oversized = "x".repeat(5000);
    await store.set(
      seedFinishedChatRunFixture$,
      {
        chatThreadId: threadId,
        prompt: "cap the reply",
        reply: oversized,
        extraReplies: Array.from({ length: 12 }, (_, index) => {
          return `follow-up ${index.toString()}`;
        }),
      },
      context.signal,
    );

    const response = await collect(member);

    const [item] = response.items;
    expect(item?.excerpts).toHaveLength(10);
    expect(item?.truncations).toStrictEqual(
      expect.arrayContaining(["excerpt_limit", "excerpt_bytes"]),
    );
    expect(response.coverage).toBe("partial");
    const cut = item?.excerpts.find((excerpt) => {
      return excerpt.text.startsWith("xxx");
    });
    expect(cut?.text.length).toBeLessThan(oversized.length);
    expect(
      new TextEncoder().encode(cut?.text ?? "").length,
    ).toBeLessThanOrEqual(4096);
  });

  it("releases nothing from the destination thread or any excluded thread", async () => {
    const member = await seedMorningBriefChatMemberFixture();
    await enableSimpleMorningBrief(member);
    const destination = await seedUnreadThread(member, {
      prompt: "yesterday's brief request",
      reply: "Yesterday's Morning Brief.",
    });
    await bindMorningBriefThreadFixture({
      orgId: member.orgId,
      userId: member.userId,
      workflowId: member.workflowId,
      chatThreadId: destination.threadId,
    });
    const excluded = await seedUnreadThread(member, {
      prompt: "an older brief thread",
      reply: "An older Morning Brief.",
    });
    await excludeMorningBriefChatThreadFixture({
      chatThreadId: excluded.threadId,
      userId: member.userId,
    });

    const response = await collect(member);

    expect(response.items).toStrictEqual([]);
    expect(response.result).toBe("no-eligible-content");
    // Both refusals are deliberate, so coverage is complete rather than partial.
    expect(response.coverage).toBe("complete");
    expect(response.skipped).toContainEqual({
      threadId: destination.threadId,
      reason: "destination_thread",
    });
    expect(response.skipped).toContainEqual({
      threadId: excluded.threadId,
      reason: "morning_brief_thread",
    });
  });

  it("skips a classification this version does not understand", async () => {
    const member = await briefMember();
    const { threadId } = await seedUnreadThread(member, {
      prompt: "future origin prompt",
      reply: "future origin reply",
    });
    await setUnsupportedChatThreadProvenanceFixture(threadId);

    const response = await collect(member);

    expect(response).toMatchObject({
      coverage: "partial",
      items: [],
      skipped: [{ threadId, reason: "unsupported_thread_provenance" }],
    });
  });

  it("selects neither a thread with a live Run nor one already read", async () => {
    const member = await briefMember();
    const { threadId: activeThreadId } = await seedUnreadThread(member, {
      prompt: "active prompt",
      reply: "active reply",
    });
    await store.set(startActiveChatRunFixture$, activeThreadId, context.signal);
    const read = await seedUnreadThread(member, {
      prompt: "read prompt",
      reply: "read reply",
    });
    await markChatThreadReadFixture({
      chatThreadId: read.threadId,
      lastReadAt: new Date(now() + 60_000),
    });

    const response = await collect(member);

    // Neither reaches the per-thread read, so neither is reported as refused:
    // unread selection already answers both, exactly as the sidebar does.
    expect(response).toMatchObject({
      result: "empty",
      coverage: "complete",
      items: [],
      skipped: [],
      scope: { unreadCandidates: 0, inspectedThreads: 0 },
    });
    expect(JSON.stringify(response)).not.toContain(activeThreadId);
    expect(JSON.stringify(response)).not.toContain(read.threadId);
  });

  it("keeps another member's unread Chat out of this member's collection", async () => {
    const shared = `org_${randomUUID()}`;
    const member = await briefMember();
    const neighbour = await seedMorningBriefChatMemberFixture({
      orgId: shared,
    });
    await seedUnreadThread(neighbour, {
      prompt: "neighbour prompt",
      reply: "neighbour reply",
    });
    const other = await seedMorningBriefChatMemberFixture({
      orgId: member.orgId,
    });
    await seedUnreadThread(other, {
      prompt: "same org, other member",
      reply: "other member reply",
    });

    const response = await collect(member);

    expect(response.result).toBe("empty");
    expect(response.items).toStrictEqual([]);
  });

  it("does not resurrect a thread that was deleted after selection", async () => {
    const member = await briefMember();
    const { threadId } = await seedUnreadThread(member, {
      prompt: "doomed prompt",
      reply: "doomed reply",
    });
    await renameChatThreadFixture({ chatThreadId: threadId, title: "Renamed" });
    await deleteSeededChatThreadFixture(threadId);

    const response = await collect(member);

    expect(response.result).toBe("empty");
    expect(response.items).toStrictEqual([]);
  });
});
