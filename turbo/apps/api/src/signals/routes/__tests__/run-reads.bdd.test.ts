import { createHash, randomUUID } from "node:crypto";
import { gzipSync, zstdCompressSync } from "node:zlib";

import { createStore } from "ccstate";
import {
  CANONICAL_CLAUDE_MEMORY_MOUNT_PATH,
  SESSION_HISTORY_DOWNLOAD_SOURCE_CONFIGURED_PUBLIC_ENDPOINT,
  SESSION_HISTORY_DOWNLOAD_SOURCE_DEFAULT_R2_ENDPOINT,
} from "@okouai/api-contracts/contracts/runners";
import { delay } from "signal-timers";
import { describe, expect, it, onTestFinished } from "vitest";

import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now, nowDate, withMockNowForTest } from "../../../lib/time";
import { testContext } from "../../../__tests__/test-context";
import { readCanonicalAgentNameFixture } from "../../../test-fixtures/canonical-agent-authority";
import { clearRunLaunchSnapshotFixture } from "../../../test-fixtures/agent-runs";
import { createUniqueStaffOrgIdFixture } from "../../../test-fixtures/staff-org";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { storageTextFile } from "./helpers/api-bdd-storage-files";
import {
  createRunsApi,
  expectCanonicalStorageManifest,
} from "./helpers/api-bdd-runs";
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";
import { createStoragesBddApi } from "./helpers/api-bdd-storages";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import {
  deleteUsageStateFixture$,
  seedCompose$,
  seedRun$,
  seedUsageStateFixture$,
} from "./helpers/usage-state";

/*
 * RUN-03/RUN-04 read surfaces for agent runs (list/read/queue/cancel,
 * agent run detail reads, queue position, event logs, and log reads) plus the RUN-01/02
 * direct-run create arms that
 * end in those reads (session continuation, memory root policies, volume
 * pinning, concurrency caps, and the production capture gate).
 *
 * Direct runs are constructed through createAgentRun$; route boundaries cover
 * runner claims and sandbox webhooks (events/checkpoint/complete). Axiom reads
 * are answered by an APL-dispatching mock.
 */

// The sanitizer accepts the literal IANA name; built by parts to satisfy
// unicorn/text-encoding-identifier-case.
const UTF8_ENCODING = ["utf", "8"].join("-");
const HOUR_MS = 60 * 60 * 1000;

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);
const reads = createRunReadsApi(context);
const store = createStore();

function mustOk<TResponse extends { readonly status: number }>(
  response: TResponse,
  what: string,
): asserts response is Extract<TResponse, { status: 200 }> {
  if (response.status !== 200) {
    throw new Error(`Expected ${what} to succeed`);
  }
}

async function entitledActor(): Promise<ApiTestUser> {
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  api.configureRunnerGroup();
  await api.grantProEntitlement(actor);
  return actor;
}

async function createClaudeAgent(
  actor: ApiTestUser,
  prefix: string,
): Promise<{ readonly agentId: string; readonly name: string }> {
  const name = `${prefix}-${randomUUID().slice(0, 8)}`;
  return await api.createDirectAgent(actor, {
    version: "1",
    agents: {
      [name]: {
        framework: "claude-code",
        environment: { ANTHROPIC_API_KEY: "bdd-inline-key" },
      },
    },
  });
}

function sandboxHeaders(token: string): { readonly authorization: string } {
  return { authorization: `Bearer ${token}` };
}

async function waitForTimestampBoundary(): Promise<void> {
  await delay(30, { signal: context.signal });
}

function s3CommandKey(command: unknown): string | undefined {
  return (command as { readonly input?: { readonly Key?: string } }).input?.Key;
}

function s3CommandName(command: unknown): string | undefined {
  return (command as { readonly constructor?: { readonly name?: string } })
    .constructor?.name;
}

interface S3NotFoundError extends Error {
  Code: string;
  $metadata: { httpStatusCode: number };
}

function s3ObjectNotFoundError(): S3NotFoundError {
  const error = new Error("NotFound") as S3NotFoundError;
  error.name = "NotFound";
  error.Code = "NoSuchKey";
  error.$metadata = { httpStatusCode: 404 };
  return error;
}

function presignedUrlKeysSince(
  startIndex: number,
): readonly (string | undefined)[] {
  return context.mocks.s3.getSignedUrl.mock.calls
    .slice(startIndex)
    .map(([, command]) => {
      return s3CommandKey(command);
    });
}

function hasManifestPresign(keys: readonly (string | undefined)[]): boolean {
  return keys.some((key) => {
    return key?.endsWith("/manifest.json") ?? false;
  });
}

function s3BytesBody(bytes: Buffer): AsyncIterable<Buffer> {
  return {
    async *[Symbol.asyncIterator]() {
      yield bytes;
    },
  };
}

/**
 * Marks a claimed run completed through the sandbox webhooks. Successful
 * completion requires a checkpoint, so one is included atomically.
 */
async function completeRun(
  runId: string,
  sandboxToken: string,
  options: { readonly lastEventSequence?: number } = {},
): Promise<void> {
  const headers = sandboxHeaders(sandboxToken);
  await webhooks.requestAgentComplete(
    {
      runId,
      exitCode: 0,
      checkpoint: {
        cliAgentType: "claude-code",
        cliAgentSessionId: `bdd-cli-${runId}`,
        cliAgentSessionHistoryHash: createHash("sha256")
          .update(`bdd run reads history ${runId}`)
          .digest("hex"),
      },
      ...(options.lastEventSequence === undefined
        ? {}
        : { lastEventSequence: options.lastEventSequence }),
    },
    headers,
    [200],
  );
}

async function completeRunAfter(
  actor: ApiTestUser,
  runId: string,
  durationMs: number,
): Promise<void> {
  const detail = await api.requestReadRun(actor, runId, [200]);
  mustOk(detail, "claimed run detail");
  const startedAt = detail.body.startedAt;
  if (typeof startedAt !== "string") {
    throw new Error("Claimed run is missing its start time");
  }
  const startedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(startedAtMs)) {
    throw new Error("Claimed run has an invalid start time");
  }
  await withMockNowForTest(startedAtMs + durationMs, async () => {
    await completeRun(runId, api.sandboxTokenForRun(actor, runId));
  });
}

describe("RUN-03/RUN-04: run read surface auth matrix", () => {
  it("rejects unauthenticated and org-less requests across the run read surfaces", async () => {
    const missingId = randomUUID();
    const NOT_AUTHENTICATED = {
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    };

    const unauthenticated = [
      (await api.requestReadRun(null, missingId, [401])).body,
      (await api.requestReadRunQueue(null, [401])).body,
      (await api.requestCancelRun(null, missingId, [401])).body,
      (await reads.requestQueuePosition(null, missingId, [401])).body,
      (await reads.requestAgentRunAgentEvents(null, missingId, {}, [401])).body,
      (await reads.requestAgentRunNetworkLogs(null, missingId, {}, [401])).body,
      (await reads.requestListLogs(null, {}, [401])).body,
      (await reads.requestReadLogById(null, missingId, [401])).body,
    ];
    for (const body of unauthenticated) {
      expect(body).toStrictEqual(NOT_AUTHENTICATED);
    }

    const orgless = bdd.user({ orgId: null });
    const orglessUnauthorized = [
      (await api.requestReadRunQueue(orgless, [401])).body,
      (await api.requestCancelRun(orgless, missingId, [401])).body,
      (await reads.requestListLogs(orgless, {}, [401])).body,
      (await reads.requestAgentRunAgentEvents(orgless, missingId, {}, [401]))
        .body,
      (await reads.requestAgentRunNetworkLogs(orgless, missingId, {}, [401]))
        .body,
    ];
    for (const body of orglessUnauthorized) {
      expect(body).toStrictEqual(NOT_AUTHENTICATED);
    }
  });
});

describe("RUN-03/RUN-04: direct run list, detail, and queue reads", () => {
  it("keeps limited-free plan concurrency visible when the runtime cap is disabled", async () => {
    const actor = bdd.user();
    await bdd.bootstrapLimitedFreeOnboarding(actor, {
      displayName: "BDD limited-free agent",
    });
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "0");

    const queue = await api.readRunQueue(actor);

    expect(queue.body.concurrency).toMatchObject({
      tier: "limited-free-1",
      limit: 1,
      active: 0,
      available: 1,
      memberUsage: [],
    });
  });

  it("groups active concurrency by workspace member", async () => {
    const actor = await entitledActor();
    const member = bdd.user({ orgId: actor.orgId, orgRole: "org:member" });
    const actorCompose = await createClaudeAgent(actor, "bdd-actor-usage");
    const memberCompose = await createClaudeAgent(member, "bdd-member-usage");

    await api.createDirectRun(actor, {
      agentId: actorCompose.agentId,
      prompt: "actor active run",
    });
    await api.createDirectRun(member, {
      agentId: memberCompose.agentId,
      prompt: "member active run",
    });
    await bdd.readMe(actor);
    await bdd.readMe(member);

    const queue = await api.readRunQueue(actor);

    expect(queue.body.concurrency).toMatchObject({
      tier: "pro",
      limit: 2,
      active: 2,
      available: 0,
    });
    expect(queue.body.concurrency.memberUsage).toHaveLength(2);
    expect(queue.body.concurrency.memberUsage).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: actor.userId,
          displayName: "BDD User",
          active: 1,
        }),
        expect.objectContaining({
          userId: member.userId,
          displayName: "BDD User",
          active: 1,
        }),
      ]),
    );
  });

  it("reads legacy and expanded unattended trigger sources from queue and logs", async () => {
    const actor = await entitledActor();
    const compose = await createClaudeAgent(actor, "bdd-trigger-sources");
    if (!actor.orgId) {
      throw new Error("Trigger source reads require an org-scoped actor");
    }

    const triggerSources = [
      "automation-schedule",
      "automation-event",
      "automation-schedule",
      "automation-event",
      "goal",
    ] as const;
    const sourceRuns = [];
    for (const triggerSource of triggerSources) {
      const run = await store.set(
        seedRun$,
        {
          orgId: actor.orgId,
          userId: actor.userId,
          composeId: compose.agentId,
          prompt: `${triggerSource} read compatibility`,
          status: "queued",
          triggerSource,
        },
        context.signal,
      );
      sourceRuns.push({ runId: run.runId, triggerSource });
    }

    const queue = await api.readRunQueue(actor);
    for (const sourceRun of sourceRuns) {
      expect(queue.body.queue).toContainEqual(
        expect.objectContaining(sourceRun),
      );
    }

    for (const run of sourceRuns) {
      await api.requestCancelRun(actor, run.runId, [200]);
    }

    const listed = await reads.requestListLogs(actor, {}, [200]);
    mustOk(listed, "the trigger source logs list");
    expect(listed.body.filters.sources).toStrictEqual(
      expect.arrayContaining([...triggerSources]),
    );

    for (const sourceRun of sourceRuns) {
      const detail = await reads.requestReadLogById(
        actor,
        sourceRun.runId,
        [200],
      );
      expect(detail.body).toMatchObject({
        id: sourceRun.runId,
        triggerSource: sourceRun.triggerSource,
      });

      const filtered = await reads.requestListLogs(
        actor,
        { triggerSource: sourceRun.triggerSource },
        [200],
      );
      mustOk(filtered, `${sourceRun.triggerSource} logs filter`);
      expect(
        filtered.body.data.map((entry) => {
          return entry.id;
        }),
      ).toContain(sourceRun.runId);
    }
  });

  it("keeps lifecycle-only logs visible without product metadata", async () => {
    const actor = await entitledActor();
    const compose = await createClaudeAgent(actor, "lifecycle-only-log");
    if (!actor.orgId) {
      throw new Error("Lifecycle-only log reads require an org-scoped actor");
    }
    const lifecycleRun = await store.set(
      seedRun$,
      {
        orgId: actor.orgId,
        userId: actor.userId,
        composeId: compose.agentId,
        prompt: "accepted lifecycle-only history",
        status: "failed",
        completedAt: nowDate(),
        lifecycleOnly: true,
      },
      context.signal,
    );

    const listed = await reads.requestListLogs(actor, {}, [200]);
    mustOk(listed, "the lifecycle-only log list");
    expect(
      listed.body.data.find((entry) => {
        return entry.id === lifecycleRun.runId;
      }),
    ).toMatchObject({
      id: lifecycleRun.runId,
      status: "failed",
      triggerSource: null,
    });

    const detail = await reads.requestReadLogById(
      actor,
      lifecycleRun.runId,
      [200],
    );
    expect(detail.body).toMatchObject({
      id: lifecycleRun.runId,
      triggerSource: null,
      modelProvider: null,
      selectedModel: null,
    });

    const productFiltered = await reads.requestListLogs(
      actor,
      { triggerSource: "test" },
      [200],
    );
    mustOk(productFiltered, "the product-metadata log filter");
    expect(
      productFiltered.body.data.map((entry) => {
        return entry.id;
      }),
    ).not.toContain(lifecycleRun.runId);
  });

  it("lists, reads, and queues direct runs with status, agent, and window filters", async () => {
    const actor = await entitledActor();
    const member = bdd.user({ orgId: actor.orgId, orgRole: "org:member" });
    const target = await createClaudeAgent(actor, "bdd-target");
    const other = await createClaudeAgent(actor, "bdd-other");
    const memberCompose = await createClaudeAgent(member, "bdd-member");

    await api.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD run reads agent",
      description: "Queue privacy and session links.",
      visibility: "private",
    });
    const memberAgent = await bdd.createAgent(member, {
      displayName: "BDD member agent",
      description: "Foreign queue entries.",
      visibility: "private",
    });

    // Seed a terminal agent-run session so a later queued run can carry a
    // continuation session link.
    const seedRun = await api.createRun(actor, {
      agentId: agent.agentId,
      prompt: "seed a session",
      modelProvider: "anthropic-api-key",
    });
    await api.requestCancelRun(actor, seedRun.runId, [200]);

    const runA = await api.createDirectRun(actor, {
      agentId: target.agentId,
      prompt: "target run a",
    });
    const runB = await api.createDirectRun(actor, {
      agentId: other.agentId,
      prompt: "other run b",
    });

    const defaults = await reads.requestListAgentRuns(actor, {}, [200]);
    const defaultPrompts = defaults.body.runs.map((run) => {
      return run.prompt;
    });
    expect(defaultPrompts).toStrictEqual(
      expect.arrayContaining(["target run a", "other run b"]),
    );

    const memberView = await reads.requestListAgentRuns(member, {}, [200]);
    expect(
      memberView.body.runs.map((run) => {
        return run.id;
      }),
    ).not.toContain(runA.runId);

    const invalidStatus = await reads.requestListAgentRuns(
      actor,
      { status: "running,bogus" },
      [400],
    );
    expectApiError(invalidStatus.body);
    expect(invalidStatus.body.error.message).toContain("Invalid status: bogus");

    const invalidSince = await reads.requestListAgentRuns(
      actor,
      { since: "not-a-date" },
      [400],
    );
    expectApiError(invalidSince.body);
    expect(invalidSince.body.error.message).toBe(
      "Invalid since timestamp format",
    );

    const invalidUntil = await reads.requestListAgentRuns(
      actor,
      { until: "not-a-date" },
      [400],
    );
    expectApiError(invalidUntil.body);
    expect(invalidUntil.body.error.message).toBe(
      "Invalid until timestamp format",
    );

    await api.claimRunnerJob(runA.runId);
    const claimB = await api.claimRunnerJob(runB.runId);
    await completeRun(runB.runId, claimB.sandboxToken);

    const runningOnly = await reads.requestListAgentRuns(
      actor,
      { status: "running" },
      [200],
    );
    const runningIds = runningOnly.body.runs.map((run) => {
      return run.id;
    });
    expect(runningIds).toContain(runA.runId);
    expect(runningIds).not.toContain(runB.runId);

    const afterComplete = await reads.requestListAgentRuns(actor, {}, [200]);
    expect(
      afterComplete.body.runs.map((run) => {
        return run.prompt;
      }),
    ).not.toContain("other run b");

    const completedByAgent = await reads.requestListAgentRuns(
      actor,
      { status: "completed", agent: other.name, limit: 1 },
      [200],
    );
    expect(completedByAgent.body.runs).toHaveLength(1);
    expect(completedByAgent.body.runs[0]).toMatchObject({
      id: runB.runId,
      agentName: other.name,
      status: "completed",
      prompt: "other run b",
    });
    expect(completedByAgent.body.runs[0]?.startedAt).not.toBeNull();

    const pastWindow = await reads.requestListAgentRuns(
      actor,
      {
        status: "completed",
        agent: other.name,
        until: new Date(now() - 60 * 60_000).toISOString(),
      },
      [200],
    );
    expect(pastWindow.body.runs).toStrictEqual([]);

    const insideWindow = await reads.requestListAgentRuns(
      actor,
      {
        status: "completed",
        agent: other.name,
        since: new Date(now() - 60 * 60_000).toISOString(),
        until: new Date(now() + 60_000).toISOString(),
      },
      [200],
    );
    expect(
      insideWindow.body.runs.map((run) => {
        return run.id;
      }),
    ).toContain(runB.runId);

    const detail = await api.requestReadRun(actor, runB.runId, [200]);
    expect(detail.body).toMatchObject({
      runId: runB.runId,
      status: "completed",
      prompt: "other run b",
    });
    mustOk(detail, "Agent run detail");
    expect(detail.body.startedAt).toBeDefined();
    expect(detail.body.completedAt).toBeDefined();

    const invalidId = await api.requestReadRun(actor, "not-a-run-id", [400]);
    expectApiError(invalidId.body);
    expect(invalidId.body.error.code).toBe("BAD_REQUEST");

    const missing = await api.requestReadRun(actor, randomUUID(), [404]);
    expectApiError(missing.body);
    expect(missing.body.error.message).toBe("Agent run not found");

    const runM = await api.createDirectRun(member, {
      agentId: memberCompose.agentId,
      prompt: "member run m",
    });
    const hiddenFromActor = await api.requestReadRun(actor, runM.runId, [404]);
    expectApiError(hiddenFromActor.body);
    expect(hiddenFromActor.body.error.message).toBe("Agent run not found");
    const memberDetail = await api.requestReadRun(member, runM.runId, [200]);
    expect(memberDetail.body).toMatchObject({ runId: runM.runId });
    await api.claimRunnerJob(runM.runId);

    // auth-me refreshes the caller's user-cache email, which the queue
    // surfaces for owner entries.
    await bdd.readMe(actor);
    const agentQueue = await api.readRunQueue(actor);
    expect(agentQueue.body.concurrency).toMatchObject({
      tier: "pro",
      limit: 2,
      active: 2,
      available: 0,
    });
    expect(agentQueue.body.runningTasks).toHaveLength(2);
    const ownTask = agentQueue.body.runningTasks.find((task) => {
      return task.isOwner;
    });
    expect(ownTask).toMatchObject({
      runId: runA.runId,
      userEmail: actor.email,
      isOwner: true,
    });
    expect(ownTask?.startedAt).not.toBeNull();
    const foreignTask = agentQueue.body.runningTasks.find((task) => {
      return !task.isOwner;
    });
    expect(foreignTask).toMatchObject({
      runId: null,
      userEmail: "unknown",
      isOwner: false,
    });
    expect(agentQueue.body.estimatedTimePerRun).not.toBeNull();

    const longPrompt = "q".repeat(220);
    const queuedOwn = await api.createRun(actor, {
      agentId: agent.agentId,
      sessionId: seedRun.sessionId,
      prompt: longPrompt,
      modelProvider: "anthropic-api-key",
    });
    expect(queuedOwn.status).toBe("queued");
    const queuedForeign = await api.createRun(member, {
      agentId: memberAgent.agentId,
      prompt: "member queued secret",
      modelProvider: "anthropic-api-key",
    });
    expect(queuedForeign.status).toBe("queued");

    const privacyQueue = await api.readRunQueue(actor);
    expect(privacyQueue.body.queue).toHaveLength(2);
    expect(privacyQueue.body.queue[0]).toMatchObject({
      position: 1,
      isOwner: true,
      runId: queuedOwn.runId,
      prompt: `${"q".repeat(200)}...`,
      userEmail: actor.email,
      sessionLink: `/chat/${seedRun.sessionId}`,
    });
    expect(privacyQueue.body.queue[1]).toMatchObject({
      position: 2,
      isOwner: false,
      runId: null,
      prompt: null,
      agentName: null,
      userEmail: null,
      triggerSource: null,
      sessionLink: null,
    });
    expect(JSON.stringify(privacyQueue.body)).not.toContain(
      "member queued secret",
    );

    await api.requestCancelRun(actor, queuedOwn.runId, [200]);
    await api.requestCancelRun(member, queuedForeign.runId, [200]);
    await api.requestCancelRun(actor, runA.runId, [200]);
    await api.requestCancelRun(member, runM.runId, [200]);

    const drained = await api.readRunQueue(actor);
    expect(drained.body.concurrency.active).toBe(0);
    expect(drained.body.queue).toStrictEqual([]);
  });

  it("returns validated run duration estimates across the numeric domain", async () => {
    const actor = await entitledActor();
    const compose = await createClaudeAgent(actor, "bdd-duration-estimate");

    const emptyQueue = await api.readRunQueue(actor);
    expect(emptyQueue.body.estimatedTimePerRun).toBeNull();

    const agentRun = await api.createDirectRun(actor, {
      agentId: compose.agentId,
      prompt: "zero duration estimate",
    });
    await api.claimRunnerJob(agentRun.runId);
    await completeRunAfter(actor, agentRun.runId, 0);
    const zeroQueue = await api.readRunQueue(actor);
    expect(zeroQueue.body.estimatedTimePerRun).toBe(0);

    const fractionalRun = await api.createDirectRun(actor, {
      agentId: compose.agentId,
      prompt: "fractional average estimate",
    });
    await api.claimRunnerJob(fractionalRun.runId);
    await completeRunAfter(actor, fractionalRun.runId, 1);
    const fractionalQueue = await api.readRunQueue(actor);
    expect(fractionalQueue.body.estimatedTimePerRun).toBe(1);

    const normalRun = await api.createDirectRun(actor, {
      agentId: compose.agentId,
      prompt: "normal duration estimate",
    });
    await api.claimRunnerJob(normalRun.runId);
    await completeRunAfter(actor, normalRun.runId, 2999);
    const normalQueue = await api.readRunQueue(actor);
    expect(normalQueue.body.estimatedTimePerRun).toBe(1000);

    const largeActor = await entitledActor();
    const largeCompose = await createClaudeAgent(
      largeActor,
      "bdd-large-duration-estimate",
    );
    const largeRun = await api.createDirectRun(largeActor, {
      agentId: largeCompose.agentId,
      prompt: "large duration estimate",
    });
    await api.claimRunnerJob(largeRun.runId);
    const largeDurationMs = 200_000_000_000_000;
    await completeRunAfter(largeActor, largeRun.runId, largeDurationMs);
    const largeQueue = await api.readRunQueue(largeActor);
    expect(largeQueue.body.estimatedTimePerRun).toBe(largeDurationMs);
  });
});

describe("RUN-03: cancel through the run cancel route", () => {
  it("cancels runs through the run cancel route across states", async () => {
    const actor = await entitledActor();
    const compose = await createClaudeAgent(actor, "bdd-cancel");

    const c1 = await api.createDirectRun(actor, {
      agentId: compose.agentId,
      prompt: "cancel a running run",
    });
    await api.claimRunnerJob(c1.runId);
    const cancelled = await api.requestCancelRun(
      actor,
      c1.runId.toUpperCase(),
      [200],
    );
    expect(cancelled.body).toStrictEqual({
      id: c1.runId,
      status: "cancelled",
      message: "Run cancelled successfully",
    });
    const c1Detail = await api.readRun(actor, c1.runId);
    expect(c1Detail.status).toBe("cancelled");

    const repeated = await api.requestCancelRun(actor, c1.runId, [200]);
    expect(repeated.body).toMatchObject({ status: "cancelled" });

    const c2 = await api.createDirectRun(actor, {
      agentId: compose.agentId,
      prompt: "complete then cancel",
    });
    const claim2 = await api.claimRunnerJob(c2.runId);
    await completeRun(c2.runId, claim2.sandboxToken);
    const notCancellable = await api.requestCancelRun(actor, c2.runId, [400]);
    expectApiError(notCancellable.body);
    expect(notCancellable.body.error.code).toBe("RUN_NOT_CANCELLABLE");

    const unknown = await api.requestCancelRun(actor, randomUUID(), [404]);
    expectApiError(unknown.body);
    expect(unknown.body.error.code).toBe("NOT_FOUND");

    const outsider = bdd.user();
    const crossOrg = await api.requestCancelRun(
      outsider,
      c2.runId.toUpperCase(),
      [404],
    );
    expectApiError(crossOrg.body);
    expect(crossOrg.body.error.code).toBe("NOT_FOUND");

    // A queued agent run cancelled through the agent route disappears from
    // the visible queue.
    await api.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD cancel agent",
      description: "Queued cancellation through the agent route.",
      visibility: "private",
    });
    const d1 = await api.createDirectRun(actor, {
      agentId: compose.agentId,
      prompt: "occupy slot one",
    });
    const d2 = await api.createDirectRun(actor, {
      agentId: compose.agentId,
      prompt: "occupy slot two",
    });
    const c4 = await api.createRun(actor, {
      agentId: agent.agentId,
      prompt: "queued run to cancel",
      modelProvider: "anthropic-api-key",
    });
    expect(c4.status).toBe("queued");
    const queuedCancelled = await api.requestCancelRun(actor, c4.runId, [200]);
    expect(queuedCancelled.body).toMatchObject({ status: "cancelled" });
    const queueAfter = await api.readRunQueue(actor);
    expect(queueAfter.body.queue).toStrictEqual([]);

    await api.requestCancelRun(actor, d1.runId, [200]);
    await api.requestCancelRun(actor, d2.runId, [200]);
  });
});

describe("RUN-03: queue position", () => {
  it("reports queue position for queued, running, and foreign runs", async () => {
    const actor = await entitledActor();
    const member = bdd.user({ orgId: actor.orgId, orgRole: "org:member" });
    const compose = await createClaudeAgent(actor, "bdd-position");
    await api.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD position agent",
      description: "Queue position reads.",
      visibility: "private",
    });
    const memberAgent = await bdd.createAgent(member, {
      displayName: "BDD member position agent",
      description: "Foreign queue position reads.",
      visibility: "private",
    });

    const running = await api.createDirectRun(actor, {
      agentId: compose.agentId,
      prompt: "running run",
    });
    await api.claimRunnerJob(running.runId);
    const pending = await api.createDirectRun(actor, {
      agentId: compose.agentId,
      prompt: "pending run",
    });
    const queued = await api.createRun(actor, {
      agentId: agent.agentId,
      prompt: "queued run",
      modelProvider: "anthropic-api-key",
    });
    expect(queued.status).toBe("queued");
    const memberQueued = await api.createRun(member, {
      agentId: memberAgent.agentId,
      prompt: "member queued run",
      modelProvider: "anthropic-api-key",
    });
    expect(memberQueued.status).toBe("queued");

    const first = await reads.requestQueuePosition(actor, queued.runId, [200]);
    expect(first.body).toStrictEqual({ position: 1, total: 1 });

    const second = await reads.requestQueuePosition(
      member,
      memberQueued.runId,
      [200],
    );
    expect(second.body).toStrictEqual({ position: 2, total: 2 });

    const unqueued = await reads.requestQueuePosition(
      actor,
      running.runId,
      [200],
    );
    expect(unqueued.body).toStrictEqual({ position: 0, total: 0 });

    const foreignUser = await reads.requestQueuePosition(
      actor,
      memberQueued.runId,
      [404],
    );
    expectApiError(foreignUser.body);
    expect(foreignUser.body.error.code).toBe("NOT_FOUND");

    const outsider = bdd.user();
    const foreignOrg = await reads.requestQueuePosition(
      outsider,
      queued.runId,
      [404],
    );
    expectApiError(foreignOrg.body);
    expect(foreignOrg.body.error.code).toBe("NOT_FOUND");

    const unknown = await reads.requestQueuePosition(
      actor,
      randomUUID(),
      [404],
    );
    expectApiError(unknown.body);
    expect(unknown.body.error.code).toBe("NOT_FOUND");

    const missingRunId = await reads.rawApiRequest(null, "/api/queue-position");
    expect(missingRunId.status).toBe(400);
    expect(JSON.stringify(missingRunId.body)).toContain("runId");

    await api.requestCancelRun(actor, queued.runId, [200]);
    await api.requestCancelRun(member, memberQueued.runId, [200]);
    await api.requestCancelRun(actor, pending.runId, [200]);
    await api.requestCancelRun(actor, running.runId, [200]);
  });
});

describe("RUN-01/RUN-02: session continuation, memory policies, and volume pinning", () => {
  it("returns compressed session continuation history refs", async () => {
    mockEnv("S3_ENDPOINT", undefined);
    mockEnv("S3_PUBLIC_ENDPOINT", "https://public-s3.example.test");
    const actor = await entitledActor();
    await api.ensureOrgModelProvider(actor);
    const composeName = `bdd-gzip-resume-${randomUUID().slice(0, 8)}`;
    const compose = await api.createDirectAgent(actor, {
      version: "1",
      agents: {
        [composeName]: {
          framework: "claude-code",
        },
      },
    });
    const history = `{"type":"init"}\n{"type":"human","text":"compressed-${randomUUID()}"}\n`;
    const historyHash = createHash("sha256").update(history).digest("hex");
    const compressedHistory = gzipSync(Buffer.from(history, "utf8"));
    const compressedKey = `blobs/${historyHash}.blob.gz`;
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (s3CommandKey(command) === compressedKey) {
        return Promise.resolve({
          ContentLength: compressedHistory.length,
          Body: s3BytesBody(compressedHistory),
        });
      }
      return Promise.resolve({});
    });

    const run = await api.createDirectRun(actor, {
      agentId: compose.agentId,
      prompt: "create compressed checkpoint",
      modelProviderType: "anthropic-api-key",
    });
    const claim = await api.claimRunnerJob(run.runId);
    const headers = sandboxHeaders(claim.sandboxToken);
    const prepared = await webhooks.requestAgentCheckpointPrepareHistory(
      {
        runId: run.runId,
        hash: historyHash,
        rawSize: Buffer.byteLength(history, "utf8"),
        encodedSize: compressedHistory.length,
        encoding: "gzip",
      },
      headers,
      [200],
    );
    expect(prepared.body).toMatchObject({
      existing: false,
      encoding: "gzip",
    });
    const duplicatePrepared =
      await webhooks.requestAgentCheckpointPrepareHistory(
        {
          runId: run.runId,
          hash: historyHash,
          rawSize: Buffer.byteLength(history, "utf8"),
          encodedSize: compressedHistory.length + 1,
          encoding: "gzip",
        },
        headers,
        [200],
      );
    expect(duplicatePrepared.body).toStrictEqual({
      existing: true,
      encoding: "gzip",
    });
    await webhooks.requestAgentComplete(
      {
        runId: run.runId,
        exitCode: 0,
        checkpoint: {
          cliAgentType: "claude-code",
          cliAgentSessionId: `bdd-cli-${run.runId}`,
          cliAgentSessionHistoryHash: historyHash,
        },
      },
      headers,
      [200],
    );

    const compressedContinuation = await api.createDirectRun(actor, {
      sessionId: run.sessionId,
      prompt: "continue with compressed ref",
      modelProviderType: "anthropic-api-key",
    });
    const compressedClaim = await api.claimRunnerJob(
      compressedContinuation.runId,
    );
    expect(compressedClaim.resumeSession).toMatchObject({
      sessionId: `bdd-cli-${run.runId}`,
      historyRef: {
        kind: "blob",
        hash: historyHash,
        url: expect.any(String),
        encoding: "gzip",
        rawSize: Buffer.byteLength(history, "utf8"),
        encodedSize: compressedHistory.length,
        downloadSource:
          SESSION_HISTORY_DOWNLOAD_SOURCE_CONFIGURED_PUBLIC_ENDPOINT,
      },
    });
    await api.requestCancelRun(actor, compressedContinuation.runId, [200]);
  });

  it("returns zstd-compressed session continuation history refs", async () => {
    mockEnv("S3_ENDPOINT", undefined);
    mockEnv("S3_PUBLIC_ENDPOINT", undefined);
    const actor = await entitledActor();
    await api.ensureOrgModelProvider(actor);
    const composeName = `bdd-zstd-resume-${randomUUID().slice(0, 8)}`;
    const compose = await api.createDirectAgent(actor, {
      version: "1",
      agents: {
        [composeName]: {
          framework: "claude-code",
        },
      },
    });
    const history = `{"type":"init"}\n{"type":"human","text":"zstd-${randomUUID()}"}\n`;
    const historyHash = createHash("sha256").update(history).digest("hex");
    const compressedHistory = zstdCompressSync(Buffer.from(history, "utf8"));
    const compressedKey = `blobs/${historyHash}.blob.zst`;
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      const commandKey = s3CommandKey(command);
      if (commandKey === compressedKey) {
        return Promise.resolve({
          ContentLength: compressedHistory.length,
          Body: s3BytesBody(compressedHistory),
        });
      }
      if (commandKey?.startsWith(`blobs/${historyHash}.blob`)) {
        return Promise.reject(s3ObjectNotFoundError());
      }
      return Promise.resolve({});
    });

    const run = await api.createDirectRun(actor, {
      agentId: compose.agentId,
      prompt: "create zstd compressed checkpoint",
      modelProviderType: "anthropic-api-key",
    });
    const claim = await api.claimRunnerJob(run.runId);
    const headers = sandboxHeaders(claim.sandboxToken);
    const prepared = await webhooks.requestAgentCheckpointPrepareHistory(
      {
        runId: run.runId,
        hash: historyHash,
        rawSize: Buffer.byteLength(history, "utf8"),
        encodedSize: compressedHistory.length,
        encoding: "zstd",
      },
      headers,
      [200],
    );
    expect(prepared.body).toMatchObject({
      existing: false,
      encoding: "zstd",
    });
    const duplicatePrepared =
      await webhooks.requestAgentCheckpointPrepareHistory(
        {
          runId: run.runId,
          hash: historyHash,
          rawSize: Buffer.byteLength(history, "utf8"),
          encodedSize: compressedHistory.length + 1,
          encoding: "zstd",
        },
        headers,
        [200],
      );
    expect(duplicatePrepared.body).toStrictEqual({
      existing: true,
      encoding: "zstd",
    });
    await webhooks.requestAgentComplete(
      {
        runId: run.runId,
        exitCode: 0,
        checkpoint: {
          cliAgentType: "claude-code",
          cliAgentSessionId: `bdd-cli-${run.runId}`,
          cliAgentSessionHistoryHash: historyHash,
        },
      },
      headers,
      [200],
    );

    const compressedContinuation = await api.createDirectRun(actor, {
      sessionId: run.sessionId,
      prompt: "continue with zstd compressed ref",
      modelProviderType: "anthropic-api-key",
    });
    const compressedClaim = await api.claimRunnerJob(
      compressedContinuation.runId,
    );
    expect(compressedClaim.resumeSession).toMatchObject({
      sessionId: `bdd-cli-${run.runId}`,
      historyRef: {
        kind: "blob",
        hash: historyHash,
        url: expect.any(String),
        encoding: "zstd",
        rawSize: Buffer.byteLength(history, "utf8"),
        encodedSize: compressedHistory.length,
        downloadSource: SESSION_HISTORY_DOWNLOAD_SOURCE_DEFAULT_R2_ENDPOINT,
      },
    });
    await api.requestCancelRun(actor, compressedContinuation.runId, [200]);
  });

  it("rejects identity repair for a missing compressed session history blob", async () => {
    const actor = await entitledActor();
    const compose = await createClaudeAgent(actor, "bdd-gzip-repair");
    const history = `{"type":"init"}\n{"type":"human","text":"repair-${randomUUID()}"}\n`;
    const historyHash = createHash("sha256").update(history).digest("hex");
    const compressedKey = `blobs/${historyHash}.blob.gz`;
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (s3CommandKey(command) === compressedKey) {
        return Promise.reject(s3ObjectNotFoundError());
      }
      return Promise.resolve({});
    });

    const run = await api.createDirectRun(actor, {
      agentId: compose.agentId,
      prompt: "create missing compressed blob metadata",
    });
    const claim = await api.claimRunnerJob(run.runId);
    const headers = sandboxHeaders(claim.sandboxToken);
    const compressedPrepare =
      await webhooks.requestAgentCheckpointPrepareHistory(
        {
          runId: run.runId,
          hash: historyHash,
          rawSize: Buffer.byteLength(history, "utf8"),
          encodedSize: gzipSync(Buffer.from(history, "utf8")).length,
          encoding: "gzip",
        },
        headers,
        [200],
      );
    expect(compressedPrepare.body).toMatchObject({
      existing: false,
      encoding: "gzip",
    });

    const mismatchedEncodedSize =
      await webhooks.requestAgentCheckpointPrepareHistory(
        {
          runId: run.runId,
          hash: historyHash,
          rawSize: Buffer.byteLength(history, "utf8"),
          encodedSize: gzipSync(Buffer.from(history, "utf8")).length + 1,
          encoding: "gzip",
        },
        headers,
        [400],
      );
    expectApiError(mismatchedEncodedSize.body);
    expect(mismatchedEncodedSize.body.error.message).toBe(
      "Session history encoded size does not match the existing blob",
    );

    const compressedRetry = await webhooks.requestAgentCheckpointPrepareHistory(
      {
        runId: run.runId,
        hash: historyHash,
        rawSize: Buffer.byteLength(history, "utf8"),
        encodedSize: gzipSync(Buffer.from(history, "utf8")).length,
        encoding: "gzip",
      },
      headers,
      [200],
    );
    expect(compressedRetry.body).toMatchObject({
      existing: false,
      encoding: "gzip",
    });

    const identityRepair = await webhooks.requestAgentCheckpointPrepareHistory(
      {
        runId: run.runId,
        hash: historyHash,
        rawSize: Buffer.byteLength(history, "utf8"),
        encodedSize: Buffer.byteLength(history, "utf8"),
        encoding: "identity",
      },
      headers,
      [400],
    );
    expectApiError(identityRepair.body);
    expect(identityRepair.body.error.message).toBe(
      "Identity session history upload cannot repair a compressed blob",
    );
  });

  it("rejects identity repair for a missing zstd session history blob", async () => {
    const actor = await entitledActor();
    const compose = await createClaudeAgent(actor, "bdd-zstd-repair");
    const history = `{"type":"init"}\n{"type":"human","text":"repair-zstd-${randomUUID()}"}\n`;
    const historyHash = createHash("sha256").update(history).digest("hex");
    const compressedHistory = zstdCompressSync(Buffer.from(history, "utf8"));
    const compressedKey = `blobs/${historyHash}.blob.zst`;
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      const commandKey = s3CommandKey(command);
      if (commandKey === compressedKey) {
        return Promise.reject(s3ObjectNotFoundError());
      }
      if (commandKey?.startsWith(`blobs/${historyHash}.blob`)) {
        return Promise.reject(s3ObjectNotFoundError());
      }
      return Promise.resolve({});
    });

    const run = await api.createDirectRun(actor, {
      agentId: compose.agentId,
      prompt: "create missing zstd blob metadata",
    });
    const claim = await api.claimRunnerJob(run.runId);
    const headers = sandboxHeaders(claim.sandboxToken);
    const compressedPrepare =
      await webhooks.requestAgentCheckpointPrepareHistory(
        {
          runId: run.runId,
          hash: historyHash,
          rawSize: Buffer.byteLength(history, "utf8"),
          encodedSize: compressedHistory.length,
          encoding: "zstd",
        },
        headers,
        [200],
      );
    expect(compressedPrepare.body).toMatchObject({
      existing: false,
      encoding: "zstd",
    });

    const mismatchedEncodedSize =
      await webhooks.requestAgentCheckpointPrepareHistory(
        {
          runId: run.runId,
          hash: historyHash,
          rawSize: Buffer.byteLength(history, "utf8"),
          encodedSize: compressedHistory.length + 1,
          encoding: "zstd",
        },
        headers,
        [400],
      );
    expectApiError(mismatchedEncodedSize.body);
    expect(mismatchedEncodedSize.body.error.message).toBe(
      "Session history encoded size does not match the existing blob",
    );

    const mismatchedEncodingRepair =
      await webhooks.requestAgentCheckpointPrepareHistory(
        {
          runId: run.runId,
          hash: historyHash,
          rawSize: Buffer.byteLength(history, "utf8"),
          encodedSize: gzipSync(Buffer.from(history, "utf8")).length,
          encoding: "gzip",
        },
        headers,
        [400],
      );
    expectApiError(mismatchedEncodingRepair.body);
    expect(mismatchedEncodingRepair.body.error.message).toBe(
      "Compressed session history upload encoding must match the existing blob",
    );

    const identityRepair = await webhooks.requestAgentCheckpointPrepareHistory(
      {
        runId: run.runId,
        hash: historyHash,
        rawSize: Buffer.byteLength(history, "utf8"),
        encodedSize: Buffer.byteLength(history, "utf8"),
        encoding: "identity",
      },
      headers,
      [400],
    );
    expectApiError(identityRepair.body);
    expect(identityRepair.body.error.message).toBe(
      "Identity session history upload cannot repair a compressed blob",
    );
  });

  it("restores volumes, memory, and conversation state when continuing sessions", async () => {
    mockEnv("S3_ENDPOINT", undefined);
    mockEnv("S3_PUBLIC_ENDPOINT", undefined);
    const storages = createStoragesBddApi(context);
    const actor = await entitledActor();
    await api.ensureOrgModelProvider(actor);
    const volumeArchiveSize = 12_345;
    storages.mockStoragePresignedUrls();
    storages.mockStorageObjectsExist(volumeArchiveSize);

    const volumeName = `bdd-vol-${randomUUID().slice(0, 8)}`;
    const volumeFile = storageTextFile("data/cache.txt", "bdd volume payload");
    const prepared = await storages.prepareStorage(actor, {
      storageName: volumeName,
      storageOwner: "organization",
      files: [volumeFile],
    });
    const volumeVersion = prepared.versionId;
    await storages.commitStorage(actor, {
      storageName: volumeName,
      storageOwner: "organization",
      versionId: volumeVersion,
      files: [volumeFile],
    });
    const refreshedVolumeArchiveSize = 23_456;
    const forcedPrepare = await storages.prepareStorage(actor, {
      storageName: volumeName,
      storageOwner: "organization",
      files: [volumeFile],
      force: true,
    });
    expect(forcedPrepare).toMatchObject({
      versionId: volumeVersion,
      existing: false,
      uploads: expect.any(Object),
    });
    storages.mockStorageObjectsExist(refreshedVolumeArchiveSize);
    await storages.commitStorage(actor, {
      storageName: volumeName,
      storageOwner: "organization",
      versionId: volumeVersion,
      files: [volumeFile],
    });

    const composeName = `bdd-resume-${randomUUID().slice(0, 8)}`;
    const compose = await api.createDirectAgent(actor, {
      version: "1",
      agents: {
        [composeName]: {
          framework: "claude-code",
          volumes: ["data:/data"],
        },
      },
      volumes: {
        data: { name: volumeName, version: `\${{ vars.VOL_VERSION }}` },
      },
    });

    // The session-history blob for checkpointed conversations is hash-only
    // in R2 — answer the GetObject for it while keeping other s3 sends inert.
    const history = '{"type":"init"}\n{"type":"human","text":"hi"}\n';
    const historyHash = createHash("sha256").update(history).digest("hex");
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      const input = (command as { readonly input?: { readonly Key?: string } })
        .input;
      if (input?.Key === `blobs/${historyHash}.blob`) {
        if (s3CommandName(command) === "HeadObjectCommand") {
          return Promise.resolve({
            ContentLength: Buffer.byteLength(history, "utf8"),
          });
        }
        return Promise.resolve({
          Body: {
            async *[Symbol.asyncIterator]() {
              yield Buffer.from(history, "utf8");
            },
          },
        });
      }
      return Promise.resolve({});
    });

    const versionPrefix = volumeVersion.slice(0, 16);
    const presignCallsBeforeRun =
      context.mocks.s3.getSignedUrl.mock.calls.length;
    const r1 = await api.createDirectRun(actor, {
      agentId: compose.agentId,
      prompt: "pin the volume by version prefix",
      modelProviderType: "anthropic-api-key",
      vars: { VOL_VERSION: versionPrefix },
      artifacts: [
        { name: "memory", mountPath: CANONICAL_CLAUDE_MEMORY_MOUNT_PATH },
      ],
    });
    const claim1 = await api.claimRunnerJob(r1.runId);
    expect(
      expectCanonicalStorageManifest(claim1.storageManifest)?.storageMounts,
    ).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: volumeName,
          mountPath: "/data",
          versionId: volumeVersion,
          archiveSize: refreshedVolumeArchiveSize,
        }),
      ]),
    );
    const memory1 = expectCanonicalStorageManifest(
      claim1.storageManifest,
    )?.storageMounts.find((mount) => {
      return mount.name === "memory";
    });
    expect(memory1).toMatchObject({
      mountPath: CANONICAL_CLAUDE_MEMORY_MOUNT_PATH,
      empty: true,
      storageId: expect.any(String),
      versionId: expect.any(String),
      missingRootPolicy: "preserveParentVersion",
    });
    if (!memory1) {
      throw new Error("Expected the claim manifest to mount memory");
    }
    expect(memory1.archiveUrl).toBeUndefined();
    expect("manifestUrl" in memory1).toBeFalsy();
    expect(
      hasManifestPresign(presignedUrlKeysSince(presignCallsBeforeRun)),
    ).toBeFalsy();

    const cliAgentSessionId = `bdd-cli-${r1.runId}`;
    const headers1 = sandboxHeaders(claim1.sandboxToken);
    await webhooks.requestAgentComplete(
      {
        runId: r1.runId,
        exitCode: 0,
        checkpoint: {
          cliAgentType: "claude-code",
          cliAgentSessionId,
          cliAgentSessionHistoryHash: historyHash,
          artifactSnapshots: [
            {
              name: "memory",
              version: memory1.versionId,
              mountPath: CANONICAL_CLAUDE_MEMORY_MOUNT_PATH,
            },
          ],
          volumeVersionsSnapshot: { versions: { data: volumeVersion } },
        },
      },
      headers1,
      [200],
    );

    const latestCompose = await api.createDirectAgent(actor, {
      version: "2",
      agents: {
        [composeName]: {
          framework: "claude-code",
          volumes: ["data:/data"],
        },
      },
      volumes: {
        data: { name: volumeName, version: `\${{ vars.VOL_VERSION }}` },
      },
    });
    expect(latestCompose.agentId).toBe(compose.agentId);

    const byAgent = await reads.requestCreateDirectRun(
      actor,
      {
        agentId: compose.agentId,
        prompt: "run the latest Agent head",
        vars: { VOL_VERSION: volumeVersion },
      },
      [201],
    );
    if (byAgent.status !== 201) {
      throw new Error("Expected the Agent-backed run create to succeed");
    }
    await api.claimRunnerJob(byAgent.body.runId);
    await api.requestCancelRun(actor, byAgent.body.runId, [200]);

    const strictMemory = await api.createDirectRun(actor, {
      agentId: compose.agentId,
      prompt: "user-authored memory stays strict",
      vars: { VOL_VERSION: volumeVersion },
      artifacts: [{ name: "memory", mountPath: "/mnt/user-memory" }],
    });
    const strictClaim = await api.claimRunnerJob(strictMemory.runId);
    expect(
      expectCanonicalStorageManifest(strictClaim.storageManifest)
        ?.storageMounts.filter((mount) => {
          return mount.name === "memory";
        })
        .map((mount) => {
          return {
            name: mount.name,
            mountPath: mount.mountPath,
            missingRootPolicy: mount.missingRootPolicy,
          };
        }),
    ).toStrictEqual([
      {
        name: "memory",
        mountPath: "/mnt/user-memory",
        missingRootPolicy: undefined,
      },
    ]);
    await api.requestCancelRun(actor, strictMemory.runId, [200]);

    const customCanonical = await api.createDirectRun(actor, {
      agentId: compose.agentId,
      prompt: "custom artifact claims the canonical memory mount",
      vars: { VOL_VERSION: volumeVersion },
      artifacts: [
        {
          name: "custom-memory",
          mountPath: CANONICAL_CLAUDE_MEMORY_MOUNT_PATH,
        },
      ],
    });
    const customClaim = await api.claimRunnerJob(customCanonical.runId);
    expect(
      expectCanonicalStorageManifest(customClaim.storageManifest)
        ?.storageMounts.filter((mount) => {
          return (
            mount.name === "memory" ||
            mount.mountPath === CANONICAL_CLAUDE_MEMORY_MOUNT_PATH
          );
        })
        .map((mount) => {
          return {
            name: mount.name,
            mountPath: mount.mountPath,
            missingRootPolicy: mount.missingRootPolicy,
          };
        }),
    ).toStrictEqual([
      {
        name: "custom-memory",
        mountPath: CANONICAL_CLAUDE_MEMORY_MOUNT_PATH,
        missingRootPolicy: undefined,
      },
    ]);
    await api.requestCancelRun(actor, customCanonical.runId, [200]);

    const continued = await api.createDirectRun(actor, {
      sessionId: r1.sessionId,
      prompt: "continue the checkpointed session",
      modelProviderType: "anthropic-api-key",
    });
    expect(continued.sessionId).toBe(r1.sessionId);
    const continuedClaim = await api.claimRunnerJob(continued.runId);
    expect(continuedClaim.vars).toStrictEqual({
      VOL_VERSION: versionPrefix,
    });
    expect(continuedClaim.resumeSession).toStrictEqual({
      sessionId: `bdd-cli-${r1.runId}`,
      historyRef: {
        kind: "blob",
        hash: historyHash,
        url: "https://r2.example.com/storages/presigned?sig=bdd",
        encoding: "identity",
        rawSize: Buffer.byteLength(history, "utf8"),
        encodedSize: Buffer.byteLength(history, "utf8"),
        downloadSource: SESSION_HISTORY_DOWNLOAD_SOURCE_DEFAULT_R2_ENDPOINT,
      },
    });
    const continuedMemory = expectCanonicalStorageManifest(
      continuedClaim.storageManifest,
    )?.storageMounts.find((mount) => {
      return mount.name === "memory";
    });
    expect(continuedMemory).toMatchObject({
      mountPath: CANONICAL_CLAUDE_MEMORY_MOUNT_PATH,
      missingRootPolicy: "preserveParentVersion",
    });
    await api.requestCancelRun(actor, continued.runId, [200]);
  });
});

describe("RUN-01: direct run admission boundaries", () => {
  it("requires an Agent or Session identity", async () => {
    const actor = await entitledActor();
    const missingIdentity = await reads.requestCreateDirectRun(
      actor,
      { prompt: "reject a direct run without identity" },
      [400],
    );
    expectApiError(missingIdentity.body);
    expect(missingIdentity.body.error.message).toBe(
      "Missing agentId or sessionId",
    );
  });

  it("serializes concurrent direct runs at a one-run limit", async () => {
    const actor = await entitledActor();
    const compose = await createClaudeAgent(actor, "bdd-admission-race");
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");

    const attempts = await Promise.all([
      reads.requestCreateDirectRun(
        actor,
        {
          agentId: compose.agentId,
          prompt: "concurrent admission candidate one",
        },
        [201, 429],
      ),
      reads.requestCreateDirectRun(
        actor,
        {
          agentId: compose.agentId,
          prompt: "concurrent admission candidate two",
        },
        [201, 429],
      ),
    ]);

    expect(
      attempts
        .map((attempt) => {
          return attempt.status;
        })
        .sort(),
    ).toStrictEqual([201, 429]);

    const rejected = attempts.find((attempt) => {
      return attempt.status === 429;
    });
    if (!rejected || rejected.status !== 429) {
      throw new Error("Expected one concurrent run to be rejected");
    }
    expectApiError(rejected.body);
    expect(rejected.body.error.code).toBe("CONCURRENT_RUN_LIMIT");

    const accepted = attempts.find((attempt) => {
      return attempt.status === 201;
    });
    if (!accepted || accepted.status !== 201) {
      throw new Error("Expected one concurrent run to be accepted");
    }
    const pending = await reads.requestListAgentRuns(
      actor,
      { status: "pending" },
      [200],
    );
    expect(
      pending.body.runs.map((run) => {
        return run.id;
      }),
    ).toStrictEqual([accepted.body.runId]);
    const queued = await reads.requestListAgentRuns(
      actor,
      { status: "queued" },
      [200],
    );
    expect(queued.body.runs).toStrictEqual([]);

    await api.requestCancelRun(actor, accepted.body.runId, [200]);
  });

  it("enforces direct-run concurrency until the cap is disabled", async () => {
    const actor = await entitledActor();
    const compose = await createClaudeAgent(actor, "bdd-admission");

    const first = await api.createDirectRun(actor, {
      agentId: compose.agentId,
      prompt: "first concurrent run",
    });
    const second = await api.createDirectRun(actor, {
      agentId: compose.agentId,
      prompt: "second concurrent run",
    });
    const limited = await reads.requestCreateDirectRun(
      actor,
      { agentId: compose.agentId, prompt: "third concurrent run" },
      [429],
    );
    expectApiError(limited.body);
    expect(limited.body.error.code).toBe("CONCURRENT_RUN_LIMIT");

    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "0");
    const uncapped = await reads.requestCreateDirectRun(
      actor,
      { agentId: compose.agentId, prompt: "uncapped third run" },
      [201],
    );
    if (uncapped.status !== 201) {
      throw new Error("Expected the uncapped run create to succeed");
    }
    await api.requestCancelRun(actor, uncapped.body.runId, [200]);
    await api.requestCancelRun(actor, first.runId, [200]);
    await api.requestCancelRun(actor, second.runId, [200]);
  });

  it("rejects a foreign agent before admitting a direct run", async () => {
    const actor = await entitledActor();
    const compose = await createClaudeAgent(actor, "bdd-admission");
    const first = await api.createDirectRun(actor, {
      agentId: compose.agentId,
      prompt: "first concurrent run",
    });
    const second = await api.createDirectRun(actor, {
      agentId: compose.agentId,
      prompt: "second concurrent run",
    });
    const outsider = bdd.user();
    const foreignCompose = await createClaudeAgent(outsider, "bdd-foreign");
    const crossOrgCompose = await reads.requestCreateDirectRun(
      actor,
      {
        agentId: foreignCompose.agentId,
        prompt: "run a foreign compose",
      },
      [404],
    );
    expectApiError(crossOrgCompose.body);
    expect(crossOrgCompose.body.error.message).toBe("Resource not found");
    await api.requestCancelRun(actor, first.runId, [200]);
    await api.requestCancelRun(actor, second.runId, [200]);
  });

  it("restricts production network-body capture to staff organizations", async () => {
    const actor = await entitledActor();
    const compose = await createClaudeAgent(actor, "bdd-admission");
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "0");
    mockEnv("ENV", "production");
    mockOptionalEnv("VERCEL_ENV", "preview");
    const legacyDomainActor = {
      ...actor,
      email: `bdd-${randomUUID().slice(0, 8)}@vm0.ai`,
    };
    await bdd.readMe(legacyDomainActor);
    const externalGate = await reads.requestCreateDirectRun(
      legacyDomainActor,
      {
        agentId: compose.agentId,
        prompt: "capture from a non-staff organization",
        captureNetworkBodies: true,
      },
      [403],
    );
    expectApiError(externalGate.body);
    expect(externalGate.body.error.message).toContain("internal accounts");

    const staff = bdd.user({ orgId: createUniqueStaffOrgIdFixture() });
    await api.grantProEntitlement(staff);
    const staffAgent = await createClaudeAgent(staff, "bdd-staff-capture");
    const allowed = await reads.requestCreateDirectRun(
      staff,
      {
        agentId: staffAgent.agentId,
        prompt: "capture from a staff organization",
        captureNetworkBodies: true,
      },
      [201],
    );
    if (allowed.status !== 201) {
      throw new Error("Expected the staff capture run create to succeed");
    }
    const captureClaim = await api.claimRunnerJob(allowed.body.runId);
    expect(captureClaim.captureNetworkBodies).toBeTruthy();
    await api.requestCancelRun(staff, allowed.body.runId, [200]);
  });
});

interface AxiomQueryRows {
  readonly events?: readonly Record<string, unknown>[];
  readonly network?: readonly unknown[];
  readonly runContext?: readonly Record<string, unknown>[];
}

/** Answers Activity diagnostic Axiom reads by APL shape and runId. */
function dispatchAxiomQueries(
  rowsByRun: Readonly<Record<string, AxiomQueryRows>>,
): void {
  context.mocks.axiom.query.mockImplementation((apl: unknown) => {
    if (typeof apl !== "string") {
      return Promise.resolve([]);
    }
    const runId = Object.keys(rowsByRun).find((id) => {
      return apl.includes(id);
    });
    const rows = runId === undefined ? undefined : rowsByRun[runId];
    if (!rows) {
      return Promise.resolve([]);
    }
    if (apl.includes("['agent-run-events']")) {
      return Promise.resolve(sequenceEventRows(apl, rows.events ?? []));
    }
    if (apl.includes("['sandbox-telemetry-network']")) {
      return Promise.resolve(timeCursorRows(apl, rows.network ?? []));
    }
    if (apl.includes("['run-context']")) {
      return Promise.resolve([...(rows.runContext ?? [])]);
    }
    return Promise.resolve([]);
  });
}

function sequenceEventRows(
  apl: string,
  rows: readonly Record<string, unknown>[],
): readonly Record<string, unknown>[] {
  const boundaryMatch = /\| where sequenceNumber ([<>]) (-?\d+)/.exec(apl);
  const boundary = boundaryMatch?.[2] ? Number(boundaryMatch[2]) : undefined;
  const operator = boundaryMatch?.[1];
  const order = apl.includes("| order by sequenceNumber desc") ? "desc" : "asc";
  const limitMatch = /\| limit (\d+)/.exec(apl);
  const limit = limitMatch?.[1] ? Number(limitMatch[1]) : rows.length;

  return [...rows]
    .filter((row) => {
      if (boundary === undefined || typeof row.sequenceNumber !== "number") {
        return boundary === undefined;
      }
      return operator === ">"
        ? row.sequenceNumber > boundary
        : row.sequenceNumber < boundary;
    })
    .sort((left, right) => {
      const leftSequence = Number(left.sequenceNumber);
      const rightSequence = Number(right.sequenceNumber);
      return order === "asc"
        ? leftSequence - rightSequence
        : rightSequence - leftSequence;
    })
    .slice(0, limit);
}

function isAxiomRow(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function axiomCursorOption(value: unknown): string | undefined {
  if (!isAxiomRow(value)) {
    return undefined;
  }

  return typeof value.cursor === "string" ? value.cursor : undefined;
}

function timeCursorRows(
  apl: string,
  rows: readonly unknown[],
): readonly unknown[] {
  if (!apl.includes("cursor_current()")) {
    return [...rows];
  }

  return rows.map((row, index) => {
    if (!isAxiomRow(row) || typeof row._timeCursor === "string") {
      return row;
    }

    return {
      ...row,
      _timeCursor: `cursor-${index.toString().padStart(4, "0")}`,
    };
  });
}

function axiomCallCount(): number {
  return context.mocks.axiom.query.mock.calls.length;
}

function axiomCallAt(index: number): readonly unknown[] {
  const call = context.mocks.axiom.query.mock.calls[index];
  if (!call) {
    throw new Error(`Expected an Axiom query call at index ${index}`);
  }
  return call;
}

function expectTimeCursorAxiomResume(
  call: readonly unknown[],
  expected: {
    readonly cursor: string;
    readonly order: "asc" | "desc";
  },
): void {
  const apl = call[0];
  expect(call[1]).toStrictEqual({
    cursor: expected.cursor,
    noCache: true,
  });
  expect(apl).toContain(`| order by _time ${expected.order}`);
  expect(apl).not.toContain("| where _time > datetime(");
  expect(apl).not.toContain("| where _time < datetime(");
  expect(apl).not.toContain("_timeCursor >");
  expect(apl).not.toContain("_timeCursor <");
}

function networkHardeningRows(
  runId: string,
  userId: string,
): readonly unknown[] {
  return [
    "not-a-network-log-row",
    {
      _time: 123,
      runId,
      userId,
      type: "http",
      action: "ALLOW",
      host: "missing-time.example.com",
    },
    {
      _time: "2026-06-10T12:00:00Z",
      runId,
      userId,
      type: "http",
      action: "MAYBE",
      host: 42,
      port: "443",
      status: "200",
      browser_user_agent: "true",
      firewall_params: { owner: "vm0-ai", broken: 5 },
      connector_diagnostic_env_names: ["FAL_TOKEN", 5],
      connector_route_candidates: ["primary", 5],
      auth_resolved_secrets: ["TOKEN", null],
      request_headers: { host: "api.example.com", broken: false },
      request_body_encoding: "utf-16",
      request_body_truncated: "false",
      response_body_encoding: "binary",
      model_catalog_cache_status: "unbounded-provider-value",
      model_catalog_cache_upstream_encoding: "gzip",
      model_catalog_cache_entry_age_ms: "61000",
      model_catalog_cache_validation_latency_ms: -1,
      model_catalog_cache_eviction_count: 33,
      model_catalog_prefetch_role: "credential-specific-value",
    },
    {
      _time: "2026-06-10T12:01:00Z",
      runId,
      userId,
      type: "http",
      action: "BLOCK",
      host: "blocked.example.com",
      port: 443,
      firewall_error: "connector_not_configured",
      model_catalog_cache_status: "model_catalog_revalidated_200_same",
      model_catalog_cache_upstream_encoding: "br",
      model_catalog_cache_bypass_reason: "response_cache_control",
      model_catalog_cache_entry_age_ms: 61_000,
      model_catalog_cache_validation_latency_ms: 1700,
      model_catalog_cache_eviction_count: 1,
      model_catalog_prefetch_role: "inflight_consumer",
      upstream_binding_reason: "connector_auth",
      upstream_binding_trusted_host: "api.github.com",
      upstream_binding_request_host: "203.0.113.10",
      upstream_binding_request_port: 443,
      upstream_binding_server_connected: true,
      upstream_binding_server_address: "203.0.113.10:443",
      upstream_binding_server_peername: "140.82.121.4:443",
      upstream_binding_server_sockname: "10.0.0.2:51000",
      upstream_binding_client_sockname: "10.0.0.1:41000",
      upstream_binding_server_id: "server-1",
      upstream_binding_client_id: "client-1",
      upstream_binding_direct_binding_present: true,
      upstream_binding_direct_binding_host: "api.github.com",
      upstream_binding_direct_binding_port: 443,
      upstream_binding_direct_binding_kinds: "connector_auth",
      upstream_binding_client_binding_count: 2,
      upstream_binding_client_binding_match: true,
      upstream_binding_client_binding_endpoint_match: false,
      upstream_binding_client_binding_hosts:
        "api.github.com, uploads.github.com",
    },
    {
      _time: "2026-06-10T12:02:00Z",
      runId,
      userId,
      type: "dns",
      dns_event: "reply",
    },
  ];
}

function agentEvent(
  runId: string,
  sequenceNumber: number,
  text: string,
): Record<string, unknown> {
  return {
    _time: "2026-06-10T10:30:00Z",
    runId,
    sequenceNumber,
    eventType: "assistant",
    eventData: { message: { content: [{ type: "text", text }] } },
  };
}

function timeLogCursor(
  order: "asc" | "desc",
  timestamp: string,
  tieBreaker: string,
): string {
  return `time:${order}:${encodeURIComponent(timestamp)}:${encodeURIComponent(
    tieBreaker,
  )}`;
}

function timeLogQueryPath(
  path: string,
  query: {
    readonly cursor: string;
    readonly limit: number;
    readonly order: "asc" | "desc";
  },
): string {
  const params = new URLSearchParams({
    cursor: query.cursor,
    limit: String(query.limit),
    order: query.order,
  });
  return `${path}?${params.toString()}`;
}

describe("RUN-04: agent run telemetry families", () => {
  it("serves paged Activity events without leaking another member's run", async () => {
    const actor = await entitledActor();
    const member = bdd.user({ orgId: actor.orgId, orgRole: "org:member" });
    const compose = await createClaudeAgent(actor, "bdd-activity-events");
    const run = await api.createDirectRun(actor, {
      agentId: compose.agentId,
      prompt: "inspect activity events",
    });
    const claim = await api.claimRunnerJob(run.runId);
    await completeRun(run.runId, claim.sandboxToken, {
      lastEventSequence: 1,
    });

    dispatchAxiomQueries({
      [run.runId]: {
        events: [
          agentEvent(run.runId, 0, "First event"),
          agentEvent(run.runId, 1, "Second event"),
        ],
      },
    });

    const firstPage = await reads.requestAgentRunAgentEvents(
      actor,
      run.runId,
      { limit: 1, order: "asc" },
      [200],
    );
    expect(firstPage.body).toStrictEqual({
      events: [
        {
          sequenceNumber: 0,
          eventType: "assistant",
          eventData: {
            message: { content: [{ type: "text", text: "First event" }] },
          },
          createdAt: "2026-06-10T10:30:00Z",
        },
      ],
      hasMore: true,
      nextCursor: "sequence:asc:0",
      status: "completed",
      lastEventSequence: 1,
    });

    const cursor = firstPage.body.nextCursor;
    if (!cursor) {
      throw new Error(
        "Expected the first Activity event page to have a cursor",
      );
    }
    const secondPage = await reads.requestAgentRunAgentEvents(
      actor,
      run.runId,
      { cursor, limit: 1, order: "asc" },
      [200],
    );
    expect(secondPage.body.events).toStrictEqual([
      {
        sequenceNumber: 1,
        eventType: "assistant",
        eventData: {
          message: { content: [{ type: "text", text: "Second event" }] },
        },
        createdAt: "2026-06-10T10:30:00Z",
      },
    ]);
    expect(secondPage.body.hasMore).toBeFalsy();
    expect(secondPage.body.status).toBe("completed");
    expect(secondPage.body.lastEventSequence).toBe(1);

    const memberPage = await reads.requestAgentRunAgentEvents(
      member,
      run.runId,
      { limit: 1, order: "asc" },
      [404],
    );
    expectApiError(memberPage.body);
    expect(memberPage.body.error.message).toBe("Agent run not found");

    const eventQueries = context.mocks.axiom.query.mock.calls.filter(
      ([apl]) => {
        return typeof apl === "string" && apl.includes("['agent-run-events']");
      },
    );
    expect(eventQueries).toHaveLength(2);
    expect(eventQueries[0]?.[0]).toContain(`| where runId == "${run.runId}"`);
    expect(eventQueries[0]?.[0]).toContain("| order by sequenceNumber asc");
    expect(eventQueries[1]?.[0]).toContain("| where sequenceNumber > 0");
    expect(eventQueries[0]?.[1]).toStrictEqual({ noCache: true });
  });

  it("hardens network log rows in the agent read API", async () => {
    const actor = await entitledActor();
    const compose = await createClaudeAgent(actor, "bdd-network-hardening");
    const agentRun = await api.createDirectRun(actor, {
      agentId: compose.agentId,
      prompt: "zero network hardening",
    });

    dispatchAxiomQueries({
      [agentRun.runId]: {
        network: networkHardeningRows(agentRun.runId, actor.userId),
      },
    });

    const networkLogsRead = await reads.requestAgentRunNetworkLogs(
      actor,
      agentRun.runId,
      { limit: 4, order: "asc" },
      [200],
    );
    if (networkLogsRead.status !== 200) {
      throw new Error("Expected the zero network log read to succeed");
    }

    const expectedNetworkLogs = [
      {
        timestamp: "2026-06-10T12:00:00Z",
        type: "http",
        firewall_params: { owner: "vm0-ai" },
        request_headers: { host: "api.example.com" },
        response_body_encoding: "binary",
      },
      {
        timestamp: "2026-06-10T12:01:00Z",
        type: "http",
        action: "BLOCK",
        host: "blocked.example.com",
        port: 443,
        firewall_error: "connector_not_configured",
        model_catalog_cache_status: "model_catalog_revalidated_200_same",
        model_catalog_cache_upstream_encoding: "br",
        model_catalog_cache_bypass_reason: "response_cache_control",
        model_catalog_cache_entry_age_ms: 61_000,
        model_catalog_cache_validation_latency_ms: 1700,
        model_catalog_cache_eviction_count: 1,
        model_catalog_prefetch_role: "inflight_consumer",
        upstream_binding_reason: "connector_auth",
        upstream_binding_trusted_host: "api.github.com",
        upstream_binding_request_host: "203.0.113.10",
        upstream_binding_request_port: 443,
        upstream_binding_server_connected: true,
        upstream_binding_server_address: "203.0.113.10:443",
        upstream_binding_server_peername: "140.82.121.4:443",
        upstream_binding_server_sockname: "10.0.0.2:51000",
        upstream_binding_client_sockname: "10.0.0.1:41000",
        upstream_binding_server_id: "server-1",
        upstream_binding_client_id: "client-1",
        upstream_binding_direct_binding_present: true,
        upstream_binding_direct_binding_host: "api.github.com",
        upstream_binding_direct_binding_port: 443,
        upstream_binding_direct_binding_kinds: "connector_auth",
        upstream_binding_client_binding_count: 2,
        upstream_binding_client_binding_match: true,
        upstream_binding_client_binding_endpoint_match: false,
        upstream_binding_client_binding_hosts:
          "api.github.com, uploads.github.com",
      },
    ];
    const expectedNextCursor = timeLogCursor(
      "asc",
      "2026-06-10T12:01:00Z",
      "cursor-0003",
    );

    expect(networkLogsRead.body).toStrictEqual({
      networkLogs: expectedNetworkLogs,
      hasMore: true,
      nextCursor: expectedNextCursor,
    });
    const networkQuery = axiomCallAt(axiomCallCount() - 1);
    expect(networkQuery[1]).toStrictEqual({ noCache: true });
  });

  it("keeps same-timestamp network rows reachable across time cursor pages", async () => {
    const actor = await entitledActor();
    const compose = await createClaudeAgent(actor, "bdd-time-cursor-ties");
    const run = await api.createDirectRun(actor, {
      agentId: compose.agentId,
      prompt: "emit tied network telemetry",
    });
    const runId = run.runId;
    const timestamp = "2026-06-10T12:30:00Z";
    const laterTimestamp = "2026-06-10T12:30:01Z";
    const olderTimestamp = "2026-06-10T12:29:59Z";
    const networkRows = [
      {
        _time: timestamp,
        _timeCursor: "network-a",
        runId,
        userId: actor.userId,
        type: "http",
        action: "ALLOW",
        host: "first.example.com",
      },
      {
        _time: timestamp,
        _timeCursor: "network-b",
        runId,
        userId: actor.userId,
        type: "http",
        action: "ALLOW",
        host: "second.example.com",
      },
      {
        _time: laterTimestamp,
        _timeCursor: "network-c",
        runId,
        userId: actor.userId,
        type: "http",
        action: "ALLOW",
        host: "third.example.com",
      },
    ];

    context.mocks.axiom.query.mockImplementation(
      (apl: unknown, options: unknown) => {
        if (
          typeof apl !== "string" ||
          !apl.includes("['sandbox-telemetry-network']")
        ) {
          return Promise.resolve([]);
        }

        const limitMatch = /\| limit (\d+)/.exec(apl);
        const limit = limitMatch?.[1]
          ? Number(limitMatch[1])
          : networkRows.length;
        const cursor = axiomCursorOption(options);
        const cursorIndex =
          cursor === undefined
            ? -1
            : networkRows.findIndex((row) => {
                return row._timeCursor === cursor;
              });
        const startIndex =
          cursor === undefined
            ? 0
            : cursorIndex === -1
              ? networkRows.length
              : cursorIndex + 1;

        return Promise.resolve(
          networkRows.slice(startIndex, startIndex + limit),
        );
      },
    );

    const firstPage = await reads.requestAgentRunNetworkLogs(
      actor,
      runId,
      { limit: 1, order: "asc" },
      [200],
    );
    expect(firstPage.body).toStrictEqual({
      networkLogs: [
        {
          timestamp,
          type: "http",
          action: "ALLOW",
          host: "first.example.com",
        },
      ],
      hasMore: true,
      nextCursor: timeLogCursor("asc", timestamp, "network-a"),
    });

    const cursor = firstPage.body.nextCursor;
    if (!cursor) {
      throw new Error(
        "Expected the first tied network page to return a cursor",
      );
    }

    const secondPage = await reads.requestAgentRunNetworkLogs(
      actor,
      runId,
      { cursor, limit: 1, order: "asc" },
      [200],
    );
    expect(secondPage.body).toStrictEqual({
      networkLogs: [
        {
          timestamp,
          type: "http",
          action: "ALLOW",
          host: "second.example.com",
        },
      ],
      hasMore: true,
      nextCursor: timeLogCursor("asc", timestamp, "network-b"),
    });
    const secondPageCall = axiomCallAt(axiomCallCount() - 1);
    expectTimeCursorAxiomResume(secondPageCall, {
      cursor: "network-a",
      order: "asc",
    });

    const descRows = [
      {
        _time: timestamp,
        _timeCursor: "desc-a",
        runId,
        userId: actor.userId,
        type: "http",
        action: "ALLOW",
        host: "desc-first.example.com",
      },
      {
        _time: timestamp,
        _timeCursor: "desc-b",
        runId,
        userId: actor.userId,
        type: "http",
        action: "ALLOW",
        host: "desc-second.example.com",
      },
      {
        _time: olderTimestamp,
        _timeCursor: "desc-c",
        runId,
        userId: actor.userId,
        type: "http",
        action: "ALLOW",
        host: "desc-third.example.com",
      },
    ];
    context.mocks.axiom.query.mockImplementation(
      (apl: unknown, options: unknown) => {
        if (
          typeof apl !== "string" ||
          !apl.includes("['sandbox-telemetry-network']")
        ) {
          return Promise.resolve([]);
        }

        const limitMatch = /\| limit (\d+)/.exec(apl);
        const limit = limitMatch?.[1] ? Number(limitMatch[1]) : descRows.length;
        const cursor = axiomCursorOption(options);
        const cursorIndex =
          cursor === undefined
            ? -1
            : descRows.findIndex((row) => {
                return row._timeCursor === cursor;
              });
        const startIndex =
          cursor === undefined
            ? 0
            : cursorIndex === -1
              ? descRows.length
              : cursorIndex + 1;

        return Promise.resolve(descRows.slice(startIndex, startIndex + limit));
      },
    );

    const descFirst = await reads.requestAgentRunNetworkLogs(
      actor,
      runId,
      { limit: 1, order: "desc" },
      [200],
    );
    expect(descFirst.body).toStrictEqual({
      networkLogs: [
        {
          timestamp,
          type: "http",
          action: "ALLOW",
          host: "desc-first.example.com",
        },
      ],
      hasMore: true,
      nextCursor: timeLogCursor("desc", timestamp, "desc-a"),
    });
    const descCursor = descFirst.body.nextCursor;
    if (!descCursor) {
      throw new Error(
        "Expected the first desc tied network page to return a cursor",
      );
    }

    const descSecond = await reads.requestAgentRunNetworkLogs(
      actor,
      runId,
      { cursor: descCursor, limit: 1, order: "desc" },
      [200],
    );
    expect(descSecond.body).toStrictEqual({
      networkLogs: [
        {
          timestamp,
          type: "http",
          action: "ALLOW",
          host: "desc-second.example.com",
        },
      ],
      hasMore: true,
      nextCursor: timeLogCursor("desc", timestamp, "desc-b"),
    });
    const descSecondCall = axiomCallAt(axiomCallCount() - 1);
    expectTimeCursorAxiomResume(descSecondCall, {
      cursor: "desc-a",
      order: "desc",
    });
  });

  it("fails visibly when a network page cannot advance its cursor", async () => {
    const actor = await entitledActor();
    const compose = await createClaudeAgent(actor, "bdd-unpageable");
    const run = await api.createDirectRun(actor, {
      agentId: compose.agentId,
      prompt: "emit an unpageable network boundary",
    });
    const runId = run.runId;
    const boundaryTime = "2026-06-10T12:00:00Z";

    dispatchAxiomQueries({
      [runId]: {
        network: [
          {
            _time: boundaryTime,
            runId,
            userId: actor.userId,
            type: "http",
            action: "ALLOW",
            host: "api.example.com",
          },
          {
            _time: "2026-06-10T12:00:01Z",
            runId,
            userId: actor.userId,
            type: "http",
            action: "ALLOW",
            host: "later.example.com",
          },
        ],
      },
    });

    const cursor = timeLogCursor("asc", boundaryTime, "cursor-0000");
    const networkLogs = await reads.rawApiRequest(
      actor,
      timeLogQueryPath(`/api/runs/${runId}/network`, {
        cursor,
        limit: 1,
        order: "asc",
      }),
    );
    expect(networkLogs).toStrictEqual({
      status: 500,
      body: { error: "Internal server error" },
    });
  });

  it("preserves reuse outcomes from completion through runner reads", async () => {
    const actor = await entitledActor();
    await api.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD sandbox reuse reason agent",
      description: "Sandbox reuse reason compatibility.",
      visibility: "private",
    });
    const scenarios = [
      {
        name: "legacy no session ID",
        sandboxResult: "noSessionId",
        workspaceResult: undefined,
      },
      {
        name: "no reuse key",
        sandboxResult: "noReuseKey",
        workspaceResult: "reused",
      },
    ] as const;

    for (const scenario of scenarios) {
      const run = await api.createRun(actor, {
        agentId: agent.agentId,
        prompt: `record ${scenario.name}`,
        modelProvider: "anthropic-api-key",
      });
      const claim = await api.claimRunnerJob(run.runId);
      const headers = sandboxHeaders(claim.sandboxToken);

      const completion = await webhooks.requestAgentComplete(
        {
          runId: run.runId,
          exitCode: 0,
          checkpoint: {
            cliAgentType: "claude-code",
            cliAgentSessionId: `bdd-cli-${run.runId}`,
            cliAgentSessionHistoryHash: createHash("sha256")
              .update(`bdd sandbox reuse ${run.runId}`)
              .digest("hex"),
          },
          sandboxReuseResult: scenario.sandboxResult,
          workspaceReuseResult: scenario.workspaceResult,
        },
        headers,
        [200],
      );
      expect(completion.body).toStrictEqual({
        success: true,
        status: "completed",
      });

      const runner = await api.requestRunRunner(actor, run.runId, [200]);
      expect(runner.body).toStrictEqual({
        sandboxReuseResult: scenario.sandboxResult,
        workspaceReuseResult: scenario.workspaceResult ?? null,
        runnerHostname: null,
        runnerVersion: null,
        runnerId: expect.any(String),
        runnerHeartbeatGeneration: 1,
      });
    }
  });

  it("drops invalid persisted reuse outcomes independently", async () => {
    const fixture = await store.set(
      seedUsageStateFixture$,
      undefined,
      context.signal,
    );
    onTestFinished(async () => {
      await store.set(deleteUsageStateFixture$, fixture, context.signal);
    });
    const compose = await store.set(seedCompose$, fixture, context.signal);
    const actor = bdd.user(fixture);
    const invalidSandbox = await store.set(
      seedRun$,
      {
        ...fixture,
        composeId: compose.agentId,
        status: "completed",
        completedAt: nowDate(),
        sandboxReuseResult: "unknownSandboxResult",
        workspaceReuseResult: "reused",
      },
      context.signal,
    );
    const invalidWorkspace = await store.set(
      seedRun$,
      {
        ...fixture,
        composeId: compose.agentId,
        status: "completed",
        completedAt: nowDate(),
        sandboxReuseResult: "poolMiss",
        workspaceReuseResult: "unknownWorkspaceResult",
      },
      context.signal,
    );

    const sandboxResult = await api.requestRunRunner(
      actor,
      invalidSandbox.runId,
      [200],
    );
    expect(sandboxResult.body).toStrictEqual({
      sandboxReuseResult: null,
      workspaceReuseResult: "reused",
      runnerHostname: null,
      runnerVersion: null,
      runnerId: null,
      runnerHeartbeatGeneration: null,
    });
    const workspaceResult = await api.requestRunRunner(
      actor,
      invalidWorkspace.runId,
      [200],
    );
    expect(workspaceResult.body).toStrictEqual({
      sandboxReuseResult: "poolMiss",
      workspaceReuseResult: null,
      runnerHostname: null,
      runnerVersion: null,
      runnerId: null,
      runnerHeartbeatGeneration: null,
    });
  });

  it("bounds run context Axiom scans around the run creation time", async () => {
    const actor = await entitledActor();
    await api.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD bounded run context agent",
      description: "Bounded run context reads.",
      visibility: "private",
    });
    const agentRun = await api.createRun(actor, {
      agentId: agent.agentId,
      prompt: "bounded run context",
      modelProvider: "anthropic-api-key",
    });
    onTestFinished(async () => {
      await api.requestCancelRun(actor, agentRun.runId, [200]);
    });

    const runCreatedAt = agentRun.createdAt;
    if (runCreatedAt === undefined) {
      throw new Error("Expected the created run to include its creation time");
    }
    const runCreatedAtMs = Date.parse(runCreatedAt);
    if (!Number.isFinite(runCreatedAtMs)) {
      throw new Error("Expected the created run to have a valid creation time");
    }
    dispatchAxiomQueries({
      [agentRun.runId]: {
        runContext: [{ runId: agentRun.runId, sessionId: "bdd-bounded" }],
      },
    });
    const queryStartIndex = axiomCallCount();

    const contextRead = await api.requestRunContext(
      actor,
      agentRun.runId,
      [200],
    );
    if (contextRead.status !== 200) {
      throw new Error("Expected the run context read to succeed");
    }
    expect(contextRead.body).toMatchObject({
      runId: agentRun.runId,
      prompt: "bounded run context",
      sessionId: "bdd-bounded",
    });

    const runContextQueries = context.mocks.axiom.query.mock.calls
      .slice(queryStartIndex)
      .filter(([apl]) => {
        return typeof apl === "string" && apl.includes("['run-context']");
      });
    expect(runContextQueries).toHaveLength(1);
    expect(runContextQueries[0]?.[1]).toStrictEqual({
      startTime: new Date(runCreatedAtMs - HOUR_MS).toISOString(),
      endTime: new Date(runCreatedAtMs + HOUR_MS).toISOString(),
    });
  });

  it("maps agent run context, network, and runner metadata from axiom snapshots", async () => {
    const actor = await entitledActor();
    const member = bdd.user({ orgId: actor.orgId, orgRole: "org:member" });
    await api.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD zero detail agent",
      description: "Agent run detail reads.",
      visibility: "private",
    });

    const agentRun = await api.createRun(actor, {
      agentId: agent.agentId,
      prompt: "agent run detail",
      modelProvider: "anthropic-api-key",
    });
    const claim = await api.claimRunnerJob(agentRun.runId);
    const headers = sandboxHeaders(claim.sandboxToken);
    await webhooks.requestAgentComplete(
      {
        runId: agentRun.runId,
        exitCode: 0,
        checkpoint: {
          cliAgentType: "claude-code",
          cliAgentSessionId: `bdd-cli-${agentRun.runId}`,
          cliAgentSessionHistoryHash: createHash("sha256")
            .update(`bdd zero detail ${agentRun.runId}`)
            .digest("hex"),
        },
        sandboxReuseResult: "reused",
        workspaceReuseResult: "sandboxReused",
      },
      headers,
      [200],
    );

    const bareRun = await api.createRun(actor, {
      agentId: agent.agentId,
      prompt: "agent run without snapshots",
      modelProvider: "anthropic-api-key",
    });

    const runId = agentRun.runId;
    dispatchAxiomQueries({
      [runId]: {
        network: [
          {
            _time: "2026-06-10T11:00:00Z",
            runId,
            userId: actor.userId,
            type: "http",
            action: "ALLOW",
            host: "api.example.com",
            port: 443,
            method: "GET",
            url: "[truncated]",
            url_truncated: true,
            url_original_char_count: 1_000_001,
            status: 200,
            latency_ms: 150,
            request_size: 100,
            response_size: 2048,
            firewall_params: { owner: "vm0-ai", broken: 5 },
            connector_diagnostic_slug: "fal",
            connector_diagnostic_reason: "not_configured_for_run",
            connector_diagnostic_env_names: ["FAL_TOKEN"],
            connector_diagnostic_base: "https://fal.run",
            request_headers: { accept: "application/json", junk: 9 },
            request_headers_truncated: true,
            request_body: "req",
            request_body_encoding: UTF8_ENCODING,
            request_body_truncated: false,
            response_headers: { server: "***", junk: 9 },
            response_headers_truncated: false,
            response_body: "cmVz",
            response_body_encoding: "base64",
            response_body_truncated: true,
          },
          {
            _time: "2026-06-10T11:00:01Z",
            runId,
            userId: actor.userId,
            type: "tcp",
            action: "MAYBE",
            host: "redis.example.com",
            port: 6379,
            request_body_encoding: "weird",
            response_headers_truncated: "false",
            auth_cache_hit: null,
          },
          {
            _time: "2026-06-10T11:00:02Z",
            runId,
            userId: actor.userId,
            type: "dns",
            host: "api.github.com",
            port: 53,
            dns_event: "reply",
            dns_result: "140.82.121.4",
            dns_serial: "42",
          },
        ],
        runContext: [
          {
            runId,
            cliAgentType: "claude-code",
            sessionId: "bdd-session-1",
            piModelConfigGeneration: "unknown",
            piModelConfigLegacyApi: "unknown",
            environmentShadowClassification: "mixed_difference",
            environmentShadowLegacyOnlyCountBucket: "2_4",
            environmentShadowCandidateOnlyCountBucket: "1",
            environmentShadowSharedValueDifferenceCountBucket: "5_8",
            agentExecutionAuthority: "version_content",
            agentExecutionAuthorityClassification:
              "systemEnvironmentDifferences",
            environment: { LEGACY_IGNORED: "legacy-map" },
            environmentEntries: [
              { name: "NODE_ENV", value: "production" },
              { name: "EMPTY", value: null },
              { name: "NUM", value: 5 },
              { value: "missing-name" },
            ],
            firewalls: [
              {
                kind: "builtin",
                name: "catalog-fw",
                baseUrlVars: { REGION: "us-east-1" },
                sourceId: "33333333-3333-4333-8333-333333333333",
              },
              {
                kind: "inline",
                name: "test-fw",
                customConnectorId: "11111111-1111-4111-8111-111111111111",
                sourceId: "22222222-2222-4222-8222-222222222222",
                apis: [
                  {
                    id: "test-fw:0",
                    base: "https://api.example.com",
                    hostPolicy: { kind: "publicDestination" },
                    auth: {
                      headerEntries: [
                        {
                          name: "Authorization",
                          value: `Bearer \${{ secrets.TEST_TOKEN }}`,
                        },
                      ],
                      base: "https://auth.example.com",
                      queryEntries: [
                        {
                          name: "api_key",
                          value: `\${{ secrets.TEST_QUERY_TOKEN }}`,
                        },
                      ],
                    },
                    permissions: [{ name: "read", rules: ["GET /users/*"] }],
                  },
                  {
                    id: "test-fw:1",
                    base: "https://aws.example.com",
                    auth: {
                      awsSigv4: {
                        accessKeyId: `\${{ secrets.AWS_ACCESS_KEY_ID }}`,
                        secretAccessKey: `\${{ secrets.AWS_SECRET_ACCESS_KEY }}`,
                        sessionToken: `\${{ secrets.AWS_SESSION_TOKEN }}`,
                      },
                    },
                  },
                ],
              },
              {
                kind: "inline",
                name: "fallback-fw",
                apis: [
                  {
                    base: "https://fallback.example.com",
                    auth: {
                      headerEntries: [
                        { name: "Authorization", value: "conflicting-auth" },
                      ],
                      awsSigv4: {
                        accessKeyId: "access-key",
                        secretAccessKey: "secret-key",
                      },
                    },
                    permissions: [
                      { name: "fallback", rules: ["GET /fallback"] },
                    ],
                  },
                ],
              },
              {
                name: "historical-fw",
                apis: [{ base: "https://historical.example.com" }],
              },
            ],
            volumes: [
              {
                name: "data",
                mountPath: "/data",
                vasStorageName: "vol-1",
                vasVersionId: "ver-1",
              },
            ],
            artifact: {
              mountPath: "/artifacts",
              vasStorageName: "art-1",
              vasVersionId: "art-ver-1",
            },
            featureFlags: { legacyIgnored: true },
            featureFlagEntries: [
              { name: "manualMorningBrief", enabled: true },
              { name: "dummy", enabled: null },
              { enabled: true },
            ],
            networkPolicies: {
              legacyIgnored: {
                allow: ["legacy"],
                deny: [],
                ask: [],
                unknownPolicy: "deny",
              },
            },
            networkPolicyEntries: [
              {
                name: "github",
                policy: {
                  allow: ["repo-read"],
                  deny: [],
                  ask: [],
                  unknownPolicy: "allow",
                },
              },
              { name: "broken", policy: "nope" },
              { name: "invalid", policy: { unknownPolicy: "bogus" } },
              {
                policy: {
                  allow: ["missing-name"],
                  deny: [],
                  ask: [],
                  unknownPolicy: "allow",
                },
              },
            ],
          },
        ],
      },
    });

    const contextRead = await api.requestRunContext(actor, runId, [200]);
    if (contextRead.status !== 200) {
      throw new Error("Expected the run context read to succeed");
    }
    expect(contextRead.body).toMatchObject({
      runId,
      prompt: "agent run detail",
      cliAgentType: "claude-code",
      sessionId: "bdd-session-1",
      environment: { NODE_ENV: "production" },
      networkPolicies: {
        github: {
          allow: ["repo-read"],
          deny: [],
          ask: [],
          unknownPolicy: "allow",
        },
      },
      featureFlags: { manualMorningBrief: true },
      artifact: { vasStorageName: "art-1" },
    });
    expect(contextRead.body.environment).toStrictEqual({
      NODE_ENV: "production",
    });
    expect(contextRead.body).not.toHaveProperty(
      "environmentShadowClassification",
    );
    expect(contextRead.body).not.toHaveProperty("agentExecutionAuthority");
    expect(contextRead.body).not.toHaveProperty("piModelConfigGeneration");
    expect(contextRead.body).not.toHaveProperty("piModelConfigLegacyApi");
    expect(contextRead.body).not.toHaveProperty(
      "agentExecutionAuthorityClassification",
    );
    expect(Object.keys(contextRead.body.networkPolicies ?? {})).toStrictEqual([
      "github",
    ]);
    // New inline responses retain the previous top-level name/apis shape so
    // already-loaded web clients can parse them as sanitized firewalls.
    expect(contextRead.body.firewalls).toStrictEqual([
      {
        kind: "builtin",
        name: "catalog-fw",
        baseUrlVars: { REGION: "us-east-1" },
        sourceId: "33333333-3333-4333-8333-333333333333",
      },
      {
        kind: "inline",
        customConnectorId: "11111111-1111-4111-8111-111111111111",
        sourceId: "22222222-2222-4222-8222-222222222222",
        name: "test-fw",
        apis: [
          {
            id: "test-fw:0",
            base: "https://api.example.com",
            hostPolicy: { kind: "publicDestination" },
            auth: {
              headers: {
                Authorization: `Bearer \${{ secrets.TEST_TOKEN }}`,
              },
              base: "https://auth.example.com",
              query: { api_key: `\${{ secrets.TEST_QUERY_TOKEN }}` },
            },
            permissions: [{ name: "read", rules: ["GET /users/*"] }],
          },
          {
            id: "test-fw:1",
            base: "https://aws.example.com",
            auth: {
              awsSigv4: {
                accessKeyId: `\${{ secrets.AWS_ACCESS_KEY_ID }}`,
                secretAccessKey: `\${{ secrets.AWS_SECRET_ACCESS_KEY }}`,
                sessionToken: `\${{ secrets.AWS_SESSION_TOKEN }}`,
              },
            },
          },
        ],
      },
      {
        name: "fallback-fw",
        apis: [
          {
            base: "https://fallback.example.com",
            permissions: [{ name: "fallback", rules: ["GET /fallback"] }],
          },
        ],
      },
      {
        name: "historical-fw",
        apis: [{ base: "https://historical.example.com" }],
      },
    ]);
    expect(contextRead.body.volumes).toHaveLength(1);

    // Legacy dynamic map fields are ignored now that run context snapshots
    // are entries-only.
    dispatchAxiomQueries({
      [runId]: {
        runContext: [
          {
            runId,
            environment: { LEGACY_IGNORED: "legacy-map" },
            networkPolicies: {
              legacyIgnored: {
                allow: ["legacy"],
                deny: [],
                ask: [],
                unknownPolicy: "allow",
              },
            },
            featureFlags: { legacyIgnored: true },
          },
        ],
      },
    });
    const legacyOnlyContext = await api.requestRunContext(actor, runId, [200]);
    if (legacyOnlyContext.status !== 200) {
      throw new Error("Expected the legacy-only run context read to succeed");
    }
    expect(legacyOnlyContext.body).toMatchObject({
      runId,
      sessionId: null,
      environment: {},
      networkPolicies: null,
      featureFlags: null,
      firewalls: [],
      volumes: [],
      artifact: null,
    });

    const noSnapshot = await api.requestRunContext(actor, bareRun.runId, [404]);
    expectApiError(noSnapshot.body);
    expect(noSnapshot.body.error.message).toBe("Run context not available");

    // Re-dispatch the full row set for the network read.
    dispatchAxiomQueries({
      [runId]: {
        runContext: [{ runId, cliAgentType: "claude-code" }],
        network: [
          {
            _time: "2026-06-10T11:00:00Z",
            runId,
            userId: actor.userId,
            type: "http",
            action: "ALLOW",
            host: "api.example.com",
            port: 443,
            method: "GET",
            url: "[truncated]",
            url_truncated: true,
            url_original_char_count: 1_000_001,
            status: 200,
            latency_ms: 150,
            request_size: 100,
            response_size: 2048,
            firewall_params: { owner: "vm0-ai", broken: 5 },
            connector_diagnostic_slug: "fal",
            connector_diagnostic_reason: "not_configured_for_run",
            connector_diagnostic_env_names: ["FAL_TOKEN"],
            connector_diagnostic_base: "https://fal.run",
            request_headers: { accept: "application/json", junk: 9 },
            request_headers_truncated: true,
            request_body: "req",
            request_body_encoding: UTF8_ENCODING,
            request_body_truncated: false,
            response_headers: { server: "***", junk: 9 },
            response_headers_truncated: false,
            response_body: "cmVz",
            response_body_encoding: "base64",
            response_body_truncated: true,
          },
          {
            _time: "2026-06-10T11:00:01Z",
            runId,
            userId: actor.userId,
            type: "tcp",
            action: "MAYBE",
            host: "redis.example.com",
            port: 6379,
            request_body_encoding: "weird",
            response_headers_truncated: "false",
            auth_cache_hit: null,
          },
          {
            _time: "2026-06-10T11:00:02Z",
            runId,
            userId: actor.userId,
            type: "dns",
            host: "api.github.com",
            port: 53,
            dns_event: "reply",
            dns_result: "140.82.121.4",
            dns_serial: "42",
          },
          {
            _time: "2026-06-10T11:00:03Z",
            runId,
            userId: actor.userId,
            type: "http",
            action: "BLOCK",
            host: "blocked.example.com",
            port: 443,
            method: "POST",
            url: "https://blocked.example.com/v1/connect",
            status: 424,
            firewall_error: "connector_not_configured",
          },
        ],
      },
    });

    const network = await reads.requestAgentRunNetworkLogs(
      actor,
      runId,
      {},
      [200],
    );
    if (network.status !== 200) {
      throw new Error("Expected the zero network log read to succeed");
    }
    expect(network.body.networkLogs).toHaveLength(4);
    expect(network.body.hasMore).toBeFalsy();
    expect(network.body.networkLogs[0]).toStrictEqual({
      timestamp: "2026-06-10T11:00:00Z",
      type: "http",
      action: "ALLOW",
      host: "api.example.com",
      port: 443,
      method: "GET",
      url: "[truncated]",
      url_truncated: true,
      url_original_char_count: 1_000_001,
      status: 200,
      latency_ms: 150,
      request_size: 100,
      response_size: 2048,
      firewall_params: { owner: "vm0-ai" },
      connector_diagnostic_slug: "fal",
      connector_diagnostic_reason: "not_configured_for_run",
      connector_diagnostic_env_names: ["FAL_TOKEN"],
      connector_diagnostic_base: "https://fal.run",
      request_headers: { accept: "application/json" },
      request_headers_truncated: true,
      request_body: "req",
      request_body_encoding: UTF8_ENCODING,
      request_body_truncated: false,
      response_headers: { server: "***" },
      response_headers_truncated: false,
      response_body: "cmVz",
      response_body_encoding: "base64",
      response_body_truncated: true,
    });
    expect(network.body.networkLogs[1]).toStrictEqual({
      timestamp: "2026-06-10T11:00:01Z",
      type: "tcp",
      host: "redis.example.com",
      port: 6379,
    });
    expect(network.body.networkLogs[2]).toMatchObject({
      type: "dns",
      dns_event: "reply",
      dns_result: "140.82.121.4",
      dns_serial: "42",
    });
    expect(network.body.networkLogs[3]).toMatchObject({
      type: "http",
      action: "BLOCK",
      host: "blocked.example.com",
      firewall_error: "connector_not_configured",
    });

    const sinceMs = Date.parse("2026-06-10T10:59:00Z");
    const pagedNetwork = await reads.requestAgentRunNetworkLogs(
      actor,
      runId,
      { limit: 2, since: sinceMs },
      [200],
    );
    if (pagedNetwork.status !== 200) {
      throw new Error("Expected the paged zero network log read to succeed");
    }
    expect(pagedNetwork.body.networkLogs).toHaveLength(2);
    expect(pagedNetwork.body.hasMore).toBeTruthy();
    expect(pagedNetwork.body.nextCursor).toBe(
      timeLogCursor("asc", "2026-06-10T11:00:01Z", "cursor-0001"),
    );
    const networkApl = axiomCallAt(axiomCallCount() - 1)[0];
    expect(networkApl).toContain(new Date(sinceMs).toISOString());

    const wrongNetworkCursorKind = await reads.requestAgentRunNetworkLogs(
      actor,
      runId,
      { cursor: "sequence:asc:1", limit: 1, order: "asc" },
      [400],
    );
    expectApiError(wrongNetworkCursorKind.body);

    const emptyNetwork = await reads.requestAgentRunNetworkLogs(
      actor,
      bareRun.runId,
      {},
      [200],
    );
    if (emptyNetwork.status !== 200) {
      throw new Error("Expected the empty zero network log read to succeed");
    }
    expect(emptyNetwork.body).toStrictEqual({
      networkLogs: [],
      hasMore: false,
    });

    const memberNetwork = await reads.requestAgentRunNetworkLogs(
      member,
      runId,
      {},
      [404],
    );
    expectApiError(memberNetwork.body);
    expect(memberNetwork.body.error.message).toBe("Agent run not found");

    // Runner metadata mirrors the final reuse outcomes from completion.
    const runner = await api.requestRunRunner(actor, runId, [200]);
    expect(runner.body).toStrictEqual({
      sandboxReuseResult: "reused",
      workspaceReuseResult: "sandboxReused",
      runnerHostname: null,
      runnerVersion: null,
      runnerId: expect.any(String),
      runnerHeartbeatGeneration: 1,
    });
    const bareRunner = await api.requestRunRunner(actor, bareRun.runId, [200]);
    expect(bareRunner.body).toStrictEqual({
      sandboxReuseResult: null,
      workspaceReuseResult: null,
      runnerHostname: null,
      runnerVersion: null,
      runnerId: null,
      runnerHeartbeatGeneration: null,
    });

    const memberRunner = await api.requestRunRunner(member, runId, [404]);
    expectApiError(memberRunner.body);
    expect(memberRunner.body.error.message).toBe("Agent run not found");

    await api.requestCancelRun(actor, bareRun.runId, [200]);
  });
});

describe("RUN-04/OPS-01: agent run logs", () => {
  it("lists run logs with filters, paging, agent tokens, and detail residue", async () => {
    const actor = await entitledActor();
    const member = bdd.user({ orgId: actor.orgId, orgRole: "org:member" });
    await api.ensureOrgModelProvider(actor);
    const agentOne = await bdd.createAgent(actor, {
      displayName: "BDD logs agent one",
      description: "Primary logs agent.",
      visibility: "private",
    });
    const agentTwo = await bdd.createAgent(actor, {
      displayName: "BDD logs agent two",
      description: "Secondary logs agent.",
      visibility: "private",
    });
    const memberAgent = await bdd.createAgent(member, {
      displayName: "BDD member logs agent",
      description: "Member isolation.",
      visibility: "private",
    });
    const testCompose = await createClaudeAgent(actor, "bdd-test-logs");
    const agentOneName = await readCanonicalAgentNameFixture(agentOne.agentId);

    const webRun = await api.createRun(actor, {
      agentId: agentOne.agentId,
      prompt: "web run on agent one",
      modelProvider: "anthropic-api-key",
    });
    await api.requestCancelRun(actor, webRun.runId, [200]);
    const secondAgentRun = await api.createRun(actor, {
      agentId: agentTwo.agentId,
      prompt: "web run on agent two",
      modelProvider: "anthropic-api-key",
    });
    await api.requestCancelRun(actor, secondAgentRun.runId, [200]);
    const testRun = await api.createDirectRun(actor, {
      agentId: testCompose.agentId,
      prompt: "direct test run",
    });
    await api.requestCancelRun(actor, testRun.runId, [200]);

    const memberRun = await api.createRun(member, {
      agentId: memberAgent.agentId,
      prompt: "member run stays invisible",
      modelProvider: "anthropic-api-key",
    });
    await api.requestCancelRun(member, memberRun.runId, [200]);

    const listed = await reads.requestListLogs(actor, {}, [200]);
    mustOk(listed, "the logs list");
    const listedIds = listed.body.data.map((entry) => {
      return entry.id;
    });
    expect([...listedIds].sort()).toStrictEqual(
      [webRun.runId, secondAgentRun.runId, testRun.runId].sort(),
    );

    const invalidListSince = await reads.requestListLogs(
      actor,
      { since: 8_640_000_000_000_001 },
      [400],
    );
    expectApiError(invalidListSince.body);

    const webEntry = listed.body.data.find((entry) => {
      return entry.id === webRun.runId;
    });
    expect(webEntry).toMatchObject({
      agentId: agentOne.agentId,
      displayName: "BDD logs agent one",
      framework: "claude-code",
      triggerSource: "web",
      status: "cancelled",
      prompt: "web run on agent one",
    });
    const testEntry = listed.body.data.find((entry) => {
      return entry.id === testRun.runId;
    });
    expect(testEntry).toMatchObject({
      agentId: testCompose.agentId,
      displayName: "Direct run fixture",
      triggerSource: "test",
    });
    const pageOne = await reads.requestListLogs(actor, { limit: 1 }, [200]);
    mustOk(pageOne, "the first log page");
    expect(pageOne.body.data).toHaveLength(1);
    expect(pageOne.body.pagination.hasMore).toBeTruthy();
    const cursor = pageOne.body.pagination.nextCursor;
    if (cursor === null) {
      throw new Error("Expected a next cursor on the first log page");
    }
    const pageTwo = await reads.requestListLogs(
      actor,
      { limit: 1, cursor },
      [200],
    );
    mustOk(pageTwo, "the second log page");
    expect(pageTwo.body.data).toHaveLength(1);
    expect(pageTwo.body.data[0]?.id).not.toBe(pageOne.body.data[0]?.id);

    const malformedCursor = await reads.requestListLogs(
      actor,
      { limit: 1, cursor: "garbage" },
      [200],
    );
    mustOk(malformedCursor, "malformed cursor list");
    expect(malformedCursor.body.data[0]?.id).toBe(pageOne.body.data[0]?.id);

    const malformedStructuredCursor = await reads.requestListLogs(
      actor,
      { limit: 1, cursor: "not-a-date|not-a-run-id" },
      [200],
    );
    mustOk(malformedStructuredCursor, "malformed structured cursor list");
    expect(malformedStructuredCursor.body.data[0]?.id).toBe(
      pageOne.body.data[0]?.id,
    );

    const malformedCursorId = await reads.requestListLogs(
      actor,
      { limit: 1, cursor: "2026-01-15T10:30:00.000Z|not-a-run-id" },
      [200],
    );
    mustOk(malformedCursorId, "malformed cursor id list");
    expect(malformedCursorId.body.data[0]?.id).toBe(pageOne.body.data[0]?.id);

    const agentOneRunIds = [webRun.runId];
    const fuzzy = await reads.requestListLogs(
      actor,
      { search: agentOneName.toUpperCase() },
      [200],
    );
    mustOk(fuzzy, "the fuzzy search list");
    expect(
      fuzzy.body.data
        .map((entry) => {
          return entry.id;
        })
        .sort(),
    ).toStrictEqual(agentOneRunIds);

    const byName = await reads.requestListLogs(
      actor,
      { name: agentOneName },
      [200],
    );
    mustOk(byName, "the name-filtered list");
    expect(
      byName.body.data
        .map((entry) => {
          return entry.id;
        })
        .sort(),
    ).toStrictEqual(agentOneRunIds);

    const byAgentId = await reads.requestListLogs(
      actor,
      { agentId: agentOne.agentId, search: "zzz-no-such-agent" },
      [200],
    );
    mustOk(byAgentId, "the agent-id list");
    expect(
      byAgentId.body.data
        .map((entry) => {
          return entry.id;
        })
        .sort(),
    ).toStrictEqual(agentOneRunIds);

    const byStatusAndSource = await reads.requestListLogs(
      actor,
      { status: "cancelled", triggerSource: "web" },
      [200],
    );
    mustOk(byStatusAndSource, "the status+source list");
    expect(
      byStatusAndSource.body.data
        .map((entry) => {
          return entry.id;
        })
        .sort(),
    ).toStrictEqual([webRun.runId, secondAgentRun.runId].sort());

    const removedAutomationSource =
      await reads.requestListLogsWithRemovedAutomationSource(actor);
    expectApiError(removedAutomationSource.body);

    const noSourceMatch = await reads.requestListLogs(
      actor,
      { triggerSource: "telegram" },
      [200],
    );
    mustOk(noSourceMatch, "the empty source list");
    expect(noSourceMatch.body.data).toStrictEqual([]);

    expect(listed.body.filters.statuses).toContain("cancelled");
    expect([...listed.body.filters.sources].sort()).toStrictEqual([
      "test",
      "web",
    ]);
    expect(listed.body.filters.agents).toContain(agentOne.agentId);
    expect(listed.body.filters.agents).toContain(agentTwo.agentId);

    // Detail residue: pending nulls and failure error.
    const pendingRun = await api.createRun(actor, {
      agentId: agentOne.agentId,
      prompt: "pending detail run",
      modelProvider: "anthropic-api-key",
    });
    const pendingDetail = await reads.requestReadLogById(
      actor,
      pendingRun.runId,
      [200],
    );
    expect(pendingDetail.body).toMatchObject({
      id: pendingRun.runId,
      status: "pending",
      sessionId: null,
      completedAt: null,
    });
    await api.requestCancelRun(actor, pendingRun.runId, [200]);

    const failedRun = await api.createRun(actor, {
      agentId: agentOne.agentId,
      prompt: "failed detail run",
      modelProvider: "anthropic-api-key",
    });
    await webhooks.requestAgentComplete(
      { runId: failedRun.runId, exitCode: 1, error: "bdd failure" },
      sandboxHeaders(api.sandboxTokenForRun(actor, failedRun.runId)),
      [200],
    );
    const failedDetail = await reads.requestReadLogById(
      actor,
      failedRun.runId,
      [200],
    );
    expect(failedDetail.body).toMatchObject({
      id: failedRun.runId,
      status: "failed",
      error: "bdd failure",
    });

    // A claimed run's real Okou token reads the log surfaces by capability.
    const tokenRun = await api.createRun(actor, {
      agentId: agentOne.agentId,
      prompt: "Okou run token log access",
      modelProvider: "anthropic-api-key",
    });
    const tokenClaim = await api.claimRunnerJob(tokenRun.runId);
    const okouToken = tokenClaim.platformEnvironment.OKOU_TOKEN;
    if (!okouToken) {
      throw new Error("Expected the claimed run to expose an OKOU_TOKEN");
    }
    const tokenList = await reads.requestListLogsAs(
      `Bearer ${okouToken}`,
      {},
      [200],
    );
    mustOk(tokenList, "the Okou-token log list");
    expect(
      tokenList.body.data.map((entry) => {
        return entry.id;
      }),
    ).toContain(webRun.runId);
    const tokenDetail = await reads.requestReadLogByIdAs(
      `Bearer ${okouToken}`,
      webRun.runId,
      [200],
    );
    expect(tokenDetail.body).toMatchObject({ id: webRun.runId });

    await api.requestCancelRun(actor, tokenRun.runId, [200]);

    const beforeBoundaryRun = await api.createRun(actor, {
      agentId: agentOne.agentId,
      prompt: "since boundary hidden run",
      modelProvider: "anthropic-api-key",
    });
    await api.requestCancelRun(actor, beforeBoundaryRun.runId, [200]);
    const sinceBoundary = now();
    await waitForTimestampBoundary();
    const sinceBoundaryRun = await api.createRun(actor, {
      agentId: agentOne.agentId,
      prompt: "since boundary visible run",
      modelProvider: "anthropic-api-key",
    });
    await api.requestCancelRun(actor, sinceBoundaryRun.runId, [200]);

    const sinceFiltered = await reads.requestListLogs(
      actor,
      { since: sinceBoundary, limit: 100 },
      [200],
    );
    mustOk(sinceFiltered, "the since-boundary log list");
    const sinceFilteredIds = sinceFiltered.body.data.map((entry) => {
      return entry.id;
    });
    expect(sinceFilteredIds).toContain(sinceBoundaryRun.runId);
    expect(sinceFilteredIds).not.toContain(beforeBoundaryRun.runId);
  });

  it("preserves historical agent-source logs without provenance", async () => {
    const actor = await entitledActor();
    const compose = await createClaudeAgent(actor, "historical-agent-log");
    const historicalAgentRun = await api.createDirectRun(actor, {
      agentId: compose.agentId,
      prompt: "historical agent-source run",
      triggerSource: "agent",
    });
    await api.requestCancelRun(actor, historicalAgentRun.runId, [200]);
    await clearRunLaunchSnapshotFixture(historicalAgentRun.runId);

    const listed = await reads.requestListLogs(actor, {}, [200]);
    if (listed.status !== 200) {
      throw new Error("Expected the historical agent-source log list");
    }
    expect(
      listed.body.data.find((entry) => {
        return entry.id === historicalAgentRun.runId;
      }),
    ).toMatchObject({
      triggerSource: "agent",
      framework: null,
    });
    expect(listed.body.filters.sources).toContain("agent");

    const detail = await reads.requestReadLogById(
      actor,
      historicalAgentRun.runId,
      [200],
    );
    expect(detail.body).toMatchObject({
      id: historicalAgentRun.runId,
      triggerSource: "agent",
      framework: null,
    });
  });
});
