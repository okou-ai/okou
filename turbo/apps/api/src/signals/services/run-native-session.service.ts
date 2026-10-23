import { agentRuns } from "@okouai/db/runtime/agent-run";
import { nativeThreadBindingSql } from "@okouai/db/operations/native-thread-binding";
import { and, eq, isNull, or } from "drizzle-orm";
import { command } from "ccstate";
import { nativeContinuationSchema } from "@okouai/api-contracts/contracts/runners";
import type { EventConsumerPayload } from "../../lib/event-consumer/verify";
import { writeDb$ } from "../external/db";

const nativeSessionId = nativeContinuationSchema.shape.sessionId.unwrap();

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
      sessionId !==
        (run.officialWorkflowProvenance ? run.id : (run.chatThreadId ?? run.id))
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
    const binding = nativeThreadBindingSql({
      run,
      owner: payload.context,
      framework,
      sessionId,
    });
    if (binding) {
      await db.execute(binding);
    }
  },
);
