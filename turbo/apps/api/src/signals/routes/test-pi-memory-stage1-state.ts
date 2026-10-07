import { observePiMemoryStage1Cost } from "../services/pi-memory-stage1-cost.service";
import { captureFixtureRunBilling } from "../services/billing-run-fixture";
import { usagePricingResolution$ } from "../context/usage-pricing-resolution";
import { agents } from "@okouai/db/schema/agent";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
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
import { and, asc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";

import { nowDate } from "../../lib/time";
import type { Tx } from "../../lib/db-types";
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
import { piMemoryStage1ModelPricingThreshold } from "../services/pi-memory-stage1-credential.service";
import { modelCatalog$ } from "../services/model-catalog.service";
import {
  PI_MEMORY_STAGE1_BUILT_IN_MODEL,
  PI_MEMORY_STAGE1_PERSONAL_MODEL,
  type PiMemoryStage1Model,
} from "@okouai/pi-agent-runtime/api";
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
const completedSourceSchema = candidateScopeSchema.extend({
  source_run_id: z.string().uuid(),
  source_history_hash: z.string().regex(/^[0-9a-f]{64}$/u),
});
const sourceBindingSchema = z.object({
  modelProvider: z.string().nullable(),
  modelProviderId: z.uuid().nullable(),
  modelProviderCredentialScope: z.string().nullable(),
  orgId: z.string().optional(),
  userId: z.string().optional(),
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
    source: sourceBindingSchema.optional(),
  }),
  candidateScopeSchema.extend({
    action: z.literal("replace"),
    source_history_hash: z.string().regex(/^[0-9a-f]{64}$/u),
    source_completed_at: z.iso.datetime(),
    encoding: encodingSchema,
    raw_size: z.number().int().positive(),
    encoded_size: z.number().int().positive(),
  }),
  completedSourceSchema.extend({
    action: z.literal("seed-legacy-pending-candidate"),
  }),
  completedSourceSchema.extend({
    action: z.literal("replace-published-history-reference"),
    expected_source_history_hash: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
  candidateScopeSchema.extend({ action: z.literal("inspect") }),
  candidateScopeSchema.extend({
    action: z.literal("source-binding"),
    source: sourceBindingSchema,
  }),
  candidateScopeSchema.extend({ action: z.literal("delete-source") }),
  candidateScopeSchema.extend({
    action: z.literal("record-usage"),
    source_history_hash: z.string(),
    response_source_id: z.string(),
    billing_mode: z.enum(["builtin", "subscription"]),
    usage: z.object({
      input: z.number(),
      output: z.number(),
      cacheRead: z.number(),
      cacheWrite: z.number(),
    }),
  }),
  ownerSchema.extend({
    action: z.literal("run"),
    pi_session_id: z.string().uuid().optional(),
    current_time: z.iso.datetime().optional(),
  }),
  candidateScopeSchema.extend({ action: z.literal("expire-lease") }),
  candidateScopeSchema.extend({ action: z.literal("make-retry-due") }),
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
  receipt: z
    .object({
      disposition: z.enum([
        "new",
        "replay",
        "legacy_replay",
        "zero_usage",
        "subscription",
      ]),
      accountingAt: z.iso.datetime().nullable(),
    })
    .optional(),
  object_key: z.string().optional(),
  state: candidateStateSchema.nullable().optional(),
  worker: workerResultSchema.optional(),
  run_id: z.string().uuid().optional(),
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
type CompletedSourceScope = z.infer<typeof completedSourceSchema>;

function actionOk(extra: Record<string, unknown> = {}) {
  return { status: 200 as const, body: { ok: true as const, ...extra } };
}

function candidateCondition(scope: CandidateScope) {
  return and(
    eq(piMemoryStage1Candidates.memoryStorageId, scope.memory_storage_id),
    eq(piMemoryStage1Candidates.piSessionId, scope.pi_session_id),
  );
}

function startupFixtureValues(
  body: Extract<TestPiMemoryStage1StateActionBody, { action: "seed" }>,
  sessionId: string,
  triggerThreadId: string,
) {
  return {
    sessionId,
    orgId: body.org_id,
    userId: body.user_id,
    status: "pending",
    prompt: "startup fixture",
    chatThreadId: triggerThreadId,
    triggerSource: "web",
    autonomyBudget: 0,
    launchSnapshot: {
      schemaVersion: 3 as const,
      framework: "pi" as const,
      runnerProfile: DEFAULT_PROFILE,
    },
  };
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
  await db.transaction(async (tx) => {
    await tx.insert(agentRuns).values({
      id: sourceRunId,
      modelProvider: "built-in",
      selectedModel: "gpt-6-astra",
      reasoningEffort: "high",
      codexServiceTier: "fast",
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
      ...body.source,
    });
    await captureFixtureRunBilling(tx, sourceRunId);
  });
  await db.insert(conversations).values({
    runId: sourceRunId,
    cliAgentType: "pi",
    cliAgentSessionId: body.pi_session_id,
    cliAgentSessionHistoryHash: body.source_history_hash,
  });
  const trigger = await db.transaction(async (tx) => {
    const [run] = await tx
      .insert(agentRuns)
      .values(startupFixtureValues(body, sessionId, triggerThreadId))
      .returning();
    if (!run) {
      throw new Error("Missing startup fixture");
    }
    await captureFixtureRunBilling(tx, run.id);
    return run;
  });
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
    run_id: sourceRunId,
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

async function requireOwnedCompletedSource(
  tx: Tx,
  scope: CompletedSourceScope,
  expectedHash: string,
  signal: AbortSignal,
) {
  const [memory] = await tx
    .select({ id: storages.id })
    .from(storages)
    .where(
      and(
        eq(storages.id, scope.memory_storage_id),
        eq(storages.orgId, scope.org_id),
        eq(storages.userId, scope.user_id),
        eq(storages.name, MEMORY_ARTIFACT_NAME),
      ),
    )
    .for("no key update");
  signal.throwIfAborted();
  if (!memory) {
    throw new Error("Missing owned public Memory source");
  }
  const [source] = await tx
    .select({
      completedAt: agentRuns.completedAt,
      launchSnapshot: agentRuns.launchSnapshot,
      conversationId: conversations.id,
    })
    .from(agentRuns)
    .innerJoin(agentSessions, eq(agentSessions.id, agentRuns.sessionId))
    .innerJoin(agents, eq(agents.id, agentSessions.agentId))
    .innerJoin(
      chatThreads,
      and(
        eq(chatThreads.id, agentRuns.chatThreadId),
        eq(chatThreads.agentId, agents.id),
      ),
    )
    .innerJoin(conversations, eq(conversations.runId, agentRuns.id))
    .where(
      and(
        eq(agentRuns.id, scope.source_run_id),
        eq(agentRuns.orgId, scope.org_id),
        eq(agentRuns.userId, scope.user_id),
        eq(agentRuns.status, "completed"),
        eq(agentSessions.orgId, scope.org_id),
        eq(agentSessions.userId, scope.user_id),
        eq(agents.orgId, scope.org_id),
        eq(agents.owner, scope.user_id),
        eq(chatThreads.id, scope.pi_session_id),
        eq(chatThreads.userId, scope.user_id),
        eq(conversations.cliAgentType, "pi"),
        eq(conversations.cliAgentSessionId, scope.pi_session_id),
        eq(conversations.cliAgentSessionHistoryHash, expectedHash),
      ),
    )
    .for("update", { of: agentRuns });
  signal.throwIfAborted();
  if (!source?.completedAt || source.launchSnapshot?.framework !== "pi") {
    throw new Error("Missing exact completed public Pi source");
  }
  return {
    completedAt: source.completedAt,
    conversationId: source.conversationId,
  };
}

// #37440 key33: only the historical unscheduled candidate is impossible to
// publish. Its owner, Memory, Run, Session, Thread and history already exist.
async function seedLegacyPendingCandidate(
  db: Db,
  body: CompletedSourceScope,
  signal: AbortSignal,
) {
  await db.transaction(async (tx) => {
    const source = await requireOwnedCompletedSource(
      tx,
      body,
      body.source_history_hash,
      signal,
    );
    signal.throwIfAborted();
    const inserted = await insertPiMemoryStage1Candidates(tx, [
      {
        memoryStorageId: body.memory_storage_id,
        orgId: body.org_id,
        userId: body.user_id,
        piSessionId: body.pi_session_id,
        sourceRunId: body.source_run_id,
        sourceHistoryHash: body.source_history_hash,
        sourceCompletedAt: source.completedAt,
        eligibleAt: new Date(source.completedAt.getTime() + 1),
        status: "pending",
        retryCount: 2,
      },
    ]);
    if (inserted.length !== 1) {
      throw new Error("Expected one owned historical pending candidate");
    }
    signal.throwIfAborted();
  });
  return actionOk();
}

// #37440 key33: completed Pi checkpoint validation rejects these exact bad
// inputs. Metadata and ordinary source state are public; only this pointer
// bypasses validation, with both conversation references transferred atomically.
async function replacePublishedHistoryReference(
  db: Db,
  body: Extract<
    TestPiMemoryStage1StateActionBody,
    { action: "replace-published-history-reference" }
  >,
  signal: AbortSignal,
) {
  if (body.expected_source_history_hash === body.source_history_hash) {
    throw new Error("Expected a different prepared invalid history");
  }
  await db.transaction(async (tx) => {
    const source = await requireOwnedCompletedSource(
      tx,
      body,
      body.expected_source_history_hash,
      signal,
    );
    const locked = await tx
      .select({ hash: blobs.hash })
      .from(blobs)
      .where(
        inArray(blobs.hash, [
          body.expected_source_history_hash,
          body.source_history_hash,
        ]),
      )
      .orderBy(asc(blobs.hash))
      .for("update");
    if (locked.length !== 2) {
      throw new Error("Expected both publicly prepared history blobs");
    }
    const [retained] = await tx
      .update(blobs)
      .set({ refCount: sql`${blobs.refCount} + 1` })
      .where(eq(blobs.hash, body.source_history_hash))
      .returning({ hash: blobs.hash });
    const [released] = await tx
      .update(blobs)
      .set({ refCount: sql`${blobs.refCount} - 1` })
      .where(
        and(
          eq(blobs.hash, body.expected_source_history_hash),
          gte(blobs.refCount, 1),
        ),
      )
      .returning({ hash: blobs.hash });
    if (!retained || !released) {
      throw new Error("Missing retained public conversation history");
    }
    const [changed] = await tx
      .update(conversations)
      .set({ cliAgentSessionHistoryHash: body.source_history_hash })
      .where(
        and(
          eq(conversations.id, source.conversationId),
          eq(
            conversations.cliAgentSessionHistoryHash,
            body.expected_source_history_hash,
          ),
        ),
      )
      .returning({ id: conversations.id });
    if (!changed) {
      throw new Error("Public source history changed during fixture input");
    }
    signal.throwIfAborted();
  });
  return actionOk();
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

async function mutateSource(
  db: Db,
  body: Extract<
    TestPiMemoryStage1StateActionBody,
    { action: "source-binding" | "delete-source" }
  >,
  signal: AbortSignal,
) {
  const [candidate] = await db
    .select({ sourceRunId: piMemoryStage1Candidates.sourceRunId })
    .from(piMemoryStage1Candidates)
    .where(candidateCondition(body));
  if (!candidate) {
    throw new Error("Missing source fixture");
  }
  if (body.action === "source-binding") {
    await db
      .update(agentRuns)
      .set(body.source)
      .where(eq(agentRuns.id, candidate.sourceRunId));
  } else {
    await db.delete(agentRuns).where(eq(agentRuns.id, candidate.sourceRunId));
  }
  signal.throwIfAborted();
  return actionOk();
}

const runScopedWorker$ = command(
  async (
    { set },
    body: Extract<TestPiMemoryStage1StateActionBody, { action: "run" }>,
    signal: AbortSignal,
  ) => {
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
  },
);

/** Billing mode follows the binding split the credential resolver applies. */
function stage1ModelForBillingMode(
  mode: "builtin" | "subscription",
): PiMemoryStage1Model {
  return mode === "builtin"
    ? PI_MEMORY_STAGE1_BUILT_IN_MODEL
    : PI_MEMORY_STAGE1_PERSONAL_MODEL;
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
    case "source-binding":
    case "delete-source": {
      return await mutateSource(db, body, signal);
    }
    case "record-usage": {
      const args = {
        memoryStorageId: body.memory_storage_id,
        piSessionId: body.pi_session_id,
        sourceHistoryHash: body.source_history_hash,
        model: stage1ModelForBillingMode(body.billing_mode),
        longContextMinTotalInputTokens: piMemoryStage1ModelPricingThreshold(
          await get(modelCatalog$),
          stage1ModelForBillingMode(body.billing_mode),
        ),
        responseSourceId: body.response_source_id,
        billing: {
          mode: body.billing_mode,
          orgId: body.org_id,
          userId: body.user_id,
        },
        usage: body.usage,
      };
      const receipt = await recordPiMemoryStage1Usage(db, args);
      signal.throwIfAborted();
      await observePiMemoryStage1Cost(
        db,
        args,
        receipt,
        get(usagePricingResolution$),
      );
      signal.throwIfAborted();
      return actionOk({ receipt });
    }
    case "seed": {
      return await seedCandidate(db, body, signal);
    }
    case "replace": {
      return await replaceCandidate(db, body, signal);
    }
    case "seed-legacy-pending-candidate": {
      return await seedLegacyPendingCandidate(db, body, signal);
    }
    case "replace-published-history-reference": {
      return await replacePublishedHistoryReference(db, body, signal);
    }
    case "inspect": {
      return await inspectCandidate(db, body, signal);
    }
    case "run": {
      return await set(runScopedWorker$, body, signal);
    }
    case "expire-lease": {
      return await updateCandidateTime(db, body, "leaseExpiresAt", signal);
    }
    case "make-retry-due": {
      return await updateCandidateTime(db, body, "retryAt", signal);
    }
    case "seed-usage-collision": {
      await recordPiMemoryStage1Usage(db, {
        memoryStorageId: body.memory_storage_id,
        piSessionId: body.pi_session_id,
        sourceHistoryHash: body.source_history_hash,
        model: PI_MEMORY_STAGE1_BUILT_IN_MODEL,
        longContextMinTotalInputTokens: null,
        billing: {
          mode: "builtin",
          orgId: `${body.org_id}_collision`,
          userId: `${body.user_id}_collision`,
        },
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
