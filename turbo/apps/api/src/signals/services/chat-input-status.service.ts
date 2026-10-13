import type { ChatInputStatusResponse } from "@okouai/api-contracts/contracts/chat-input-status";
import { runStatusSchema } from "@okouai/api-contracts/contracts/runs";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { agents } from "@okouai/db/schema/agent";
import { computed, type Computed } from "ccstate";
import { and, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db$ } from "../external/db";

interface ChatInputIdentity {
  readonly userId: string;
  readonly orgId: string;
  readonly threadId: string;
  readonly eventId: string;
}

interface EventCoordinate {
  readonly id: string;
  readonly seqId: number;
  readonly createdAt: Date;
}

function coordinate(event: EventCoordinate | null) {
  return event === null
    ? null
    : {
        eventId: event.id,
        seqId: event.seqId,
        createdAt: event.createdAt.toISOString(),
      };
}

function runMetadata(
  run: Pick<
    typeof agentRuns.$inferSelect,
    "status" | "createdAt" | "startedAt" | "completedAt"
  > | null,
) {
  return run === null
    ? null
    : {
        status: runStatusSchema.parse(run.status),
        createdAt: run.createdAt.toISOString(),
        startedAt: run.startedAt?.toISOString() ?? null,
        completedAt: run.completedAt?.toISOString() ?? null,
      };
}

/** One statement snapshot; no payloads, history pagination, writes or archive I/O. */
export function chatInputStatus(
  identity$: Computed<Promise<ChatInputIdentity>>,
) {
  return computed(async (get) => {
    const args = await get(identity$);
    const original = alias(chatEvents, "observed_input");
    const replacement = alias(chatEvents, "observed_input_replacement");
    const [observed] = await get(db$)
      .select({
        threadId: chatThreads.id,
        original: {
          id: original.id,
          seqId: original.seqId,
          createdAt: original.createdAt,
          eventType: original.eventType,
          runId: original.runId,
        },
        replacement: {
          id: replacement.id,
          seqId: replacement.seqId,
          createdAt: replacement.createdAt,
          eventType: replacement.eventType,
          runId: replacement.runId,
        },
        run: {
          id: agentRuns.id,
          status: agentRuns.status,
          createdAt: agentRuns.createdAt,
          startedAt: agentRuns.startedAt,
          completedAt: agentRuns.completedAt,
        },
      })
      .from(chatThreads)
      .innerJoin(
        agents,
        and(eq(agents.id, chatThreads.agentId), eq(agents.orgId, args.orgId)),
      )
      .leftJoin(
        original,
        and(
          eq(original.id, args.eventId),
          eq(original.chatThreadId, chatThreads.id),
        ),
      )
      .leftJoin(
        replacement,
        and(
          eq(replacement.revokesEventId, args.eventId),
          eq(replacement.chatThreadId, chatThreads.id),
        ),
      )
      .leftJoin(
        agentRuns,
        and(
          eq(agentRuns.id, replacement.runId),
          eq(agentRuns.chatThreadId, chatThreads.id),
          eq(agentRuns.userId, args.userId),
          eq(agentRuns.orgId, args.orgId),
        ),
      )
      .where(
        and(
          eq(chatThreads.id, args.threadId),
          eq(chatThreads.userId, args.userId),
        ),
      )
      .limit(1);
    if (!observed) {
      return { kind: "thread-not-found" as const };
    }
    const source = observed.original;
    const consumer = observed.replacement;
    if (
      source &&
      (source.runId !== null ||
        (source.eventType !== "input.prompt" &&
          source.eventType !== "input.automation"))
    ) {
      return { kind: "invalid-input" as const };
    }

    const base = {
      threadId: observed.threadId,
      eventId: args.eventId,
      input: coordinate(source),
      replacement: coordinate(consumer),
    };
    let response: ChatInputStatusResponse;
    if (consumer?.eventType === "input.prompt" && consumer.runId !== null) {
      response = {
        ...base,
        status: "consumed",
        runId: consumer.runId,
        run: runMetadata(observed.run),
      };
    } else {
      let status: "queued" | "rejected" | "revoked" | "unavailable";
      if (consumer?.eventType === "input.rejected") {
        status = "rejected";
      } else if (consumer?.eventType === "control.revoke") {
        status = "revoked";
      } else if (source && consumer) {
        throw new Error("Original chat input has an invalid replacement");
      } else {
        status = source ? "queued" : "unavailable";
      }
      response = { ...base, status, runId: null, run: null };
    }
    return { kind: "observed" as const, response };
  });
}
