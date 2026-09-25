import { randomUUID } from "node:crypto";

import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { agents } from "@okouai/db/schema/agent";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { workflowUserAutomationThreads } from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";

import { db } from "../lib/db";
import { writeDb$ } from "../signals/external/db";
import { seedInstalledMorningBrief } from "./morning-brief-collection";

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
