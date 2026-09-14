import { agents } from "@okouai/db/schema/agent";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import {
  piMemoryStage1Days,
  piMemoryStage1Watermarks,
} from "@okouai/db/schema/pi-memory-stage1-schedule";
import {
  DEFAULT_PROFILE,
  SESSION_HISTORY_ENCODING_GZIP,
  SESSION_HISTORY_ENCODING_IDENTITY,
  SESSION_HISTORY_ENCODING_ZSTD,
} from "@okouai/api-contracts/contracts/runners";
import { requestPiMemoryStage1Day } from "../services/pi-memory-stage1-schedule.service";
import { randomUUID } from "node:crypto";

import { initContract } from "@okouai/api-contracts/contracts/trpc-contract";
import { MEMORY_ARTIFACT_NAME } from "@okouai/core/storage-names";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { blobs } from "@okouai/db/schema/blob";
import { conversations } from "@okouai/db/schema/conversation";
import { piMemoryStage1Candidates } from "@okouai/db/schema/pi-memory-stage1-candidate";
import { storages } from "@okouai/db/schema/storage";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { command } from "ccstate";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";

import { nowDate } from "../../lib/time";
import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { type Db, writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  insertPiMemoryStage1Candidates,
  deleteStoragesWithPiMemoryCandidates,
} from "../services/pi-memory-stage1-candidate.service";
import {
  executePiMemoryStage1Work$,
  type PiMemoryStage1WorkerResult,
} from "../services/pi-memory-stage1-worker.service";
import { recordPiMemoryStage1Usage } from "../services/pi-memory-stage1-usage.service";
import { resumeSessionHistoryBlobKey } from "../services/session-history-blobs";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const encodingSchema = z.enum([
  SESSION_HISTORY_ENCODING_IDENTITY,
  SESSION_HISTORY_ENCODING_GZIP,
  SESSION_HISTORY_ENCODING_ZSTD,
]);
const ownerSchema = z.object({
  memory_storage_id: z.string().uuid(),
  org_id: z.string().min(1),
  user_id: z.string().min(1),
});
const candidateScopeSchema = ownerSchema.extend({
  pi_session_id: z.string().uuid(),
});
const actionBodySchema = z.discriminatedUnion("action", [
  candidateScopeSchema.extend({
    action: z.literal("seed"),
    source_history_hash: z.string().regex(/^[0-9a-f]{64}$/u),
    source_completed_at: z.iso.datetime(),
    encoding: encodingSchema,
    raw_size: z.number().int().positive(),
    encoded_size: z.number().int().positive(),
    retry_count: z.number().int().nonnegative().optional(),
  }),
  candidateScopeSchema.extend({
    action: z.literal("replace"),
    source_history_hash: z.string().regex(/^[0-9a-f]{64}$/u),
    source_completed_at: z.iso.datetime(),
    encoding: encodingSchema,
    raw_size: z.number().int().positive(),
    encoded_size: z.number().int().positive(),
  }),
  candidateScopeSchema.extend({ action: z.literal("inspect") }),
  ownerSchema.extend({
    action: z.literal("run"),
    pi_session_id: z.string().uuid().optional(),
    current_time: z.iso.datetime().optional(),
  }),
  candidateScopeSchema.extend({ action: z.literal("expire-lease") }),
  candidateScopeSchema.extend({ action: z.literal("make-retry-due") }),
  candidateScopeSchema.extend({ action: z.literal("create-active-run") }),
  z.object({
    action: z.literal("complete-active-run"),
    run_id: z.string().uuid(),
  }),
  candidateScopeSchema.extend({
    action: z.literal("seed-usage-collision"),
    source_history_hash: z.string().regex(/^[0-9a-f]{64}$/u),
    response_source_id: z.string().min(1),
  }),
  ownerSchema.extend({ action: z.literal("inspect-usage") }),
  ownerSchema.extend({ action: z.literal("delete-owner") }),
  ownerSchema.extend({
    action: z.literal("cleanup"),
    source_history_hashes: z.array(z.string().regex(/^[0-9a-f]{64}$/u)),
    agent_session_ids: z.array(z.string().uuid()),
  }),
]);

const candidateStateSchema = z.object({
  status: z.string(),
  retry_count: z.number().int().nonnegative(),
  retry_at: z.iso.datetime().nullable(),
  last_error_class: z.string().nullable(),
  successful_source_history_hash: z.string().nullable(),
  raw_memory: z.string().nullable(),
  rollout_summary: z.string().nullable(),
  rollout_slug: z.string().nullable(),
});
const workerResultSchema = z.object({
  scanned: z.number().int().nonnegative(),
  claimed: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  succeededNoOutput: z.number().int().nonnegative(),
  retryableFailure: z.number().int().nonnegative(),
  terminalFailure: z.number().int().nonnegative(),
  sourceExpired: z.number().int().nonnegative(),
  sourceActive: z.number().int().nonnegative(),
  staleDiscarded: z.number().int().nonnegative(),
});
const responseSchema = z.object({
  ok: z.literal(true),
  object_key: z.string().optional(),
  state: candidateStateSchema.nullable().optional(),
  worker: workerResultSchema.optional(),
  run_id: z.string().uuid().optional(),
  agent_session_id: z.string().uuid().optional(),
  usage: z
    .array(
      z.object({
        run_id: z.string().uuid().nullable(),
        provider: z.string(),
        category: z.string(),
      }),
    )
    .optional(),
});

const c = initContract();
export const testPiMemoryStage1StateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/pi-memory-stage1-state/action",
    body: actionBodySchema,
    responses: {
      200: responseSchema,
      400: z.object({ error: z.unknown() }),
      404: z.string(),
    },
  },
});

export type TestPiMemoryStage1StateActionBody = z.infer<
  typeof actionBodySchema
>;
export type TestPiMemoryStage1StateResponse = z.infer<typeof responseSchema>;

const actionBody$ = bodyResultOf(testPiMemoryStage1StateContract.action);

type CandidateScope = z.infer<typeof candidateScopeSchema>;
type OwnerScope = z.infer<typeof ownerSchema>;

function actionOk(extra: Record<string, unknown> = {}) {
  return { status: 200 as const, body: { ok: true as const, ...extra } };
}

function candidateCondition(scope: CandidateScope) {
  return and(
    eq(piMemoryStage1Candidates.memoryStorageId, scope.memory_storage_id),
    eq(piMemoryStage1Candidates.piSessionId, scope.pi_session_id),
  );
}

async function seedCandidate(
  db: Db,
  body: Extract<TestPiMemoryStage1StateActionBody, { action: "seed" }>,
  signal: AbortSignal,
) {
  await db
    .insert(storages)
    .values({
      id: body.memory_storage_id,
      orgId: body.org_id,
      userId: body.user_id,
      name: MEMORY_ARTIFACT_NAME,
      s3Prefix: `${body.org_id}/artifacts/${body.memory_storage_id}`,
    })
    .onConflictDoNothing();
  signal.throwIfAborted();
  await db
    .insert(blobs)
    .values({
      hash: body.source_history_hash,
      rawSize: body.raw_size,
      encoding: body.encoding,
      encodedSize: body.encoded_size,
    })
    .onConflictDoNothing();
  signal.throwIfAborted();
  const completedAt = new Date(body.source_completed_at);
  const agentId = randomUUID();
  const sessionId = randomUUID();
  const sourceRunId = randomUUID();
  const sourceThreadId = randomUUID();
  const triggerThreadId = randomUUID();
  await db.insert(agents).values({
    id: agentId,
    orgId: body.org_id,
    owner: body.user_id,
    name: agentId,
  });
  await db.insert(agentSessions).values({
    id: sessionId,
    orgId: body.org_id,
    userId: body.user_id,
    agentId,
  });
  await db.insert(chatThreads).values([
    {
      id: sourceThreadId,
      agentId,
      userId: body.user_id,
      lastMessageAt: completedAt,
    },
    { id: triggerThreadId, agentId, userId: body.user_id },
  ]);
  const launchSnapshot = {
    schemaVersion: 3 as const,
    framework: "pi" as const,
    runnerProfile: DEFAULT_PROFILE,
  };
  await db.insert(agentRuns).values({
    id: sourceRunId,
    sessionId,
    orgId: body.org_id,
    userId: body.user_id,
    status: "completed",
    prompt: "source fixture",
    chatThreadId: sourceThreadId,
    triggerSource: "web",
    autonomyBudget: 0,
    launchSnapshot,
    createdAt: completedAt,
    completedAt,
  });
  await db.insert(conversations).values({
    runId: sourceRunId,
    cliAgentType: "pi",
    cliAgentSessionId: body.pi_session_id,
    cliAgentSessionHistoryHash: body.source_history_hash,
  });
  const [trigger] = await db
    .insert(agentRuns)
    .values({
      sessionId,
      orgId: body.org_id,
      userId: body.user_id,
      status: "queued",
      prompt: "startup fixture",
      chatThreadId: triggerThreadId,
      triggerSource: "web",
      autonomyBudget: 0,
      launchSnapshot,
    })
    .returning();
  if (!trigger) {
    throw new Error("Missing startup fixture");
  }
  await db.transaction(async (tx) => {
    await requestPiMemoryStage1Day(tx, trigger);
  });

  await db.transaction(async (tx) => {
    await insertPiMemoryStage1Candidates(tx, [
      {
        memoryStorageId: body.memory_storage_id,
        orgId: body.org_id,
        userId: body.user_id,
        piSessionId: body.pi_session_id,
        sourceRunId,
        sourceHistoryHash: body.source_history_hash,
        sourceCompletedAt: completedAt,
        eligibleAt: new Date(completedAt.getTime() + 1),
        status: "pending",
        retryCount: body.retry_count ?? 0,
      },
    ]);
  });
  signal.throwIfAborted();
  return actionOk({
    object_key: resumeSessionHistoryBlobKey(
      body.source_history_hash,
      body.encoding,
    ),
  });
}

async function inspectCandidate(
  db: Db,
  scope: CandidateScope,
  signal: AbortSignal,
) {
  const [row] = await db
    .select({
      status: piMemoryStage1Candidates.status,
      retryCount: piMemoryStage1Candidates.retryCount,
      retryAt: piMemoryStage1Candidates.retryAt,
      lastErrorClass: piMemoryStage1Candidates.lastErrorClass,
      rawMemory: piMemoryStage1Candidates.rawMemory,
      rolloutSummary: piMemoryStage1Candidates.rolloutSummary,
      rolloutSlug: piMemoryStage1Candidates.rolloutSlug,
      successfulSourceHistoryHash: piMemoryStage1Watermarks.sourceHistoryHash,
    })
    .from(piMemoryStage1Candidates)
    .leftJoin(agentRuns, eq(agentRuns.id, piMemoryStage1Candidates.sourceRunId))
    .leftJoin(
      piMemoryStage1Watermarks,
      and(
        eq(piMemoryStage1Watermarks.chatThreadId, agentRuns.chatThreadId),
        eq(piMemoryStage1Watermarks.userId, scope.user_id),
      ),
    )
    .where(candidateCondition(scope))
    .limit(1);
  signal.throwIfAborted();
  return actionOk({
    state: row
      ? {
          status: row.status,
          retry_count: row.retryCount,
          retry_at: row.retryAt?.toISOString() ?? null,
          last_error_class: row.lastErrorClass,
          raw_memory: row.rawMemory,
          rollout_summary: row.rolloutSummary,
          rollout_slug: row.rolloutSlug,
          successful_source_history_hash: row.successfulSourceHistoryHash,
        }
      : null,
  });
}

async function replaceCandidate(
  db: Db,
  body: Extract<TestPiMemoryStage1StateActionBody, { action: "replace" }>,
  signal: AbortSignal,
) {
  await db
    .insert(blobs)
    .values({
      hash: body.source_history_hash,
      rawSize: body.raw_size,
      encoding: body.encoding,
      encodedSize: body.encoded_size,
    })
    .onConflictDoNothing();
  signal.throwIfAborted();
  const completedAt = new Date(body.source_completed_at);
  await db
    .update(piMemoryStage1Candidates)
    .set({
      sourceRunId: randomUUID(),
      sourceHistoryHash: body.source_history_hash,
      sourceCompletedAt: completedAt,
      eligibleAt: new Date(completedAt.getTime() + 1),
      status: "pending",
      leaseToken: null,
      leaseExpiresAt: null,
      retryAt: null,
      retryCount: 0,
      lastErrorClass: null,
      rawMemory: null,
      rolloutSummary: null,
      rolloutSlug: null,
      generatedAt: null,
      lastSelectedSourceHistoryHash: null,
    })
    .where(candidateCondition(body));
  signal.throwIfAborted();
  return actionOk({
    object_key: resumeSessionHistoryBlobKey(
      body.source_history_hash,
      body.encoding,
    ),
  });
}

async function updateCandidateTime(
  db: Db,
  scope: CandidateScope,
  field: "leaseExpiresAt" | "retryAt",
  signal: AbortSignal,
) {
  await db
    .update(piMemoryStage1Candidates)
    .set({ [field]: new Date(nowDate().getTime() - 1) })
    .where(candidateCondition(scope));
  signal.throwIfAborted();
  return actionOk();
}

async function createActiveRun(
  db: Db,
  scope: CandidateScope,
  signal: AbortSignal,
) {
  const [source] = await db
    .select({
      sessionId: agentRuns.sessionId,
      chatThreadId: agentRuns.chatThreadId,
    })
    .from(agentRuns)
    .innerJoin(
      piMemoryStage1Candidates,
      eq(piMemoryStage1Candidates.sourceRunId, agentRuns.id),
    )
    .where(candidateCondition(scope));
  if (!source) {
    throw new Error("Missing active source fixture");
  }
  const runId = randomUUID();
  await db.insert(agentRuns).values({
    id: runId,
    orgId: scope.org_id,
    userId: scope.user_id,
    sessionId: source.sessionId,
    chatThreadId: source.chatThreadId,
    status: "queued",
    prompt: "fresh continuation without a checkpoint",
    triggerSource: "web",
    autonomyBudget: 0,
  });
  signal.throwIfAborted();
  return actionOk({ run_id: runId, agent_session_id: source.sessionId });
}

async function inspectUsage(db: Db, owner: OwnerScope, signal: AbortSignal) {
  const rows = await db
    .select({
      runId: usageEvent.runId,
      provider: usageEvent.provider,
      category: usageEvent.category,
    })
    .from(usageEvent)
    .where(
      and(
        eq(usageEvent.orgId, owner.org_id),
        eq(usageEvent.userId, owner.user_id),
        isNull(usageEvent.runId),
      ),
    );
  signal.throwIfAborted();
  return actionOk({
    usage: rows.map((row) => {
      return {
        run_id: row.runId,
        provider: row.provider,
        category: row.category,
      };
    }),
  });
}

async function cleanupFixture(
  db: Db,
  body: Extract<TestPiMemoryStage1StateActionBody, { action: "cleanup" }>,
  signal: AbortSignal,
) {
  if (body.agent_session_ids.length > 0) {
    await db
      .delete(agentSessions)
      .where(inArray(agentSessions.id, body.agent_session_ids));
    signal.throwIfAborted();
  }
  await db.transaction(async (tx) => {
    await deleteStoragesWithPiMemoryCandidates(
      tx,
      eq(storages.id, body.memory_storage_id),
    );
  });
  await db
    .delete(agents)
    .where(and(eq(agents.orgId, body.org_id), eq(agents.owner, body.user_id)));
  await db
    .delete(piMemoryStage1Days)
    .where(eq(piMemoryStage1Days.userId, body.user_id));
  signal.throwIfAborted();
  await db
    .delete(usageEvent)
    .where(
      or(
        and(
          eq(usageEvent.orgId, body.org_id),
          eq(usageEvent.userId, body.user_id),
        ),
        and(
          eq(usageEvent.orgId, `${body.org_id}_collision`),
          eq(usageEvent.userId, `${body.user_id}_collision`),
        ),
      ),
    );
  signal.throwIfAborted();
  if (body.source_history_hashes.length > 0) {
    await db
      .delete(blobs)
      .where(inArray(blobs.hash, body.source_history_hashes));
    signal.throwIfAborted();
  }
  return actionOk();
}

const action$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!isTestEndpointAllowed(get(request$))) {
    return testEndpointNotFoundResponse();
  }
  const bodyResult = await get(actionBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const db = set(writeDb$);
  const body = bodyResult.data;
  switch (body.action) {
    case "seed": {
      return await seedCandidate(db, body, signal);
    }
    case "replace": {
      return await replaceCandidate(db, body, signal);
    }
    case "inspect": {
      return await inspectCandidate(db, body, signal);
    }
    case "run": {
      const worker: PiMemoryStage1WorkerResult = await set(
        executePiMemoryStage1Work$,
        {
          scope: {
            memoryStorageIds: [body.memory_storage_id],
            ...(body.pi_session_id ? { piSessionId: body.pi_session_id } : {}),
          },
          currentTime: body.current_time
            ? new Date(body.current_time)
            : nowDate(),
        },
        signal,
      );
      return actionOk({ worker });
    }
    case "expire-lease": {
      return await updateCandidateTime(db, body, "leaseExpiresAt", signal);
    }
    case "make-retry-due": {
      return await updateCandidateTime(db, body, "retryAt", signal);
    }
    case "create-active-run": {
      return await createActiveRun(db, body, signal);
    }
    case "complete-active-run": {
      await db
        .update(agentRuns)
        .set({ status: "completed", completedAt: nowDate() })
        .where(eq(agentRuns.id, body.run_id));
      signal.throwIfAborted();
      return actionOk();
    }
    case "seed-usage-collision": {
      await recordPiMemoryStage1Usage(db, {
        memoryStorageId: body.memory_storage_id,
        piSessionId: body.pi_session_id,
        sourceHistoryHash: body.source_history_hash,
        orgId: `${body.org_id}_collision`,
        userId: `${body.user_id}_collision`,
        responseSourceId: body.response_source_id,
        usage: { input: 10, output: 8, cacheRead: 2, cacheWrite: 3 },
      });
      signal.throwIfAborted();
      return actionOk();
    }
    case "inspect-usage": {
      return await inspectUsage(db, body, signal);
    }
    case "delete-owner": {
      await db.transaction(async (tx) => {
        await deleteStoragesWithPiMemoryCandidates(
          tx,
          eq(storages.id, body.memory_storage_id),
        );
      });
      signal.throwIfAborted();
      return actionOk();
    }
    case "cleanup": {
      return await cleanupFixture(db, body, signal);
    }
  }
});

export const testPiMemoryStage1StateRoutes: readonly RouteEntry[] = [
  { route: testPiMemoryStage1StateContract.action, handler: action$ },
];
