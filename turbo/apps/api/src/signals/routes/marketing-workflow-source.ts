import { marketingWorkflowSourceContract } from "@okouai/api-contracts/contracts/marketing-workflow-source";
import { createErrorResponse } from "@okouai/api-contracts/contracts/errors";
import { backgroundJobs } from "@okouai/db/schema/background-job";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { command, computed } from "ccstate";
import { and, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { timingSafeEqual } from "node:crypto";
import { env } from "../../lib/env";
import { marketingRewardSourceEventSchema } from "../../lib/marketing-reward-events";
import { nowDate } from "../../lib/time";
import { authorization$, setResHeader$ } from "../context/hono";
import { pathParamsOf } from "../context/request";
import { db$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  MARKETING_REWARD_EVENT_JOB_KIND,
  MARKETING_REWARD_WORKFLOW_EVENT_HANDLER_VERSION,
} from "../services/marketing-reward-event-publication";

const source$ = computed(async (get) => {
  const { eventId } = get(
    pathParamsOf(marketingWorkflowSourceContract.observe),
  );
  const [job] = await get(db$)
    .select()
    .from(backgroundJobs)
    .where(
      and(
        eq(backgroundJobs.id, eventId),
        eq(backgroundJobs.kind, MARKETING_REWARD_EVENT_JOB_KIND),
        eq(
          backgroundJobs.handlerVersion,
          MARKETING_REWARD_WORKFLOW_EVENT_HANDLER_VERSION,
        ),
      ),
    )
    .limit(1);
  if (!job) {
    return null;
  }
  const event = marketingRewardSourceEventSchema.parse(job.input);
  if (event.version !== 4) {
    throw new Error("Workflow source proof has a different version");
  }
  if (
    job.id !== event.id ||
    job.handlerVersion !== event.version ||
    job.orgId !== event.orgId ||
    job.userId !== event.userId ||
    event.environment !== env("ENV")
  ) {
    throw new Error("Workflow source proof does not match its durable owner");
  }
  return event;
});

function assertSourceOwnership(
  source: { readonly orgId: string; readonly userId: string },
  row: {
    readonly input: { readonly chatThreadId: string } | null;
    readonly revoker: { readonly chatThreadId: string } | null;
    readonly run: {
      readonly orgId: string;
      readonly userId: string;
      readonly chatThreadId: string | null;
    } | null;
  },
) {
  if (
    (row.input &&
      row.revoker &&
      row.input.chatThreadId !== row.revoker.chatThreadId) ||
    (row.input &&
      row.run &&
      row.run.chatThreadId !== null &&
      row.input.chatThreadId !== row.run.chatThreadId) ||
    (row.run &&
      (row.run.orgId !== source.orgId || row.run.userId !== source.userId))
  ) {
    throw new Error("Workflow source entities have different ownership");
  }
}

const observation$ = computed(async (get) => {
  const source = await get(source$);
  if (!source) {
    return null;
  }
  const input = alias(chatEvents, "source_input");
  const revoker = alias(chatEvents, "source_revoker");
  const capturedRunId =
    source.type === "workflow.input-queued" ? null : source.runId;
  const [row] = await get(db$)
    .select({
      input: { id: input.id, chatThreadId: input.chatThreadId },
      revoker: {
        id: revoker.id,
        eventType: revoker.eventType,
        runId: revoker.runId,
        chatThreadId: revoker.chatThreadId,
      },
      run: {
        id: agentRuns.id,
        orgId: agentRuns.orgId,
        userId: agentRuns.userId,
        status: agentRuns.status,
        completedAt: agentRuns.completedAt,
        chatThreadId: agentRuns.chatThreadId,
      },
    })
    .from(sql`(VALUES (1)) AS source_observation(dummy)`)
    .leftJoin(input, eq(input.id, source.sourceEventId))
    .leftJoin(revoker, eq(revoker.revokesEventId, source.sourceEventId))
    .leftJoin(
      agentRuns,
      capturedRunId
        ? eq(agentRuns.id, capturedRunId)
        : and(
            inArray(revoker.eventType, ["input.prompt", "input.automation"]),
            eq(agentRuns.id, revoker.runId),
          ),
    )
    .limit(1);
  if (!row) {
    throw new Error("Workflow source observation returned no context");
  }
  assertSourceOwnership(source, row);
  const envelope = {
    version: 1 as const,
    environment: source.environment,
    observedAt: nowDate().toISOString(),
    source: {
      eventId: source.id,
      type: source.type,
      occurredAt: source.occurredAt,
      orgId: source.orgId,
      actorUserId: source.userId,
      creatorUserId: source.creatorUserId,
      workflowId: source.workflowId,
      inputEventId: source.sourceEventId,
      runId: capturedRunId,
    },
  };
  if (row.run) {
    return {
      ...envelope,
      observation: {
        kind: "run" as const,
        runId: row.run.id,
        status: row.run.status,
        completedAt: row.run.completedAt?.toISOString() ?? null,
      },
    };
  }
  if (capturedRunId) {
    return { ...envelope, observation: { kind: "unavailable" as const } };
  }
  if (row.revoker) {
    return {
      ...envelope,
      observation: {
        kind:
          row.revoker.runId &&
          ["input.prompt", "input.automation"].includes(row.revoker.eventType)
            ? ("unavailable" as const)
            : ("replaced" as const),
      },
    };
  }
  return {
    ...envelope,
    observation: {
      kind: row.input ? ("queued" as const) : ("unavailable" as const),
    },
  };
});

const observe$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const secret = env("MARKETING_REWARDS_SOURCE_SECRET");
  if (!secret) {
    return {
      status: 503 as const,
      body: {
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "Workflow source observation is not configured",
        },
      },
    };
  }
  const actual = Buffer.from(get(authorization$) ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return createErrorResponse(
      "UNAUTHORIZED",
      "Invalid Workflow source credential",
    );
  }
  const result = await get(observation$);
  signal.throwIfAborted();
  return result
    ? { status: 200 as const, body: result }
    : createErrorResponse("NOT_FOUND", "Workflow source proof not found");
});

export const marketingWorkflowSourceRoutes: readonly RouteEntry[] = [
  { route: marketingWorkflowSourceContract.observe, handler: observe$ },
];
