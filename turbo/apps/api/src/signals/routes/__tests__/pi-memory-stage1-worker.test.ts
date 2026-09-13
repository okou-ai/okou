import { createHash, randomUUID } from "node:crypto";
import { gzipSync, zstdCompressSync } from "node:zlib";

import { GetObjectCommand } from "@aws-sdk/client-s3";
import { cronExtractPiMemoryStage1Contract } from "@okouai/api-contracts/contracts/cron";
import {
  SESSION_HISTORY_ENCODING_GZIP,
  SESSION_HISTORY_ENCODING_IDENTITY,
  SESSION_HISTORY_ENCODING_ZSTD,
} from "@okouai/api-contracts/contracts/runners";
import { MemoryPiSession } from "@okouai/pi-agent-runtime/node";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { seedBuiltInModelKey } from "./helpers/runtime-state";
import { createFixtureOperationOwner } from "./helpers/fixture-operation-owner";
import { createDeferredPromise } from "../../utils";
import {
  cronExtractPiMemoryStage1Routes,
  cronExtractPiMemoryStage1RoutesForTest,
} from "../cron-extract-pi-memory-stage1";
import {
  type TestPiMemoryStage1StateActionBody,
  type TestPiMemoryStage1StateResponse,
  testPiMemoryStage1StateContract,
  testPiMemoryStage1StateRoutes,
} from "../test-pi-memory-stage1-state";

import { runInIsolatedProcess } from "../../../../../../scripts/run-isolated-test.mjs";

const context = testContext();
const BUCKET = "pi-memory-stage1-worker-test";
const CRON_SECRET = "test-pi-memory-stage1-secret";
const INPUT_SECRET = "sk-proj-inputsecretabcdefghijklmnopqrstuvwxyz";
const OUTPUT_SECRET = "sk-proj-outputsecretabcdefghijklmnopqrstuvwxyz";

interface CandidateFixture {
  readonly memory_storage_id: string;
  readonly org_id: string;
  readonly user_id: string;
  readonly pi_session_id: string;
  readonly source_history_hash: string;
  readonly objectKey: string;
}

interface ProviderInvocation {
  readonly sequence: number;
  readonly request: unknown;
}

type SessionHistoryEncoding =
  | typeof SESSION_HISTORY_ENCODING_GZIP
  | typeof SESSION_HISTORY_ENCODING_IDENTITY
  | typeof SESSION_HISTORY_ENCODING_ZSTD;

type WithoutOwner<T> = T extends unknown
  ? Omit<T, "memory_storage_id" | "org_id" | "user_id">
  : never;

function requiredObjectKey(key: string | undefined): string {
  if (!key) {
    throw new Error("Expected an S3 object key");
  }
  return key;
}

function asyncBody(body: Uint8Array): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield body;
    },
  };
}

function installS3Objects(): void {
  context.mocks.s3.send.mockImplementation((commandValue: unknown) => {
    if (!(commandValue instanceof GetObjectCommand)) {
      return Promise.resolve({});
    }
    const key = requiredObjectKey(commandValue.input.Key);
    const body = context.sessionHistoryBlobs.get(key);
    if (!body) {
      const error = new Error("Missing object");
      error.name = "NotFound";
      return Promise.reject(error);
    }
    return Promise.resolve({
      Body: asyncBody(body),
      ContentLength: body.length,
    });
  });
}

function failNextObjectRead(key: string): void {
  const fallback = context.mocks.s3.send.getMockImplementation();
  let pending = true;
  context.mocks.s3.send.mockImplementation((commandValue: unknown) => {
    if (
      pending &&
      commandValue instanceof GetObjectCommand &&
      commandValue.input.Key === key
    ) {
      pending = false;
      const error = new Error(
        "secret-bearing provider detail must not persist",
      );
      error.name = "TimeoutError";
      return Promise.reject(error);
    }
    return fallback ? fallback(commandValue) : Promise.resolve({});
  });
}

function responsesSse(
  text: string,
  sequence: number,
  responseId = `resp_pi_memory_stage1_${sequence.toString()}`,
): string {
  const messageId = `msg_pi_memory_stage1_${sequence.toString()}`;
  return [
    {
      type: "response.created",
      response: {
        id: responseId,
        object: "response",
        status: "in_progress",
        output: [],
        usage: null,
      },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "message",
        id: messageId,
        role: "assistant",
        status: "in_progress",
        content: [],
      },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: messageId,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: responseId,
        object: "response",
        status: "completed",
        output: [
          {
            type: "message",
            id: messageId,
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text, annotations: [] }],
          },
        ],
        usage: {
          input_tokens: 12,
          output_tokens: 8,
          input_tokens_details: {
            cached_tokens: 2,
            cache_write_tokens: 3,
          },
          total_tokens: 20,
        },
      },
    },
  ]
    .map((event) => {
      return `data: ${JSON.stringify(event)}\n\n`;
    })
    .join("");
}

function defaultProviderOutput(): string {
  return JSON.stringify({
    raw_memory: `safe surrounding text ${OUTPUT_SECRET}`,
    rollout_summary: `Authorization: Bearer ${OUTPUT_SECRET}`,
    rollout_slug: "pi-stage1-result",
  });
}

function installProvider(
  responder: (
    invocation: ProviderInvocation,
  ) => Promise<string> | string = defaultProviderOutput,
) {
  let sequence = 0;
  const calls: ProviderInvocation[] = [];
  server.use(
    http.post(
      /https:\/\/(?:api\.openai\.com|openrouter\.ai)\/.*\/responses/u,
      async ({ request }) => {
        sequence += 1;
        const invocation = {
          sequence,
          request: (await request.json()) as unknown,
        };
        calls.push(invocation);
        const text = await responder(invocation);
        return new HttpResponse(responsesSse(text, invocation.sequence), {
          headers: { "content-type": "text/event-stream" },
        });
      },
    ),
  );
  return { calls };
}

function assistantMessage(text: string, timestamp: number) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "openai-responses" as const,
    provider: "openai" as const,
    model: "gpt-5.6-terra",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop" as const,
    timestamp,
  };
}

function settledHistory(piSessionId: string, content: string): Buffer {
  const session = MemoryPiSession.create({
    cwd: "/home/user/workspace",
    id: piSessionId,
    timestamp: "2026-09-02T00:00:00.000Z",
  });
  session.appendMessage({ role: "user", content, timestamp: 1 });
  session.appendMessage(assistantMessage("completed safely", 2));
  return Buffer.from(session.toJsonl(), "utf8");
}

function encodeHistory(raw: Buffer, encoding: SessionHistoryEncoding): Buffer {
  switch (encoding) {
    case SESSION_HISTORY_ENCODING_GZIP: {
      return gzipSync(raw);
    }
    case SESSION_HISTORY_ENCODING_ZSTD: {
      return zstdCompressSync(raw);
    }
    case SESSION_HISTORY_ENCODING_IDENTITY: {
      return raw;
    }
  }
}

async function stateAction(
  body: TestPiMemoryStage1StateActionBody,
  signal?: AbortSignal,
): Promise<TestPiMemoryStage1StateResponse> {
  const response = await accept(
    setupApp({ context, routes: testPiMemoryStage1StateRoutes, signal })(
      testPiMemoryStage1StateContract,
    ).action({ body }),
    [200],
  );
  return response.body;
}

function createStorageFixture() {
  const memoryStorageId = randomUUID();
  const orgId = `org_pi_stage1_${randomUUID()}`;
  const userId = `user_pi_stage1_${randomUUID()}`;
  const sourceHashes: string[] = [];
  const agentSessionIds: string[] = [];
  const owner = createFixtureOperationOwner(async () => {
    await stateAction({
      action: "cleanup",
      memory_storage_id: memoryStorageId,
      org_id: orgId,
      user_id: userId,
      source_history_hashes: [...new Set(sourceHashes)],
      agent_session_ids: agentSessionIds,
    });
  });
  const ownerScope = {
    memory_storage_id: memoryStorageId,
    org_id: orgId,
    user_id: userId,
  } as const;

  async function seed(args: {
    readonly raw: Buffer;
    readonly encoding?: SessionHistoryEncoding;
    readonly piSessionId?: string;
    readonly sourceCompletedAt?: string;
    readonly retryCount?: number;
  }): Promise<CandidateFixture> {
    return await owner.run(async () => {
      const encoding = args.encoding ?? SESSION_HISTORY_ENCODING_IDENTITY;
      const piSessionId = args.piSessionId ?? randomUUID();
      const sourceHistoryHash = createHash("sha256")
        .update(args.raw)
        .digest("hex");
      const encoded = encodeHistory(args.raw, encoding);
      const seeded = await stateAction({
        action: "seed",
        ...ownerScope,
        pi_session_id: piSessionId,
        source_history_hash: sourceHistoryHash,
        source_completed_at:
          args.sourceCompletedAt ?? new Date(now() - 60_000).toISOString(),
        encoding,
        raw_size: args.raw.length,
        encoded_size: encoded.length,
        ...(args.retryCount === undefined
          ? {}
          : { retry_count: args.retryCount }),
      });
      if (!seeded.object_key) {
        throw new Error("Pi memory fixture returned no object key");
      }
      sourceHashes.push(sourceHistoryHash);
      context.sessionHistoryBlobs.set(seeded.object_key, encoded);
      return {
        ...ownerScope,
        pi_session_id: piSessionId,
        source_history_hash: sourceHistoryHash,
        objectKey: seeded.object_key,
      };
    });
  }

  async function action(
    body: WithoutOwner<TestPiMemoryStage1StateActionBody>,
    signal?: AbortSignal,
  ) {
    return await owner.run(async () => {
      return await stateAction(
        {
          ...body,
          ...ownerScope,
        } as TestPiMemoryStage1StateActionBody,
        signal,
      );
    });
  }

  async function createActive(fixture: CandidateFixture) {
    const result = await action({
      action: "create-active-run",
      pi_session_id: fixture.pi_session_id,
    });
    if (!result.run_id || !result.agent_session_id) {
      throw new Error("Pi memory fixture returned no active run identity");
    }
    agentSessionIds.push(result.agent_session_id);
    return result.run_id;
  }

  async function replace(
    fixture: CandidateFixture,
    raw: Buffer,
  ): Promise<CandidateFixture> {
    return await owner.run(async () => {
      const sourceHistoryHash = createHash("sha256").update(raw).digest("hex");
      const replaced = await stateAction({
        action: "replace",
        ...ownerScope,
        pi_session_id: fixture.pi_session_id,
        source_history_hash: sourceHistoryHash,
        source_completed_at: new Date(now() - 30_000).toISOString(),
        encoding: SESSION_HISTORY_ENCODING_IDENTITY,
        raw_size: raw.length,
        encoded_size: raw.length,
      });
      if (!replaced.object_key) {
        throw new Error("Pi memory replacement returned no object key");
      }
      sourceHashes.push(sourceHistoryHash);
      context.sessionHistoryBlobs.set(replaced.object_key, raw);
      return {
        ...ownerScope,
        pi_session_id: fixture.pi_session_id,
        source_history_hash: sourceHistoryHash,
        objectKey: replaced.object_key,
      };
    });
  }

  return { ...ownerScope, seed, action, createActive, replace };
}

async function inspect(fixture: CandidateFixture) {
  return (
    await stateAction({
      action: "inspect",
      ...fixture,
    })
  ).state;
}

async function runScoped(
  storage: ReturnType<typeof createStorageFixture>,
  piSessionId?: string,
  signal?: AbortSignal,
) {
  const result = await storage.action(
    {
      action: "run",
      ...(piSessionId ? { pi_session_id: piSessionId } : {}),
    },
    signal,
  );
  if (!result.worker) {
    throw new Error("Pi memory fixture returned no worker result");
  }
  return result.worker;
}

async function inspectUsage(storage: ReturnType<typeof createStorageFixture>) {
  return (await storage.action({ action: "inspect-usage" })).usage ?? [];
}

function stage1Headers(secret = CRON_SECRET) {
  return { authorization: `Bearer ${secret}` };
}

function stage1Client(storage: ReturnType<typeof createStorageFixture>) {
  return setupApp({
    context,
    routes: cronExtractPiMemoryStage1RoutesForTest({
      memoryStorageId: storage.memory_storage_id,
    }),
  })(cronExtractPiMemoryStage1Contract);
}

beforeEach(async () => {
  mockEnv("R2_USER_STORAGES_BUCKET_NAME", BUCKET);
  mockEnv("CRON_SECRET", CRON_SECRET);
  context.sessionHistoryBlobs.clear();
  installS3Objects();
  await seedBuiltInModelKey(context, "gpt-5.6-terra");
});

describe("Pi memory Stage 1 worker", () => {
  it("authenticates the production cron route before the disabled breaker", async () => {
    mockEnv("PI_MEMORY_BACKGROUND_WORKERS_ENABLED", "false");
    const provider = installProvider();
    context.mocks.s3.send.mockClear();
    const response = await accept(
      setupApp({ context, routes: cronExtractPiMemoryStage1Routes })(
        cronExtractPiMemoryStage1Contract,
      ).extract({ headers: stage1Headers("invalid-secret") }),
      [401],
    );
    expect(response.status).toBe(401);
    expect(provider.calls).toHaveLength(0);
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
  });

  it("returns all-zero counters without touching pending work when disabled", async () => {
    const storage = createStorageFixture();
    const fixture = await storage.seed({
      raw: settledHistory(randomUUID(), INPUT_SECRET),
    });
    const provider = installProvider();
    mockEnv("PI_MEMORY_BACKGROUND_WORKERS_ENABLED", "false");
    context.mocks.s3.send.mockClear();

    const response = await accept(
      stage1Client(storage).extract({ headers: stage1Headers() }),
      [200],
    );

    expect(response.body).toStrictEqual({
      success: true,
      scanned: 0,
      claimed: 0,
      succeeded: 0,
      succeededNoOutput: 0,
      retryableFailure: 0,
      terminalFailure: 0,
      sourceExpired: 0,
      sourceActive: 0,
      staleDiscarded: 0,
    });
    await expect(inspect(fixture)).resolves.toMatchObject({
      status: "pending",
    });
    await expect(inspectUsage(storage)).resolves.toStrictEqual([]);
    expect(provider.calls).toHaveLength(0);
    expect(context.mocks.s3.send).not.toHaveBeenCalled();

    const captured = JSON.stringify(response.body);
    expect(captured).not.toContain(INPUT_SECRET);
    expect(captured).not.toContain(fixture.objectKey);
    expect(captured).not.toContain(CRON_SECRET);
  });

  it("preserves Stage 1 route counters and results when enabled by default", async () => {
    const storage = createStorageFixture();
    const piSessionId = randomUUID();
    const fixture = await storage.seed({
      piSessionId,
      raw: settledHistory(piSessionId, "perform bounded memory extraction"),
    });
    const provider = installProvider();

    const response = await accept(
      stage1Client(storage).extract({ headers: stage1Headers() }),
      [200],
    );

    expect(response.body).toStrictEqual({
      success: true,
      scanned: 1,
      claimed: 1,
      succeeded: 1,
      succeededNoOutput: 0,
      retryableFailure: 0,
      terminalFailure: 0,
      sourceExpired: 0,
      sourceActive: 0,
      staleDiscarded: 0,
    });
    expect(provider.calls).toHaveLength(1);
    await expect(inspect(fixture)).resolves.toMatchObject({
      status: "succeeded",
    });
  });

  it("decodes every encoding, redacts both boundaries, and records background usage", async () => {
    const storage = createStorageFixture();
    const fixtures: CandidateFixture[] = [];
    for (const encoding of [
      SESSION_HISTORY_ENCODING_IDENTITY,
      SESSION_HISTORY_ENCODING_GZIP,
      SESSION_HISTORY_ENCODING_ZSTD,
    ] as const) {
      const piSessionId = randomUUID();
      fixtures.push(
        await storage.seed({
          piSessionId,
          raw: settledHistory(
            piSessionId,
            `perform durable work with ${INPUT_SECRET}`,
          ),
          encoding,
        }),
      );
    }
    const provider = installProvider();

    await expect(runScoped(storage)).resolves.toMatchObject({
      scanned: 3,
      claimed: 3,
      succeeded: 3,
      retryableFailure: 0,
      terminalFailure: 0,
    });
    expect(provider.calls).toHaveLength(3);
    for (const invocation of provider.calls) {
      const serialized = JSON.stringify(invocation.request);
      expect(serialized).not.toContain(INPUT_SECRET);
      expect(serialized).not.toContain(fixtures[0]?.pi_session_id);
      expect(invocation.request).toMatchObject({
        model: "gpt-5.6-terra",
        reasoning: { effort: "max" },
        text: {
          format: {
            type: "json_schema",
            strict: true,
            schema: { additionalProperties: false },
          },
        },
      });
      expect(invocation.request).not.toHaveProperty("tools");
    }
    for (const fixture of fixtures) {
      await expect(inspect(fixture)).resolves.toMatchObject({
        status: "succeeded",
        raw_memory: "safe surrounding text [REDACTED_SECRET]",
        rollout_summary: "Authorization: [REDACTED_SECRET]",
        rollout_slug: "pi-stage1-result",
      });
    }
    const usage = await inspectUsage(storage);
    expect(usage.length).toBeGreaterThanOrEqual(9);
    expect(usage).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          run_id: null,
          provider: "gpt-5.6-terra",
          category: "tokens.input",
        }),
        expect.objectContaining({
          run_id: null,
          provider: "gpt-5.6-terra",
          category: "tokens.output",
        }),
      ]),
    );
    await expect(runScoped(storage)).resolves.toMatchObject({ claimed: 0 });
  });

  it("isolates malformed and cyclic sources permanently before the provider", async () => {
    if (await runInIsolatedProcess(import.meta.url)) {
      return;
    }
    const storage = createStorageFixture();
    const futureId = randomUUID();
    const wrongExpectedId = randomUUID();
    const unsettledId = randomUUID();
    const unsettled = MemoryPiSession.create({
      cwd: "/workspace",
      id: unsettledId,
    });
    unsettled.appendMessage({
      role: "user",
      content: "not settled",
      timestamp: 1,
    });
    const invalid = [
      await storage.seed({ raw: Buffer.from("{malformed\n", "utf8") }),
      await storage.seed({
        piSessionId: futureId,
        raw: Buffer.from(
          `${JSON.stringify({
            type: "session",
            version: 999,
            id: futureId,
            timestamp: "2026-09-02T00:00:00.000Z",
            cwd: "/workspace",
          })}\n`,
          "utf8",
        ),
      }),
      await storage.seed({
        piSessionId: wrongExpectedId,
        raw: settledHistory(randomUUID(), "wrong session"),
      }),
      await storage.seed({
        piSessionId: unsettledId,
        raw: Buffer.from(unsettled.toJsonl(), "utf8"),
      }),
    ];
    for (const duplicate of [false, true]) {
      const id = randomUUID();
      const history = settledHistory(id, "invalid graph candidate").toString(
        "utf8",
      );
      const record = JSON.stringify({
        type: "model_change",
        id: "graph-entry",
        parentId: duplicate ? null : "graph-entry",
        timestamp: "2026-09-05T00:00:00.000Z",
        provider: "openai",
        modelId: "gpt-5.6-terra",
      });
      invalid.push(
        await storage.seed({
          piSessionId: id,
          raw: Buffer.from(
            `${history}${record}\n${duplicate ? `${record}\n` : ""}`,
            "utf8",
          ),
        }),
      );
    }
    const validId = randomUUID();
    const valid = await storage.seed({
      piSessionId: validId,
      raw: settledHistory(validId, "valid isolated candidate"),
    });
    const provider = installProvider();

    await expect(runScoped(storage)).resolves.toMatchObject({
      claimed: 7,
      succeeded: 1,
      terminalFailure: 6,
    });
    expect(provider.calls).toHaveLength(1);
    for (const fixture of invalid) {
      await expect(inspect(fixture)).resolves.toMatchObject({
        status: "terminal_failure",
        last_error_class: "source_pi_session_invalid",
      });
    }
    await expect(inspect(valid)).resolves.toMatchObject({
      status: "succeeded",
    });
  }, 150_000);

  it("fences concurrent claims and stale workers while recording both provider usages", async () => {
    const storage = createStorageFixture();
    const piSessionId = randomUUID();
    const fixture = await storage.seed({
      piSessionId,
      raw: settledHistory(piSessionId, "lease fencing"),
    });
    const oldStarted = createDeferredPromise<void>(context.signal);
    const oldReleased = createDeferredPromise<void>(context.signal);
    installProvider(async ({ sequence }) => {
      if (sequence === 1) {
        oldStarted.resolve(undefined);
        await oldReleased.promise;
        return JSON.stringify({
          raw_memory: "old lease output",
          rollout_summary: "old lease summary",
          rollout_slug: "old-lease",
        });
      }
      return JSON.stringify({
        raw_memory: "new lease output",
        rollout_summary: "new lease summary",
        rollout_slug: "new-lease",
      });
    });

    const oldWorker = runScoped(storage, piSessionId);
    await oldStarted.promise;
    await expect(runScoped(storage, piSessionId)).resolves.toMatchObject({
      claimed: 0,
    });
    await storage.action({
      action: "expire-lease",
      pi_session_id: piSessionId,
    });
    await expect(runScoped(storage, piSessionId)).resolves.toMatchObject({
      claimed: 1,
      succeeded: 1,
    });
    oldReleased.resolve(undefined);
    await expect(oldWorker).resolves.toMatchObject({
      claimed: 1,
      staleDiscarded: 1,
    });
    await expect(inspect(fixture)).resolves.toMatchObject({
      status: "succeeded",
      retry_count: 1,
      raw_memory: "new lease output",
    });
    expect((await inspectUsage(storage)).length).toBeGreaterThanOrEqual(6);
  });

  it("keeps expired, active-session, and transient object outcomes deterministic", async () => {
    const storage = createStorageFixture();
    const expiredId = randomUUID();
    const expired = await storage.seed({
      piSessionId: expiredId,
      raw: settledHistory(expiredId, "expired"),
      sourceCompletedAt: new Date(
        now() - 31 * 24 * 60 * 60 * 1000,
      ).toISOString(),
    });
    const activeId = randomUUID();
    const active = await storage.seed({
      piSessionId: activeId,
      raw: settledHistory(activeId, "active"),
    });
    const activeRunId = await storage.createActive(active);
    const retryId = randomUUID();
    const retry = await storage.seed({
      piSessionId: retryId,
      raw: settledHistory(retryId, "transient"),
    });
    failNextObjectRead(retry.objectKey);
    const provider = installProvider();

    await expect(runScoped(storage)).resolves.toMatchObject({
      scanned: 3,
      claimed: 1,
      sourceExpired: 1,
      sourceActive: 1,
      retryableFailure: 1,
      terminalFailure: 1,
    });
    expect(provider.calls).toHaveLength(0);
    await expect(inspect(expired)).resolves.toMatchObject({
      status: "terminal_failure",
      last_error_class: "source_expired",
    });
    await expect(inspect(active)).resolves.toMatchObject({ status: "pending" });
    await expect(inspect(retry)).resolves.toMatchObject({
      status: "retryable_failure",
      retry_count: 1,
      last_error_class: "source_download_failed",
    });

    await stateAction({
      action: "complete-active-run",
      run_id: activeRunId,
    });
    await storage.action({ action: "make-retry-due", pi_session_id: retryId });
    await expect(runScoped(storage)).resolves.toMatchObject({
      claimed: 2,
      succeeded: 2,
    });
  });

  it("rejects an old worker after the exact source hash is replaced", async () => {
    const storage = createStorageFixture();
    const piSessionId = randomUUID();
    const original = await storage.seed({
      piSessionId,
      raw: settledHistory(piSessionId, "original generation"),
    });
    const oldStarted = createDeferredPromise<void>(context.signal);
    const oldReleased = createDeferredPromise<void>(context.signal);
    installProvider(async ({ sequence }) => {
      if (sequence === 1) {
        oldStarted.resolve(undefined);
        await oldReleased.promise;
        return JSON.stringify({
          raw_memory: "obsolete source output",
          rollout_summary: "obsolete source summary",
          rollout_slug: "obsolete-source",
        });
      }
      return JSON.stringify({
        raw_memory: "replacement source output",
        rollout_summary: "replacement source summary",
        rollout_slug: "replacement-source",
      });
    });

    const oldWorker = runScoped(storage, piSessionId);
    await oldStarted.promise;
    const replacement = await storage.replace(
      original,
      settledHistory(piSessionId, "replacement generation"),
    );
    await expect(runScoped(storage, piSessionId)).resolves.toMatchObject({
      claimed: 1,
      succeeded: 1,
    });
    oldReleased.resolve(undefined);
    await expect(oldWorker).resolves.toMatchObject({ staleDiscarded: 1 });
    await expect(inspect(replacement)).resolves.toMatchObject({
      status: "succeeded",
      raw_memory: "replacement source output",
    });
    expect((await inspectUsage(storage)).length).toBeGreaterThanOrEqual(6);
  });

  it("records consumed usage but cannot resurrect an owner deleted during provider work", async () => {
    const storage = createStorageFixture();
    const piSessionId = randomUUID();
    const fixture = await storage.seed({
      piSessionId,
      raw: settledHistory(piSessionId, "delete owner"),
    });
    const providerStarted = createDeferredPromise<void>(context.signal);
    const providerReleased = createDeferredPromise<void>(context.signal);
    installProvider(async () => {
      providerStarted.resolve(undefined);
      await providerReleased.promise;
      return defaultProviderOutput();
    });
    const worker = runScoped(storage, piSessionId);
    await providerStarted.promise;
    await storage.action({ action: "delete-owner" });
    providerReleased.resolve(undefined);
    await expect(worker).resolves.toMatchObject({ staleDiscarded: 1 });
    await expect(inspect(fixture)).resolves.toBeNull();
    await expect(inspectUsage(storage)).resolves.toStrictEqual(
      expect.arrayContaining([expect.objectContaining({ run_id: null })]),
    );
  });

  it("fails closed on a deterministic usage collision after provider consumption", async () => {
    const storage = createStorageFixture();
    const piSessionId = randomUUID();
    const fixture = await storage.seed({
      piSessionId,
      raw: settledHistory(piSessionId, "usage collision"),
    });
    await storage.action({
      action: "seed-usage-collision",
      pi_session_id: piSessionId,
      source_history_hash: fixture.source_history_hash,
      response_source_id: "resp_pi_memory_stage1_1",
    });
    const provider = installProvider();

    await expect(runScoped(storage, piSessionId)).resolves.toMatchObject({
      claimed: 1,
      retryableFailure: 1,
    });
    expect(provider.calls).toHaveLength(1);
    await expect(inspect(fixture)).resolves.toMatchObject({
      status: "retryable_failure",
      last_error_class: "usage_identity_collision",
    });
  });

  it("commits a valid empty response as succeeded without output", async () => {
    const storage = createStorageFixture();
    const piSessionId = randomUUID();
    const fixture = await storage.seed({
      piSessionId,
      raw: settledHistory(piSessionId, "no durable signal"),
    });
    installProvider(() => {
      return JSON.stringify({
        raw_memory: "",
        rollout_summary: "",
        rollout_slug: "",
      });
    });

    await expect(runScoped(storage, piSessionId)).resolves.toMatchObject({
      claimed: 1,
      succeededNoOutput: 1,
    });
    await expect(inspect(fixture)).resolves.toMatchObject({
      status: "succeeded_no_output",
      raw_memory: null,
      rollout_summary: null,
      rollout_slug: null,
    });
  });

  it("redacts an unsafe secret-bearing slug before retry", async () => {
    const storage = createStorageFixture();
    const piSessionId = randomUUID();
    const fixture = await storage.seed({
      piSessionId,
      raw: settledHistory(piSessionId, "secret slug"),
    });
    installProvider(() => {
      return JSON.stringify({
        raw_memory: "safe memory",
        rollout_summary: "safe summary",
        rollout_slug: `slug-${OUTPUT_SECRET}`,
      });
    });

    await expect(runScoped(storage, piSessionId)).resolves.toMatchObject({
      claimed: 1,
      retryableFailure: 1,
    });
    await expect(inspect(fixture)).resolves.toMatchObject({
      status: "retryable_failure",
      last_error_class: "provider_output_invalid",
      rollout_slug: null,
    });
  });

  it("retries exactly owned work when cancellation interrupts the provider", async () => {
    const storage = createStorageFixture();
    const piSessionId = randomUUID();
    const fixture = await storage.seed({
      piSessionId,
      raw: settledHistory(piSessionId, "cancel provider"),
    });
    const providerStarted = createDeferredPromise<void>(context.signal);
    const providerReleased = createDeferredPromise<void>(context.signal);
    installProvider(async () => {
      providerStarted.resolve(undefined);
      await providerReleased.promise;
      return defaultProviderOutput();
    });
    const controller = new AbortController();
    const running = runScoped(storage, piSessionId, controller.signal);
    await providerStarted.promise;
    controller.abort();
    providerReleased.resolve(undefined);

    await expect(running).rejects.toBeInstanceOf(Error);
    await expect(inspect(fixture)).resolves.toMatchObject({
      status: "retryable_failure",
      retry_count: 1,
    });
  });

  it("claims at most eight candidates and starts at most eight providers", async () => {
    const storage = createStorageFixture();
    for (let index = 0; index < 9; index += 1) {
      const piSessionId = randomUUID();
      await storage.seed({
        piSessionId,
        raw: settledHistory(piSessionId, `bounded candidate ${index}`),
      });
    }
    const allStarted = createDeferredPromise<void>(context.signal);
    const released = createDeferredPromise<void>(context.signal);
    let active = 0;
    let maxActive = 0;
    const provider = installProvider(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (active === 8) {
        allStarted.resolve(undefined);
      }
      await released.promise;
      active -= 1;
      return defaultProviderOutput();
    });

    const first = runScoped(storage);
    await allStarted.promise;
    expect(provider.calls).toHaveLength(8);
    expect(maxActive).toBe(8);
    released.resolve(undefined);
    await expect(first).resolves.toMatchObject({ claimed: 8, succeeded: 8 });
    await expect(runScoped(storage)).resolves.toMatchObject({
      claimed: 1,
      succeeded: 1,
    });
    expect(provider.calls).toHaveLength(9);
  });

  it("terminates invalid structured output at the named maximum attempt", async () => {
    const storage = createStorageFixture();
    const piSessionId = randomUUID();
    const fixture = await storage.seed({
      piSessionId,
      raw: settledHistory(piSessionId, "bounded attempts"),
      retryCount: 4,
    });
    installProvider(() => {
      return '{"raw_memory":"unknown extra","extra":true}';
    });

    await expect(runScoped(storage, piSessionId)).resolves.toMatchObject({
      claimed: 1,
      terminalFailure: 1,
    });
    await expect(inspect(fixture)).resolves.toMatchObject({
      status: "terminal_failure",
      last_error_class: "attempts_exhausted",
      raw_memory: null,
      rollout_summary: null,
    });
  });
});
