import { randomUUID } from "node:crypto";

import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agents } from "@okouai/db/schema/agent";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import {
  workflowAutomations,
  workflowUserAutomationThreads,
  workflows,
} from "@okouai/db/schema/workflow";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { emailOutbox } from "@okouai/db/schema/email-outbox";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { command } from "ccstate";
import { and, count, eq, sql } from "drizzle-orm";
import { onTestFinished } from "vitest";

import { getApiTestMocks } from "../__tests__/mocks";
import { db } from "../lib/db";
import { nowDate } from "../lib/time";
import { writeDb$ } from "../signals/external/db";
import { createChatThreadInTransaction } from "../signals/services/chat-thread.service";
import { insertChatEvent } from "../signals/services/chat-event.service";
import { excludeMorningBriefChatThread } from "../signals/services/morning-brief-thread-provenance.service";
import { createDeferredPromise } from "../signals/utils";
import { seedInstalledMorningBrief } from "./morning-brief-collection";
import { holdDeferredRow } from "./pi-deferred-lock";

/**
 * Persisted setup for unread Chat collection.
 *
 * Collection reads history that an API test cannot always build: a thread
 * created before the provenance column existed has no endpoint that produces
 * it, and a Run whose terminal marker already exists needs a complete Run
 * lifecycle. Threads are still created through the production ordinary creator,
 * so the `ordinary` classification under test is the one production writes.
 */

/** The owner identity the Chat collection fixtures are scoped to. */
export interface MorningBriefChatMember {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
}

/**
 * A member who owns an installed, enabled Morning Brief.
 *
 * The installation itself comes from the shared Morning Brief collection
 * fixture so both collectors seed the same canonical legacy state; only the
 * workflow/user thread binding, which the Chat collector reads to find the
 * destination thread, is added here.
 */
export async function seedMorningBriefChatMemberFixture(
  options: {
    readonly orgId?: string;
    readonly enabled?: boolean;
    readonly agentVisibility?: "public" | "private";
    readonly agentOwner?: string;
  } = {},
): Promise<
  MorningBriefChatMember & {
    readonly workflowId: string;
    readonly automationId: string;
  }
> {
  const installed = await seedInstalledMorningBrief({
    orgId: options.orgId ?? `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
    ...(options.agentVisibility === undefined
      ? {}
      : { agentVisibility: options.agentVisibility }),
    ...(options.agentOwner === undefined
      ? {}
      : { agentOwner: options.agentOwner }),
  });
  return {
    ...installed.owner,
    agentId: installed.agentId,
    workflowId: installed.workflowId,
    automationId: installed.automationId,
  };
}

/**
 * Take this member's access to an Agent away.
 *
 * A private Agent owned by somebody else is invisible to this member, which is
 * what losing access to the Agent hosting their brief looks like. No endpoint
 * hands an Agent to another user: the Agent API changes visibility but never
 * the owner, so this state cannot be built through the product and is written
 * here, exactly as the existing held-transfer fixture below already does.
 */
export async function restrictAgentAccessFixture(args: {
  readonly agentId: string;
  readonly owner: string;
}): Promise<void> {
  await db()
    .update(agents)
    .set({ owner: args.owner, visibility: "private" })
    .where(eq(agents.id, args.agentId));
}

/**
 * Replace the member's canonical Morning Brief with another enabled one.
 *
 * The new installation is a complete, working brief on its own Agent: it is
 * exactly the "merely enabled replacement" that must not be able to authorize
 * content the previous installation's collection had already gathered. It
 * reuses the shared installed-brief fixture rather than the Official Workflow
 * install path, because the canonical legacy installation every Morning Brief
 * suite starts from is already seeded that way; driving one member through a
 * real install while the other is seeded would compare two different states.
 */
export async function replaceMorningBriefInstallationFixture(member: {
  readonly orgId: string;
  readonly userId: string;
  readonly workflowId: string;
}): Promise<{ readonly workflowId: string; readonly agentId: string }> {
  await uninstallMorningBriefFixture(member.workflowId);
  const installed = await seedInstalledMorningBrief({
    orgId: member.orgId,
    userId: member.userId,
  });
  return { workflowId: installed.workflowId, agentId: installed.agentId };
}

/**
 * Suspend one numbered live membership lookup after it has answered.
 *
 * A single attempt resolves the member's Clerk generation more than once — when
 * it is admitted, and again at the fence that decides whether the envelope may
 * be released — so a test that has to stall one specific boundary names it by
 * ordinal rather than by "the next one". The answer is computed first and only
 * then held, which is what makes the resumed caller a genuinely stale one
 * instead of a lookup that already observed the change.
 */
export function holdMorningBriefChatMembershipLookupFixture(
  args: {
    readonly owner: MorningBriefChatMember;
    /** Lookups to let through untouched before suspending one. */
    readonly skip: number;
  },
  signal: AbortSignal,
): {
  readonly waitForArrival: () => Promise<void>;
  /**
   * How many of this owner's lookups completed before the suspended one, so a
   * test can prove it stalled the boundary it names instead of an earlier one
   * that happens to produce the same outcome.
   */
  readonly lookupsBefore: () => number;
  readonly release: () => void;
} {
  const lookup =
    getApiTestMocks().clerk.organizations.getOrganizationMembershipList;
  const answer = lookup.getMockImplementation();
  if (!answer) {
    throw new Error("Expected seeded Clerk organization membership mocks");
  }
  const arrived = createDeferredPromise<void>(signal);
  const released = createDeferredPromise<void>(signal);
  let seen = 0;
  let suspendedAfter = 0;
  let suspended = false;
  const release = () => {
    if (!released.settled()) {
      released.resolve();
    }
  };
  onTestFinished(release);
  lookup.mockImplementation(async (...callArgs: unknown[]) => {
    const membership: unknown = await answer(...callArgs);
    if (!isOwnerMembershipLookup(callArgs, args.owner)) {
      return membership;
    }
    if (suspended || seen++ < args.skip) {
      return membership;
    }
    suspended = true;
    suspendedAfter = seen - 1;
    arrived.resolve();
    await released.promise;
    return membership;
  });
  return {
    waitForArrival: () => {
      return arrived.promise;
    },
    lookupsBefore: () => {
      return suspendedAfter;
    },
    release,
  };
}

function isOwnerMembershipLookup(
  args: readonly unknown[],
  owner: { readonly orgId: string; readonly userId: string },
): boolean {
  const [query] = args;
  if (typeof query !== "object" || query === null) {
    return false;
  }
  const organizationId =
    "organizationId" in query ? query.organizationId : undefined;
  const userId = "userId" in query ? query.userId : undefined;
  return (
    organizationId === owner.orgId &&
    Array.isArray(userId) &&
    userId.includes(owner.userId)
  );
}

/**
 * Everything a collection must not create for this owner.
 *
 * Counted rather than sampled, so a Run, a Chat event, a usage event or a
 * queued e-mail appearing anywhere under this owner fails the assertion. There
 * is no endpoint that reports "this owner produced no Run, usage event or
 * queued e-mail", so this one assertion is made against the database; the read
 * watermark, which *is* observable through a second collection, is not.
 */
export async function countMorningBriefChatWritesFixture(owner: {
  readonly orgId: string;
  readonly userId: string;
  readonly automationId: string;
}): Promise<{
  readonly chatEvents: number;
  readonly runs: number;
  readonly usageEvents: number;
  readonly emails: number;
}> {
  // Every counter is scoped to this owner, so a suite running beside this one
  // cannot move the numbers the assertion compares.
  const [events] = await db()
    .select({ total: count() })
    .from(chatEvents)
    .innerJoin(chatThreads, eq(chatThreads.id, chatEvents.chatThreadId))
    .where(eq(chatThreads.userId, owner.userId));
  const [runs] = await db()
    .select({ total: count() })
    .from(agentRuns)
    .where(
      and(eq(agentRuns.orgId, owner.orgId), eq(agentRuns.userId, owner.userId)),
    );
  const [usageEvents] = await db()
    .select({ total: count() })
    .from(usageEvent)
    .where(
      and(
        eq(usageEvent.orgId, owner.orgId),
        eq(usageEvent.userId, owner.userId),
      ),
    );
  const [emails] = await db()
    .select({ total: count() })
    .from(emailOutbox)
    .where(eq(emailOutbox.sourceWorkflowAutomationId, owner.automationId));
  return {
    chatEvents: events?.total ?? 0,
    runs: runs?.total ?? 0,
    usageEvents: usageEvents?.total ?? 0,
    emails: emails?.total ?? 0,
  };
}

/** Point the member's Morning Brief binding at a destination thread. */
export async function bindMorningBriefThreadFixture(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly workflowId: string;
  readonly chatThreadId: string | null;
}): Promise<void> {
  await db()
    .insert(workflowUserAutomationThreads)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      workflowId: args.workflowId,
      chatThreadId: args.chatThreadId,
    })
    .onConflictDoUpdate({
      target: [
        workflowUserAutomationThreads.orgId,
        workflowUserAutomationThreads.userId,
        workflowUserAutomationThreads.workflowId,
      ],
      set: { chatThreadId: args.chatThreadId },
    });
}

/** Create a thread through the production ordinary-Chat creator. */
export const seedOrdinaryChatThreadFixture$ = command(
  async (
    { set },
    args: {
      readonly member: MorningBriefChatMember;
      readonly title?: string;
    },
    signal: AbortSignal,
  ): Promise<string> => {
    const created = await set(writeDb$).transaction(async (tx) => {
      return await createChatThreadInTransaction(tx, {
        userId: args.member.userId,
        orgId: args.member.orgId,
        agentId: args.member.agentId,
        title: args.title ?? "Ordinary chat",
        clientThreadId: undefined,
        eventId: undefined,
        modelProviderId: null,
        modelProviderType: null,
        modelProviderCredentialScope: null,
        selectedModel: null,
        codexServiceTier: null,
        selectedVideoModel: null,
        selectedImageModel: null,
      });
    });
    signal.throwIfAborted();
    if (created.kind !== "created") {
      throw new Error("Expected the ordinary chat thread fixture to insert");
    }
    return created.id;
  },
);

interface SeededChatRun {
  readonly runId: string;
  readonly promptEventId: string;
  readonly outputEventId: string;
  readonly terminalEventId: string;
}

/**
 * A finished Run with its claimed input, one visible reply, and the terminal
 * marker that makes the thread unread.
 */
export const seedFinishedChatRunFixture$ = command(
  async (
    { set },
    args: {
      readonly chatThreadId: string;
      readonly prompt: string;
      readonly reply: string;
      readonly extraReplies?: readonly string[];
      readonly thinking?: string;
    },
    signal: AbortSignal,
  ): Promise<SeededChatRun> => {
    const database = set(writeDb$);
    const [owner] = await database
      .select({
        userId: chatThreads.userId,
        orgId: agents.orgId,
        agentId: chatThreads.agentId,
      })
      .from(chatThreads)
      .innerJoin(agents, eq(agents.id, chatThreads.agentId))
      .where(eq(chatThreads.id, args.chatThreadId))
      .limit(1);
    signal.throwIfAborted();
    if (!owner?.agentId) {
      throw new Error("Expected a seeded chat thread owner");
    }
    const [session] = await database
      .insert(agentSessions)
      .values({
        userId: owner.userId,
        orgId: owner.orgId,
        agentId: owner.agentId,
      })
      .returning({ id: agentSessions.id });
    signal.throwIfAborted();
    if (!session) {
      throw new Error("Expected an agent session for the seeded run");
    }
    const [run] = await database
      .insert(agentRuns)
      .values({
        userId: owner.userId,
        orgId: owner.orgId,
        sessionId: session.id,
        status: "completed",
        prompt: args.prompt,
        triggerSource: "web",
        autonomyBudget: 0,
        chatThreadId: args.chatThreadId,
      })
      .returning({ id: agentRuns.id });
    signal.throwIfAborted();
    if (!run) {
      throw new Error("Expected an agent run for the seeded chat thread");
    }

    return await database.transaction(async (tx) => {
      const prompt = await insertChatEvent(tx, {
        chatThreadId: args.chatThreadId,
        eventType: "input.prompt",
        runId: run.id,
        contextType: "web",
        userMessage: {
          version: 1,
          parts: [{ type: "text", text: args.prompt }],
        },
      });
      if (args.thinking !== undefined) {
        await insertChatEvent(tx, {
          chatThreadId: args.chatThreadId,
          eventType: "output.thinking",
          runId: run.id,
          thinking: args.thinking,
          runEventSequenceNumber: null,
          runEventId: null,
        });
      }
      const output = await insertChatEvent(tx, {
        chatThreadId: args.chatThreadId,
        eventType: "output.message",
        runId: run.id,
        content: args.reply,
        runEventSequenceNumber: null,
        runEventId: null,
      });
      for (const extra of args.extraReplies ?? []) {
        await insertChatEvent(tx, {
          chatThreadId: args.chatThreadId,
          eventType: "output.message",
          runId: run.id,
          content: extra,
          runEventSequenceNumber: null,
          runEventId: null,
        });
      }
      const terminal = await insertChatEvent(tx, {
        chatThreadId: args.chatThreadId,
        eventType: "run.completed",
        runId: run.id,
        content: null,
      });
      if (!prompt || !output || !terminal) {
        throw new Error("Expected the seeded chat run events to insert");
      }
      return {
        runId: run.id,
        promptEventId: prompt.id,
        outputEventId: output.id,
        terminalEventId: terminal.id,
      };
    });
  },
);

/** Start a Run on the thread and leave it unfinished. */
export const startActiveChatRunFixture$ = command(
  async (
    { set },
    chatThreadId: string,
    signal: AbortSignal,
  ): Promise<string> => {
    const database = set(writeDb$);
    const [owner] = await database
      .select({
        userId: chatThreads.userId,
        orgId: agents.orgId,
        agentId: chatThreads.agentId,
      })
      .from(chatThreads)
      .innerJoin(agents, eq(agents.id, chatThreads.agentId))
      .where(eq(chatThreads.id, chatThreadId))
      .limit(1);
    signal.throwIfAborted();
    if (!owner?.agentId) {
      throw new Error("Expected a seeded chat thread owner");
    }
    const [session] = await database
      .insert(agentSessions)
      .values({
        userId: owner.userId,
        orgId: owner.orgId,
        agentId: owner.agentId,
      })
      .returning({ id: agentSessions.id });
    signal.throwIfAborted();
    if (!session) {
      throw new Error("Expected an agent session for the active run");
    }
    const [run] = await database
      .insert(agentRuns)
      .values({
        userId: owner.userId,
        orgId: owner.orgId,
        sessionId: session.id,
        status: "running",
        prompt: "still working",
        triggerSource: "web",
        autonomyBudget: 0,
        chatThreadId,
      })
      .returning({ id: agentRuns.id });
    signal.throwIfAborted();
    if (!run) {
      throw new Error("Expected an active run for the seeded chat thread");
    }
    return run.id;
  },
);

/**
 * Reproduce a thread created before the classification column existed.
 *
 * No endpoint can produce this state now, and it is the state most production
 * rows are in, so it has to be constructed here.
 */
export async function clearChatThreadProvenanceFixture(
  chatThreadId: string,
): Promise<void> {
  await db()
    .update(chatThreads)
    .set({ provenance: null })
    .where(eq(chatThreads.id, chatThreadId));
}

/** Write a classification this API version does not understand. */
export async function setUnsupportedChatThreadProvenanceFixture(
  chatThreadId: string,
): Promise<void> {
  await db()
    .update(chatThreads)
    .set({ provenance: sql`'future_origin'` })
    .where(eq(chatThreads.id, chatThreadId));
}

export async function readChatThreadProvenanceFixture(
  chatThreadId: string,
): Promise<string | null> {
  const [thread] = await db()
    .select({ provenance: chatThreads.provenance })
    .from(chatThreads)
    .where(eq(chatThreads.id, chatThreadId))
    .limit(1);
  return thread?.provenance ?? null;
}

export async function renameChatThreadFixture(args: {
  readonly chatThreadId: string;
  readonly title: string;
}): Promise<void> {
  await db()
    .update(chatThreads)
    .set({ title: args.title, renamedAt: nowDate() })
    .where(eq(chatThreads.id, args.chatThreadId));
}

/** Remove the installation the way an uninstall does, binding included. */
export async function uninstallMorningBriefFixture(
  workflowId: string,
): Promise<void> {
  await db()
    .delete(workflowUserAutomationThreads)
    .where(eq(workflowUserAutomationThreads.workflowId, workflowId));
  await db()
    .delete(workflowAutomations)
    .where(eq(workflowAutomations.workflowId, workflowId));
  await db().delete(workflows).where(eq(workflows.id, workflowId));
}

/** Commit the production Morning Brief exclusion write for one thread. */
export async function excludeMorningBriefChatThreadFixture(args: {
  readonly chatThreadId: string;
  readonly userId: string;
}): Promise<void> {
  await db().transaction(async (tx) => {
    await excludeMorningBriefChatThread(tx, args);
  });
}

/**
 * Run the production exclusion write and hold its transaction open.
 *
 * The held transaction owns the thread row's `FOR NO KEY UPDATE` lock, which is
 * the lock a collection must take to read the thread. A collection started
 * while this is held therefore queues behind a real uncommitted classification
 * change instead of racing it, and the test can prove it queued.
 */
export async function holdMorningBriefExclusionWriteFixture(
  args: {
    readonly chatThreadId: string;
    readonly userId: string;
  },
  signal: AbortSignal,
) {
  return await holdDeferredRow(signal, async (tx) => {
    await excludeMorningBriefChatThread(tx, {
      chatThreadId: args.chatThreadId,
      userId: args.userId,
    });
  });
}

/**
 * Hold the thread row lock a collection has to take, without changing anything.
 *
 * It suspends a collection at its own read boundary so a test can commit real
 * state — a new Run, a deletion — while the collection has already selected the
 * thread but has not yet read it.
 */
export async function holdChatThreadReadBarrierFixture(
  chatThreadId: string,
  signal: AbortSignal,
) {
  return await holdDeferredRow(signal, async (tx) => {
    await tx
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(eq(chatThreads.id, chatThreadId))
      .for("no key update");
  });
}

/**
 * Hold the Agent row a collection has to take first, without changing anything.
 *
 * The per-thread read takes `FOR KEY SHARE` on the Agent before it can reach
 * the thread row or any event body, and `FOR UPDATE` is the mode that conflicts
 * with it. Holding it therefore suspends a real request in the window between
 * candidate selection and the content read — the window where a deletion has to
 * be observed rather than read around.
 */
export async function holdAgentRowFixture(
  agentId: string,
  signal: AbortSignal,
) {
  return await holdDeferredRow(signal, async (tx) => {
    await tx
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, agentId))
      .for("update");
  });
}

/** Hold an uncommitted Agent ownership transfer on the thread's Agent. */
export async function holdAgentOwnerTransferFixture(
  args: { readonly agentId: string; readonly nextOwner: string },
  signal: AbortSignal,
) {
  return await holdDeferredRow(signal, async (tx) => {
    await tx
      .update(agents)
      .set({ owner: args.nextOwner })
      .where(eq(agents.id, args.agentId));
  });
}

export async function markChatThreadReadFixture(args: {
  readonly chatThreadId: string;
  readonly lastReadAt: Date;
}): Promise<void> {
  await db()
    .update(chatThreads)
    .set({ lastReadAt: args.lastReadAt })
    .where(eq(chatThreads.id, args.chatThreadId));
}

export async function deleteSeededChatThreadFixture(
  chatThreadId: string,
): Promise<void> {
  await db()
    .update(agentRuns)
    .set({ chatThreadId: null })
    .where(eq(agentRuns.chatThreadId, chatThreadId));
  await db().delete(chatThreads).where(eq(chatThreads.id, chatThreadId));
}

export async function readMorningBriefBindingThreadFixture(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly workflowId: string;
}): Promise<string | null> {
  const [binding] = await db()
    .select({ chatThreadId: workflowUserAutomationThreads.chatThreadId })
    .from(workflowUserAutomationThreads)
    .where(
      and(
        eq(workflowUserAutomationThreads.orgId, args.orgId),
        eq(workflowUserAutomationThreads.userId, args.userId),
        eq(workflowUserAutomationThreads.workflowId, args.workflowId),
      ),
    )
    .limit(1);
  return binding?.chatThreadId ?? null;
}
