import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import {
  and,
  eq,
  exists,
  gte,
  isNotNull,
  isNull,
  ne,
  notExists,
  or,
} from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";
import { command } from "ccstate";
import { nativeContinuationSchema } from "@okouai/api-contracts/contracts/runners";
import type { EventConsumerPayload } from "../../lib/event-consumer/verify";
import { writeDb$ } from "../external/db";

const nativeSessionId = nativeContinuationSchema.shape.sessionId.unwrap();
const laterRun = alias(agentRuns, "later_native_run");

/** Bind actual Framework initialization, including runs that later fail/cancel. */
export const captureRunNativeSession$ = command(
  async ({ set }, payload: EventConsumerPayload) => {
    if (
      !payload.events.some((event) => {
        return (
          event.type === "thread.started" ||
          (event.type === "system" && event.subtype === "init")
        );
      })
    ) {
      return;
    }
    const db = set(writeDb$);
    const [run] = await db
      .select({
        id: agentRuns.id,
        agentId: agentRuns.agentId,
        chatThreadId: agentRuns.chatThreadId,
        launchSnapshot: agentRuns.launchSnapshot,
        officialWorkflowProvenance: agentRuns.officialWorkflowProvenance,
        createdAt: agentRuns.createdAt,
      })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.id, payload.runId),
          eq(agentRuns.userId, payload.context.userId),
          eq(agentRuns.orgId, payload.context.orgId),
        ),
      )
      .limit(1);
    if (!run) {
      throw new Error("Native session Run owner is unavailable");
    }
    const framework = run.launchSnapshot?.framework;
    if (!framework) {
      return;
    }
    const identities = payload.events.flatMap((event) => {
      const value =
        framework === "codex"
          ? event.type === "thread.started"
            ? event.thread_id
            : undefined
          : event.type === "system" && event.subtype === "init"
            ? event.session_id
            : undefined;
      return value === undefined ? [] : [nativeSessionId.parse(value)];
    });
    const sessionId = identities[0];
    if (sessionId === undefined) {
      return;
    }
    if (
      run.launchSnapshot?.schemaVersion === 5 &&
      framework === "pi" &&
      sessionId !== (run.chatThreadId ?? run.id) &&
      !(run.officialWorkflowProvenance && sessionId === run.id)
    ) {
      throw new Error("Pi reported an identity outside its captured launch");
    }
    if (
      identities.some((id) => {
        return id !== sessionId;
      })
    ) {
      throw new Error("Run emitted conflicting native session identities");
    }
    const [captured] = await db
      .update(agentRuns)
      .set({
        framework,
        frameworkSessionId: sessionId,
      })
      .where(
        and(
          eq(agentRuns.id, run.id),
          eq(agentRuns.userId, payload.context.userId),
          eq(agentRuns.orgId, payload.context.orgId),
          or(isNull(agentRuns.framework), eq(agentRuns.framework, framework)),
          or(
            isNull(agentRuns.frameworkSessionId),
            eq(agentRuns.frameworkSessionId, sessionId),
          ),
        ),
      )
      .returning({ id: agentRuns.id });
    if (!captured) {
      throw new Error("Run native session identity changed");
    }
    const binding = runNativeThreadBinding({
      run,
      owner: payload.context,
      framework,
      sessionId,
    });
    if (binding) {
      await db.update(chatThreads).set(binding.values).where(binding.condition);
    }
  },
);

/** Completion also supplies this identity if its initialization receipt was lost. */
export function runNativeThreadBinding(args: {
  readonly run: Pick<
    typeof agentRuns.$inferSelect,
    "id" | "agentId" | "chatThreadId" | "createdAt"
  >;
  readonly owner: { readonly userId: string; readonly orgId: string };
  readonly framework: string;
  readonly sessionId: string;
}) {
  const { run, owner, framework, sessionId } = args;
  if (!run.chatThreadId || !run.agentId) {
    return;
  }
  const builder = new QueryBuilder();
  return {
    values: {
      framework,
      frameworkSessionId: sessionId,
      frameworkSessionRunId: run.id,
    },
    condition: and(
      eq(chatThreads.id, run.chatThreadId),
      eq(chatThreads.userId, owner.userId),
      eq(chatThreads.agentId, run.agentId),
      exists(
        builder
          .select({ id: agentRuns.id })
          .from(agentRuns)
          .where(
            and(
              eq(agentRuns.id, run.id),
              eq(agentRuns.agentId, chatThreads.agentId),
              eq(agentRuns.userId, owner.userId),
              eq(agentRuns.orgId, owner.orgId),
              eq(agentRuns.framework, framework),
              eq(agentRuns.frameworkSessionId, sessionId),
            ),
          ),
      ),
      notExists(
        builder
          .select({ id: laterRun.id })
          .from(laterRun)
          .where(
            and(
              eq(laterRun.chatThreadId, chatThreads.id),
              ne(laterRun.id, run.id),
              gte(laterRun.createdAt, run.createdAt),
              isNotNull(laterRun.frameworkSessionId),
            ),
          ),
      ),
    ),
  };
}
