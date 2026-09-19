import { randomUUID } from "node:crypto";

import { agentsMainContract } from "@okouai/api-contracts/contracts/agents";
import {
  MORNING_BRIEF_CHAT_COLLECTION_BUDGET,
  morningBriefChatCollectionPreviewContract,
} from "@okouai/api-contracts/contracts/morning-brief-chat-collection-preview";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createStore } from "ccstate";
import { onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import {
  clearMockMonotonicNow,
  mockMonotonicNow,
  mockNow,
  monotonicNow,
  now,
  nowDate,
} from "../../../lib/time";
import {
  barrierQueryBinds,
  barrierQueryText,
  closeErasureSubjectFixture,
  removeErasureSubjectsFixture,
  withDatabaseTransactionBarrierFixture,
} from "../../../test-fixtures/account-erasure-subject";
import {
  bindMorningBriefThreadFixture,
  clearChatThreadProvenanceFixture,
  countMorningBriefChatWritesFixture,
  deleteSeededChatThreadFixture,
  excludeMorningBriefChatThreadFixture,
  holdActiveRunReadFixture,
  holdAgentRowFixture,
  holdChatCandidateDiscoveryFixture,
  holdChatThreadReadBarrierFixture,
  holdMorningBriefChatMembershipLookupFixture,
  holdMorningBriefOwnershipReadFixture,
  markChatThreadReadFixture,
  renameChatThreadFixture,
  replaceMorningBriefAutomationFixture,
  replaceMorningBriefInstallationFixture,
  restrictAgentAccessFixture,
  seedFinishedChatRunFixture$,
  seedMorningBriefChatMemberFixture,
  seedOrdinaryChatThreadFixture$,
  setUnsupportedChatThreadProvenanceFixture,
  startActiveChatRunFixture$,
  type MorningBriefChatMember,
} from "../../../test-fixtures/morning-brief-chat-collection";
import { agentsRoutes } from "../agents";
import { morningBriefChatCollectionPreviewRoutes } from "../morning-brief-chat-collection-preview";
import { createRouteMocks } from "./helpers/route-test";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
} from "./helpers/org-membership";

/**
 * The unread Chat collection preview, through the route an operator invokes.
 *
 * Every case here is a statement about what the endpoint releases: which
 * threads may contribute content at all, what the envelope says about the
 * threads it refused, what happens to an admitted request whose authority is
 * withdrawn underneath it, and that the endpoint does not exist in production.
 */
describe("POST /api/morning-brief/preview/chat-collection", () => {
  const context = testContext();
  const store = createStore();

  function client(options: { readonly signal?: AbortSignal } = {}) {
    return setupApp({
      context,
      routes: morningBriefChatCollectionPreviewRoutes,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
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

  /**
   * Seed the member and the live Clerk membership their collection admits on.
   *
   * Request authentication answers from the durable member row, so without this
   * the endpoint would still authenticate while the collection itself could not
   * resolve the generation it has to pin.
   */
  async function seedMember(
    options: {
      readonly orgId?: string;
      readonly enabled?: boolean;
      readonly membershipId?: string;
    } = {},
  ) {
    const member = await seedMorningBriefChatMemberFixture({
      ...(options.orgId === undefined ? {} : { orgId: options.orgId }),
      ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
    });
    await store.set(
      seedOrgMembership$,
      {
        orgId: member.orgId,
        userId: member.userId,
        ...(options.membershipId === undefined
          ? {}
          : { membershipId: options.membershipId }),
      },
      context.signal,
    );
    return member;
  }

  function collectRequest(
    member: MorningBriefChatMember,
    options: { readonly signal?: AbortSignal } = {},
  ) {
    authenticate(member);
    return client(options).collect({
      headers: authHeaders(),
      body: { scheduledFor: anchor() },
    });
  }

  async function collect(member: MorningBriefChatMember) {
    const response = await accept(collectRequest(member), [200]);
    return response.body;
  }

  async function refuseCollection(member: MorningBriefChatMember) {
    const response = await accept(collectRequest(member), [403]);
    return response.body;
  }

  /** A member with an enabled Morning Brief and the implementation switch on. */
  async function briefMember(
    options: {
      readonly orgId?: string;
      readonly membershipId?: string;
    } = {},
  ) {
    const member = await seedMember(options);
    await enableSimpleMorningBrief(member);
    return member;
  }

  /** Project one dormant lifecycle closure and retire only that owned row. */
  function closeSubject(subject: {
    readonly subjectKind: "organization" | "user";
    readonly subjectId: string;
  }) {
    const closing = closeErasureSubjectFixture(subject);
    onTestFinished(async () => {
      const { jobId } = await closing;
      await removeErasureSubjectsFixture([jobId]);
    });
    return closing;
  }

  async function seedUnreadThread(
    member: MorningBriefChatMember,
    args: {
      readonly title?: string;
      readonly prompt: string;
      readonly reply: string;
      readonly agentId?: string;
      readonly extraReplies?: readonly string[];
    },
  ) {
    const threadId = await store.set(
      seedOrdinaryChatThreadFixture$,
      {
        member: {
          ...member,
          ...(args.agentId === undefined ? {} : { agentId: args.agentId }),
        },
        ...(args.title === undefined ? {} : { title: args.title }),
      },
      context.signal,
    );
    const run = await store.set(
      seedFinishedChatRunFixture$,
      {
        chatThreadId: threadId,
        prompt: args.prompt,
        reply: args.reply,
        thinking: "private reasoning that must never leave the server",
        ...(args.extraReplies === undefined
          ? {}
          : { extraReplies: args.extraReplies }),
      },
      context.signal,
    );
    return { threadId, run };
  }

  /** A second Agent this member owns, created through the production endpoint. */
  async function createMemberAgent(member: MorningBriefChatMember) {
    authenticate(member);
    context.mocks.s3.send.mockResolvedValue({});
    const created = await accept(
      setupApp({ context, routes: agentsRoutes })(agentsMainContract).create({
        headers: authHeaders(),
        body: { displayName: "Second agent", visibility: "public" },
      }),
      [201],
    );
    return created.body.agentId;
  }

  /**
   * Freeze the attempt clock just past the seeded history.
   *
   * The budget is measured against this clock, so a boundary case advances it
   * to an exact instant instead of waiting for one. `clearMockNow` runs in the
   * shared afterEach.
   */
  let advanceAttemptIoClock: ((elapsedMs: number) => void) | undefined;

  function freezeAttemptClock(): number {
    const startedAt = now() + 1000;
    const ioStartedAt = monotonicNow();
    mockMonotonicNow(ioStartedAt);
    advanceAttemptIoClock = (elapsedMs) => {
      mockMonotonicNow(ioStartedAt + elapsedMs);
    };
    onTestFinished(() => {
      advanceAttemptIoClock = undefined;
      clearMockMonotonicNow();
    });
    mockNow(startedAt);
    return startedAt;
  }

  const candidateDeadline = (startedAt: number) => {
    return (
      startedAt +
      MORNING_BRIEF_CHAT_COLLECTION_BUDGET.deadlineMs -
      MORNING_BRIEF_CHAT_COLLECTION_BUDGET.finalAuthorityReserveMs
    );
  };

  function isExcerptContentQuery(queryArgs: unknown[]): boolean {
    const text = barrierQueryText(queryArgs);
    return (
      text.includes('from "chat_events"') &&
      text.includes('"chat_events"."run_id" =') &&
      text.includes('order by "chat_events"."seq_id" asc')
    );
  }

  function isAgentKeyShareQuery(
    queryArgs: unknown[],
    agentId: string,
  ): boolean {
    const text = barrierQueryText(queryArgs);
    return (
      text.includes('from "agents"') &&
      text.includes("for key share") &&
      barrierQueryBinds(queryArgs, agentId)
    );
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
    const member = await seedMember();

    await expect(refuseCollection(member)).resolves.toMatchObject({
      error: { code: "FORBIDDEN" },
    });
  });

  it("refuses a member with no enabled Morning Brief", async () => {
    const member = await seedMember({ enabled: false });
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
    const member = await seedMember();
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
    const neighbour = await seedMember({ orgId: shared });
    await seedUnreadThread(neighbour, {
      prompt: "neighbour prompt",
      reply: "neighbour reply",
    });
    const other = await seedMember({ orgId: member.orgId });
    await seedUnreadThread(other, {
      prompt: "same org, other member",
      reply: "other member reply",
    });

    const response = await collect(member);

    expect(response.result).toBe("empty");
    expect(response.items).toStrictEqual([]);
  });

  it("does not resurrect a thread deleted after it was already selected", async () => {
    const member = await briefMember();
    const { threadId } = await seedUnreadThread(member, {
      prompt: "doomed prompt",
      reply: "doomed reply",
    });
    await renameChatThreadFixture({ chatThreadId: threadId, title: "Renamed" });
    // The collection takes `FOR KEY SHARE` on the Agent before it can reach the
    // thread row or any event body, so holding that row with `FOR UPDATE`
    // suspends a real request between candidate selection and the content read.
    const held = await holdAgentRowFixture(member.agentId, context.signal);

    const pending = collectRequest(member);
    await held.waitForBlocked();
    await deleteSeededChatThreadFixture(threadId);
    await held.release();
    const response = await accept(pending, [200]);

    // Revalidation under the lock finds no row, so nothing is resurrected and
    // no body is reported for a thread that no longer exists.
    expect(response.body.items).toStrictEqual([]);
    expect(response.body.skipped).toStrictEqual([
      { threadId, reason: "thread_unavailable" },
    ]);
    expect(JSON.stringify(response.body)).not.toContain("doomed");
    expect(JSON.stringify(response.body)).not.toContain("Renamed");
  }, 60_000);

  describe("authority held across a real request", () => {
    it("releases nothing when the live membership is revoked mid-request", async () => {
      const member = await briefMember();
      const { threadId } = await seedUnreadThread(member, {
        title: "Quarter close",
        prompt: "prompt nobody may see",
        reply: "reply nobody may see",
      });
      const barrier = await holdChatThreadReadBarrierFixture(
        threadId,
        context.signal,
      );

      const pending = collectRequest(member);
      await barrier.waitForBlocked();
      // A real removal: the live Clerk generation this attempt pinned is gone.
      // The request was already admitted and is still running.
      await store.set(
        deleteOrgMembership$,
        { orgId: member.orgId, userId: member.userId },
        context.signal,
      );
      await barrier.release();
      const response = await accept(pending, [403]);

      expect(response.body.error.code).toBe("FORBIDDEN");
      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain(threadId);
      expect(serialized).not.toContain("nobody may see");
      expect(serialized).not.toContain("Quarter close");
    }, 60_000);

    it("releases nothing to a membership generation that rejoined mid-request", async () => {
      const member = await briefMember({ membershipId: "orgmem_first" });
      const { threadId } = await seedUnreadThread(member, {
        prompt: "prompt the old membership read",
        reply: "reply the old membership read",
      });
      const barrier = await holdChatThreadReadBarrierFixture(
        threadId,
        context.signal,
      );

      const pending = collectRequest(member);
      await barrier.waitForBlocked();
      // Removed and rejoined: the same member, a new immutable membership id.
      await store.set(
        seedOrgMembership$,
        {
          orgId: member.orgId,
          userId: member.userId,
          membershipId: "orgmem_rejoined",
        },
        context.signal,
      );
      await barrier.release();
      const response = await accept(pending, [403]);

      expect(JSON.stringify(response.body)).not.toContain(threadId);
    }, 60_000);

    it("releases the collection of a member whose authority never changed", async () => {
      const member = await briefMember();
      const { threadId } = await seedUnreadThread(member, {
        prompt: "prompt the same membership read",
        reply: "reply the same membership read",
      });
      const barrier = await holdChatThreadReadBarrierFixture(
        threadId,
        context.signal,
      );

      const pending = collectRequest(member);
      await barrier.waitForBlocked();
      await barrier.release();
      const response = await accept(pending, [200]);

      expect(response.body.result).toBe("collected");
      expect(
        response.body.items.map((item) => {
          return item.threadId;
        }),
      ).toStrictEqual([threadId]);
    }, 60_000);

    it("keeps an unrelated owner in the same organization collectable", async () => {
      const member = await briefMember();
      const neighbour = await briefMember({ orgId: member.orgId });
      const neighbourThread = await seedUnreadThread(neighbour, {
        prompt: "the neighbour's own prompt",
        reply: "the neighbour's own reply",
      });
      await seedUnreadThread(member, {
        prompt: "revoked member prompt",
        reply: "revoked member reply",
      });

      // Only this member leaves the organization.
      await store.set(
        deleteOrgMembership$,
        { orgId: member.orgId, userId: member.userId },
        context.signal,
      );
      await accept(collectRequest(member), [403]);
      const survived = await collect(neighbour);

      expect(
        survived.items.map((item) => {
          return item.threadId;
        }),
      ).toStrictEqual([neighbourThread.threadId]);
    }, 60_000);

    it("rejects an automation-only replacement and admits a fresh request under it", async () => {
      const member = await briefMember();
      const { threadId } = await seedUnreadThread(member, {
        title: "Automation-only secret",
        prompt: "prompt the old automation read",
        reply: "reply the old automation read",
      });
      const barrier = await holdChatThreadReadBarrierFixture(
        threadId,
        context.signal,
      );

      const pending = collectRequest(member);
      await barrier.waitForBlocked();
      const replacement = await replaceMorningBriefAutomationFixture(member);
      await barrier.release();
      const refused = await accept(pending, [403]);

      expect(replacement.automationId).not.toBe(member.automationId);
      const serialized = JSON.stringify(refused.body);
      expect(serialized).not.toContain(threadId);
      expect(serialized).not.toContain("old automation");
      expect(serialized).not.toContain("Automation-only secret");

      // The replacement is itself canonical and enabled; only the stale scope
      // is refused. A request admitted afterwards still collects normally.
      const fresh = await collect(member);
      expect(
        fresh.items.map((item) => {
          return item.threadId;
        }),
      ).toStrictEqual([threadId]);
    }, 60_000);

    it.each([
      { name: "null to non-null", initiallyBound: false },
      { name: "non-null to null", initiallyBound: true },
    ])(
      "rejects a $name destination rebind while preserving fresh collection",
      async ({ initiallyBound }) => {
        const member = await briefMember();
        const destination = await store.set(
          seedOrdinaryChatThreadFixture$,
          { member, title: "Destination only" },
          context.signal,
        );
        if (initiallyBound) {
          await bindMorningBriefThreadFixture({
            orgId: member.orgId,
            userId: member.userId,
            workflowId: member.workflowId,
            chatThreadId: destination,
          });
        }
        const { threadId } = await seedUnreadThread(member, {
          title: "Rebinding secret",
          prompt: "prompt the old destination read",
          reply: "reply the old destination read",
        });
        const barrier = await holdChatThreadReadBarrierFixture(
          threadId,
          context.signal,
        );

        const pending = collectRequest(member);
        await barrier.waitForBlocked();
        await bindMorningBriefThreadFixture({
          orgId: member.orgId,
          userId: member.userId,
          workflowId: member.workflowId,
          chatThreadId: initiallyBound ? null : destination,
        });
        await barrier.release();
        const refused = await accept(pending, [403]);

        const serialized = JSON.stringify(refused.body);
        expect(serialized).not.toContain(threadId);
        expect(serialized).not.toContain("old destination");
        expect(serialized).not.toContain("Rebinding secret");

        // The same source thread remains eligible under the newly admitted
        // binding, whether the new destination is null or non-null.
        const fresh = await collect(member);
        expect(
          fresh.items.map((item) => {
            return item.threadId;
          }),
        ).toStrictEqual([threadId]);
      },
      60_000,
    );

    it("releases nothing once the canonical installation is replaced mid-request", async () => {
      const member = await briefMember();
      const { threadId } = await seedUnreadThread(member, {
        prompt: "prompt the replaced brief read",
        reply: "reply the replaced brief read",
      });
      const barrier = await holdChatThreadReadBarrierFixture(
        threadId,
        context.signal,
      );

      const pending = collectRequest(member);
      await barrier.waitForBlocked();
      // A complete, enabled Morning Brief — just not the one this attempt was
      // admitted under. Being enabled is not the same as being this brief.
      const replacement = await replaceMorningBriefInstallationFixture(member);
      await barrier.release();
      const response = await accept(pending, [403]);

      expect(replacement.workflowId).not.toBe(member.workflowId);
      expect(JSON.stringify(response.body)).not.toContain(threadId);
    }, 60_000);

    it("rechecks local erasure after the final external membership answer", async () => {
      const member = await briefMember();
      const { threadId } = await seedUnreadThread(member, {
        title: "Erasure-window secret",
        prompt: "prompt collected before closure",
        reply: "reply collected before closure",
      });
      // Positive control: the same real route, database state and authorizer
      // release the data while the owner remains open.
      await expect(collect(member)).resolves.toMatchObject({
        result: "collected",
      });
      // Admission resolves membership once, and the pre-collection owner fence
      // once. Holding the third answer suspends the final external wait after
      // its earlier local work has already completed.
      const held = holdMorningBriefChatMembershipLookupFixture(
        { owner: member, skip: 2 },
        context.signal,
      );

      const pending = collectRequest(member);
      await held.waitForArrival();
      expect(held.lookupsBefore()).toBe(2);
      // B1 has no public closure ingress. This is its actual lifecycle writer,
      // projected for the uniquely owned test subject while Clerk is held.
      await closeSubject({ subjectKind: "user", subjectId: member.userId });
      held.release();
      const response = await accept(pending, [403]);

      expect(response.body.error.code).toBe("FORBIDDEN");
      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain(threadId);
      expect(serialized).not.toContain("before closure");
      expect(serialized).not.toContain("Erasure-window secret");
    }, 60_000);

    it("releases nothing once the brief's own Agent becomes inaccessible", async () => {
      const member = await briefMember();
      // The unread Chat lives on a different Agent, so losing the brief's Agent
      // is the only authority this case removes.
      const chatAgentId = await createMemberAgent(member);
      const { threadId } = await seedUnreadThread(member, {
        agentId: chatAgentId,
        prompt: "prompt behind a lost brief agent",
        reply: "reply behind a lost brief agent",
      });
      const barrier = await holdChatThreadReadBarrierFixture(
        threadId,
        context.signal,
      );

      const pending = collectRequest(member);
      await barrier.waitForBlocked();
      await restrictAgentAccessFixture({
        agentId: member.agentId,
        owner: `user_${randomUUID()}`,
      });
      await barrier.release();
      const response = await accept(pending, [403]);

      expect(JSON.stringify(response.body)).not.toContain(threadId);
    }, 60_000);

    it("collects a member's unread Chat across every Agent they may read", async () => {
      const member = await briefMember();
      const secondAgentId = await createMemberAgent(member);
      const onBriefAgent = await seedUnreadThread(member, {
        prompt: "brief agent prompt",
        reply: "brief agent reply",
      });
      const onSecondAgent = await seedUnreadThread(member, {
        agentId: secondAgentId,
        prompt: "second agent prompt",
        reply: "second agent reply",
      });

      const response = await collect(member);

      expect(
        response.items
          .map((item) => {
            return item.threadId;
          })
          .sort(),
      ).toStrictEqual([onBriefAgent.threadId, onSecondAgent.threadId].sort());
    });
  });

  describe("one attempt budget", () => {
    it("refuses an attempt whose admission outlived the budget, empty inbox included", async () => {
      const member = await briefMember();
      // The same member, finishing inside the budget, really does have a
      // healthy empty inbox. That is the answer the expired attempt must not
      // be confused with.
      await expect(collect(member)).resolves.toMatchObject({
        result: "empty",
        coverage: "complete",
      });
      const held = holdMorningBriefChatMembershipLookupFixture(
        { owner: member, skip: 0 },
        context.signal,
      );
      const startedAt = freezeAttemptClock();

      const pending = collectRequest(member);
      await held.waitForArrival();
      // The whole budget is spent inside admission's own network read.
      mockNow(startedAt + MORNING_BRIEF_CHAT_COLLECTION_BUDGET.deadlineMs);
      held.release();
      const response = await pending;

      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({
        error: { code: "REQUEST_DEADLINE_EXCEEDED" },
      });
    }, 60_000);

    it("refuses an attempt whose admission outlived the budget, unread threads included", async () => {
      const member = await briefMember();
      const { threadId } = await seedUnreadThread(member, {
        prompt: "prompt the expired attempt never reached",
        reply: "reply the expired attempt never reached",
      });
      // Without this the absence assertion below would hold for a thread that
      // was never collectable in the first place.
      await expect(collect(member)).resolves.toMatchObject({
        result: "collected",
      });
      const held = holdMorningBriefChatMembershipLookupFixture(
        { owner: member, skip: 0 },
        context.signal,
      );
      const startedAt = freezeAttemptClock();

      const pending = collectRequest(member);
      await held.waitForArrival();
      expect(held.lookupsBefore()).toBe(0);
      mockNow(startedAt + MORNING_BRIEF_CHAT_COLLECTION_BUDGET.deadlineMs);
      held.release();
      const response = await pending;

      expect(response.status).toBe(503);
      expect(JSON.stringify(response.body)).not.toContain(threadId);
    }, 60_000);

    it("discards a thread whose read returned at the exact deadline", async () => {
      const member = await briefMember();
      const { threadId } = await seedUnreadThread(member, {
        prompt: "prompt that finished too late",
        reply: "reply that finished too late",
      });
      const barrier = await holdChatThreadReadBarrierFixture(
        threadId,
        context.signal,
      );
      const startedAt = freezeAttemptClock();

      const pending = collectRequest(member);
      await barrier.waitForBlocked();
      // Exactly on the boundary: at the deadline the budget is already spent.
      mockNow(candidateDeadline(startedAt));
      await barrier.release();
      const response = await accept(pending, [200]);

      expect(response.body).toMatchObject({
        result: "no-eligible-content",
        coverage: "partial",
        items: [],
        skipped: [],
        truncations: ["deadline_exceeded"],
      });
      // Neither the excerpts nor the refusal reason for an expired read escape.
      expect(JSON.stringify(response.body)).not.toContain(threadId);
      expect(JSON.stringify(response.body)).not.toContain("too late");
    }, 60_000);

    it("spends successive PostgreSQL waits without starting content after the candidate deadline", async () => {
      await withDatabaseTransactionBarrierFixture(
        {
          select: isExcerptContentQuery,
          stopAt: (_queryArgs, selectingStatement) => {
            return selectingStatement;
          },
          work: async (contentQuery) => {
            const member = await briefMember();
            const { threadId } = await seedUnreadThread(member, {
              prompt: "prompt beyond the cumulative budget",
              reply: "reply beyond the cumulative budget",
            });
            const discovery = await holdChatCandidateDiscoveryFixture(
              context.signal,
            );
            const agent = await holdAgentRowFixture(
              member.agentId,
              context.signal,
            );
            const startedAt = freezeAttemptClock();

            const pending = collectRequest(member);
            await discovery.waitForBlocked();
            // Discovery consumed most of the candidate allowance while queued
            // in PostgreSQL, but stayed within its individual cap.
            mockNow(candidateDeadline(startedAt) - 500);
            await discovery.release();
            await agent.waitForBlocked();

            // Acquire the final-query blocker only after discovery committed;
            // candidate selection itself also reads agent_runs.
            const activeRun = await holdActiveRunReadFixture(context.signal);
            await agent.release();
            await activeRun.waitForBlocked();
            mockNow(candidateDeadline(startedAt));
            await activeRun.release();

            const response = await accept(pending, [200]);
            expect(response.body).toMatchObject({
              result: "no-eligible-content",
              coverage: "partial",
              items: [],
              skipped: [],
              truncations: ["deadline_exceeded"],
            });
            expect(JSON.stringify(response.body)).not.toContain(threadId);
            expect(contentQuery.enteredYet()).toBeFalsy();

            // Guard-removal control: a fresh healthy request reaches this exact
            // content statement. The selected transaction exposes all three
            // real server settings, including the whole-transaction bound.
            const healthy = collectRequest(member);
            const healthyContentQuery = await contentQuery.entered;
            expect(healthyContentQuery).toMatchObject({
              lockTimeout: "2s",
              statementTimeout: "5s",
            });
            // PostgreSQL renders the conservatively floored monotonic remainder
            // in milliseconds when fractional clock origins leave it 1ms shy.
            expect(["11999ms", "12s"]).toContain(
              healthyContentQuery.transactionTimeout,
            );
            contentQuery.release();
            const recovered = await accept(healthy, [200]);
            expect(recovered.body.result).toBe("collected");
            expect(recovered.body.items).toHaveLength(1);
          },
        },
        context.signal,
      );
    }, 60_000);

    it("lets PostgreSQL cancel an in-flight transaction at its remaining absolute deadline", async () => {
      let targetAgentId: string | undefined;
      await withDatabaseTransactionBarrierFixture(
        {
          select: (queryArgs) => {
            return (
              targetAgentId !== undefined &&
              isAgentKeyShareQuery(queryArgs, targetAgentId)
            );
          },
          stopAt: (_queryArgs, selectingStatement) => {
            return selectingStatement;
          },
          work: async (agentQuery) => {
            const serverCancellationAllowanceMs = 1000;
            const member = await briefMember();
            targetAgentId = member.agentId;
            const { threadId } = await seedUnreadThread(member, {
              prompt: "prompt behind the server deadline",
              reply: "reply behind the server deadline",
            });
            const discovery = await holdChatCandidateDiscoveryFixture(
              context.signal,
            );
            const agent = await holdAgentRowFixture(
              member.agentId,
              context.signal,
            );
            const startedAt = freezeAttemptClock();

            const pending = collectRequest(member);
            await discovery.waitForBlocked();
            // The per-thread transaction starts with less time than either
            // statement cap. Pause its exact Agent read at the driver boundary,
            // before dispatch, instead of racing a pg_stat_activity poll inside
            // the server deadline window.
            mockNow(
              candidateDeadline(startedAt) - serverCancellationAllowanceMs,
            );
            advanceAttemptIoClock?.(
              MORNING_BRIEF_CHAT_COLLECTION_BUDGET.deadlineMs -
                MORNING_BRIEF_CHAT_COLLECTION_BUDGET.finalAuthorityReserveMs -
                serverCancellationAllowanceMs,
            );
            await discovery.release();
            await expect(agentQuery.entered).resolves.toMatchObject({
              lockTimeout: "2s",
              statementTimeout: "5s",
              transactionTimeout: "1s",
            });

            // Move the application clock to the same absolute boundary before
            // dispatching the already-owned query. The Agent lock remains held,
            // so PostgreSQL's transaction timeout alone must terminate it.
            mockNow(candidateDeadline(startedAt));
            agentQuery.release();
            const response = await accept(pending, [200]);
            await agent.release();

            expect(response.body).toMatchObject({
              result: "no-eligible-content",
              coverage: "partial",
              items: [],
              skipped: [],
              truncations: ["deadline_exceeded"],
            });
            expect(JSON.stringify(response.body)).not.toContain(threadId);

            // The timed-out transaction was awaited and rolled back
            // (PostgreSQL may replace its terminated session); the same route
            // and pool remain usable.
            const recovered = await collect(member);
            expect(recovered.result).toBe("collected");
          },
        },
        context.signal,
      );
    }, 60_000);

    it("bounds the local final-authority query after the external fence", async () => {
      const member = await briefMember();
      const { threadId } = await seedUnreadThread(member, {
        prompt: "prompt waiting on final local authority",
        reply: "reply waiting on final local authority",
      });
      // Admission and the pre-read fence use the first two lookups. Hold the
      // final external answer after content has already been collected.
      const membership = holdMorningBriefChatMembershipLookupFixture(
        { owner: member, skip: 2 },
        context.signal,
      );
      const startedAt = freezeAttemptClock();
      const pending = collectRequest(member);
      await membership.waitForArrival();
      expect(membership.lookupsBefore()).toBe(2);

      const ownership = await holdMorningBriefOwnershipReadFixture(
        context.signal,
      );
      mockNow(
        startedAt + MORNING_BRIEF_CHAT_COLLECTION_BUDGET.deadlineMs - 500,
      );
      membership.release();
      await ownership.waitForBlocked();
      mockNow(startedAt + MORNING_BRIEF_CHAT_COLLECTION_BUDGET.deadlineMs);
      await ownership.release();

      const response = await accept(pending, [503]);
      expect(response.body.error.code).toBe("REQUEST_DEADLINE_EXCEEDED");
      expect(JSON.stringify(response.body)).not.toContain(threadId);

      // Final local work committed or rolled back before the response; no lock
      // or detached query prevents the next valid request.
      const recovered = await collect(member);
      expect(recovered.result).toBe("collected");
    }, 60_000);

    it("refuses an attempt whose final authority check outlived the budget", async () => {
      const member = await briefMember();
      const { threadId } = await seedUnreadThread(member, {
        prompt: "prompt collected but never fenced",
        reply: "reply collected but never fenced",
      });
      await expect(collect(member)).resolves.toMatchObject({
        result: "collected",
      });
      // Admission resolves the generation twice; the third lookup is the fence
      // that decides whether this envelope may be released.
      const held = holdMorningBriefChatMembershipLookupFixture(
        { owner: member, skip: 2 },
        context.signal,
      );
      const startedAt = freezeAttemptClock();

      const pending = collectRequest(member);
      await held.waitForArrival();
      // Stalling admission instead would produce the same 503, so the case
      // states which boundary it actually suspended.
      expect(held.lookupsBefore()).toBe(2);
      mockNow(startedAt + MORNING_BRIEF_CHAT_COLLECTION_BUDGET.deadlineMs);
      held.release();
      const response = await pending;

      // Content really was collected, and it still may not leave: the authority
      // it was collected under could not be re-established inside the budget.
      expect(response.status).toBe(503);
      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain(threadId);
      expect(serialized).not.toContain("never fenced");
    }, 60_000);

    it("fails a cancelled request instead of releasing a partial envelope", async () => {
      const member = await briefMember();
      const { threadId } = await seedUnreadThread(member, {
        prompt: "prompt behind a cancelled request",
        reply: "reply behind a cancelled request",
      });
      const barrier = await holdChatThreadReadBarrierFixture(
        threadId,
        context.signal,
      );
      const cancelled = new AbortController();

      const pending = collectRequest(member, { signal: cancelled.signal });
      await barrier.waitForBlocked();
      cancelled.abort(new DOMException("Caller went away", "AbortError"));
      await barrier.release();
      const response = await pending;

      // A cancelled attempt is a failure, never a 200 envelope and never the
      // 503 an expired budget produces.
      expect(response.status).toBe(500);
      expect(JSON.stringify(response.body)).not.toContain(threadId);
    }, 60_000);
  });

  describe("bounded reads", () => {
    it("observes one candidate more than it may process and says so", async () => {
      const member = await briefMember();
      for (let index = 0; index < 51; index += 1) {
        await seedUnreadThread(member, {
          prompt: `prompt ${index.toString()}`,
          reply: `reply ${index.toString()}`,
        });
      }

      const response = await collect(member);

      expect(response.scope.unreadCandidates).toBe(50);
      expect(response.scope.inspectedThreads).toBe(50);
      expect(response.items).toHaveLength(50);
      expect(response.truncations).toContain("candidate_overflow");
      expect(response.coverage).toBe("partial");
    }, 120_000);

    it("stops at the whole-collection text budget", async () => {
      const member = await briefMember();
      const wide = Array.from({ length: 12 }, () => {
        return "w".repeat(5000);
      });
      await seedUnreadThread(member, {
        prompt: "first wide thread",
        reply: "w".repeat(5000),
        extraReplies: wide,
      });
      await seedUnreadThread(member, {
        prompt: "second wide thread",
        reply: "w".repeat(5000),
        extraReplies: wide,
      });

      const response = await collect(member);

      expect(response.truncations).toContain("output_budget");
      expect(response.coverage).toBe("partial");
      const bytes = response.items.reduce((total, item) => {
        return (
          total +
          item.excerpts.reduce((itemTotal, excerpt) => {
            return itemTotal + new TextEncoder().encode(excerpt.text).length;
          }, 0)
        );
      }, 0);
      expect(bytes).toBeLessThanOrEqual(64 * 1024);
    }, 60_000);

    it("reports an unreadably large stored event instead of decoding it", async () => {
      const member = await briefMember();
      await seedUnreadThread(member, {
        prompt: "readable prompt",
        // Larger than the readable payload cap, so the row is a coverage gap
        // rather than a truncated excerpt.
        reply: "z".repeat(70 * 1024),
      });

      const response = await collect(member);

      const [item] = response.items;
      expect(response.truncations).toContain("oversized_event_payload");
      expect(response.coverage).toBe("partial");
      expect(
        item?.excerpts.map((excerpt) => {
          return excerpt.role;
        }),
      ).toStrictEqual(["user"]);
      expect(JSON.stringify(response)).not.toContain("zzzz");
    }, 60_000);

    it("reports a bounded read that could not complete as a gap, not a failure", async () => {
      const member = await briefMember();
      const readable = await seedUnreadThread(member, {
        prompt: "readable thread prompt",
        reply: "readable thread reply",
      });
      const blocked = await seedUnreadThread(member, {
        prompt: "prompt behind a held row",
        reply: "reply behind a held row",
      });
      // Held for longer than the per-thread lock timeout, so the read really
      // does not complete.
      const barrier = await holdChatThreadReadBarrierFixture(
        blocked.threadId,
        context.signal,
      );

      const response = await collect(member);
      await barrier.release();

      expect(response.skipped).toStrictEqual([
        { threadId: blocked.threadId, reason: "thread_read_failed" },
      ]);
      expect(response.coverage).toBe("partial");
      expect(
        response.items.map((item) => {
          return item.threadId;
        }),
      ).toStrictEqual([readable.threadId]);
      expect(JSON.stringify(response)).not.toContain("behind a held row");
    }, 60_000);

    it("advances no read state and writes nothing for the member", async () => {
      const member = await briefMember();
      const { threadId } = await seedUnreadThread(member, {
        prompt: "prompt that stays unread",
        reply: "reply that stays unread",
      });
      const writesBefore = await countMorningBriefChatWritesFixture(member);

      const response = await collect(member);

      expect(response.result).toBe("collected");
      // The watermark is observable through the endpoint: an advanced read
      // state would drop the thread from the next collection's candidates.
      const again = await collect(member);
      expect(
        again.items.map((item) => {
          return item.threadId;
        }),
      ).toStrictEqual([threadId]);
      // Runs, usage events and queued e-mail have no endpoint that reports
      // "this owner produced none", so those three are counted directly. Chat
      // events are counted beside them to keep one snapshot.
      await expect(
        countMorningBriefChatWritesFixture(member),
      ).resolves.toStrictEqual(writesBefore);
    }, 60_000);
  });
});
