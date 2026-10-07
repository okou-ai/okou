import { observePublicUsage } from "./helpers/public-usage-observation";
import { createPublicPiMemorySource } from "./helpers/public-pi-memory-source";
import { mockStage1CostLogFailure } from "../../../__tests__/mocks";
import {
  builtinMemoryQuotaCases,
  seedMemoryQuotaCase,
} from "../../../test-fixtures/pi-memory-builtin-quota";
import { nativeMemoryQuotaCases } from "../../../test-fixtures/pi-memory-quota";
import { seedOrgMetadata } from "../../../test-fixtures/system-config-seeds";
import { setBuiltInRouteLongContextThresholdFixture } from "../../../test-fixtures/model-catalog";

import { personalModelProviderAccountsByIdContract } from "@okouai/api-contracts/contracts/personal-model-providers";

import { meModelProviderAccountRoutes } from "../me-model-provider-accounts";
import { createRouteMocks } from "./helpers/route-test";
import { createBddApi } from "./helpers/api-bdd";
import {
  createRunsApi,
  expectCanonicalStorageManifest,
} from "./helpers/api-bdd-runs";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import { makeCodexAuthJson, makeCodexJwt } from "./helpers/api-bdd-auth-device";
import { createHash, randomUUID } from "node:crypto";
import { gzipSync, zstdCompressSync, zstdDecompressSync } from "node:zlib";

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

import { PI_MEMORY_STAGE1_RESPONSE_SCHEMA } from "@okouai/pi-agent-runtime/api";
import { encode } from "gpt-tokenizer/encoding/o200k_base";
import { cronExtractPiMemoryStage1Contract } from "@okouai/api-contracts/contracts/cron";
import {
  SESSION_HISTORY_ENCODING_GZIP,
  SESSION_HISTORY_ENCODING_IDENTITY,
  SESSION_HISTORY_ENCODING_ZSTD,
} from "@okouai/api-contracts/contracts/runners";
import { MemoryPiSession } from "@okouai/pi-agent-runtime/node";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { env, mockEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { seedBuiltInModelKey } from "./helpers/runtime-state";
import {
  deleteFeatureSwitchesForUser,
  updateFeatureSwitchesForUser,
} from "./helpers/feature-switches";
import { createFixtureOperationOwner } from "./helpers/fixture-operation-owner";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
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

const context = testContext();
const BUCKET = "test-user-storages";
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
  readonly body: string;
  readonly url: string;
  readonly headers: Headers;
}

interface ProviderUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cached_tokens: number;
  readonly cache_write_tokens: number;
}

interface ProviderReply {
  readonly text: string;
  readonly usage?: ProviderUsage;
  readonly incomplete?: boolean;
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

function responsesSse(
  text: string,
  sequence: number,
  usage: ProviderUsage = {
    input_tokens: 12,
    output_tokens: 8,
    cached_tokens: 2,
    cache_write_tokens: 3,
  },
  incomplete = false,
): string {
  const responseId = `resp_pi_memory_stage1_${sequence.toString()}`;
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
      type: incomplete ? "response.incomplete" : "response.completed",
      response: {
        id: responseId,
        object: "response",
        status: incomplete ? "incomplete" : "completed",
        ...(incomplete
          ? { incomplete_details: { reason: "max_output_tokens" } }
          : {}),
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
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          input_tokens_details: {
            cached_tokens: usage.cached_tokens,
            cache_write_tokens: usage.cache_write_tokens,
          },
          total_tokens: usage.input_tokens + usage.output_tokens,
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
  ) =>
    | Promise<string | ProviderReply>
    | string
    | ProviderReply = defaultProviderOutput,
) {
  let sequence = 0;
  const calls: ProviderInvocation[] = [];
  server.use(
    http.post(
      /https:\/\/(?:(?:us\.)?openrouter\.ai|chatgpt\.com)\/(?:.*\/)?responses/u,
      async ({ request }) => {
        sequence += 1;
        const body = (
          request.headers.get("content-encoding") === "zstd"
            ? zstdDecompressSync(Buffer.from(await request.arrayBuffer()))
            : Buffer.from(await request.arrayBuffer())
        ).toString("utf8");
        const invocation = {
          sequence,
          url: request.url,
          headers: request.headers,
          body,
          request: JSON.parse(body) as unknown,
        };
        calls.push(invocation);
        const reply = await responder(invocation);
        const { text, usage, incomplete } =
          typeof reply === "string"
            ? { text: reply, usage: undefined, incomplete: false }
            : reply;
        return new HttpResponse(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  responsesSse(text, invocation.sequence, usage, incomplete),
                ),
              );
              controller.close();
            },
          }),
          {
            headers: { "content-type": "text/event-stream" },
          },
        );
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
    model: "gpt-6-luna",
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

function createStorageFixture(
  options: { readonly piMemoryEnabled?: boolean } = {},
) {
  const memoryStorageId = randomUUID();
  const orgId = `org_pi_stage1_${randomUUID()}`;
  const userId = `user_pi_stage1_${randomUUID()}`;
  // PiMemory is off for everyone by default; Stage 1 work only runs for
  // owners whose explicit override enables it.
  const piMemoryEnabled = options.piMemoryEnabled ?? true;
  const sourceHashes: string[] = [];
  const owner = createFixtureOperationOwner(async () => {
    await stateAction({
      action: "cleanup",
      memory_storage_id: memoryStorageId,
      org_id: orgId,
      user_id: userId,
      source_history_hashes: [...new Set(sourceHashes)],
      agent_session_ids: [],
    });
    if (piMemoryEnabled) {
      await deleteFeatureSwitchesForUser(context, { orgId, userId });
    }
  });
  const ownerScope = {
    memory_storage_id: memoryStorageId,
    org_id: orgId,
    user_id: userId,
  } as const;
  let ownerSwitches: Promise<void> | undefined;
  let admissionSetup: Promise<void> | undefined;

  function enableOwnerPiMemory(): Promise<void> {
    ownerSwitches ??= updateFeatureSwitchesForUser(
      context,
      { orgId, userId },
      { [FeatureSwitchKey.PiMemory]: true },
    );
    return ownerSwitches;
  }

  async function seed(args: {
    readonly raw: Buffer;
    readonly encoding?: SessionHistoryEncoding;
    readonly piSessionId?: string;
    readonly sourceCompletedAt?: string;
    readonly retryCount?: number;
    readonly source?: Extract<
      TestPiMemoryStage1StateActionBody,
      { action: "seed" }
    >["source"];
  }): Promise<CandidateFixture> {
    return await owner.run(async () => {
      // Runless background attempts obey the same source plan/credit admission.
      admissionSetup ??= seedOrgMetadata({
        orgId,
        tier: "pro",
        credits: 100_000,
      });
      await admissionSetup;
      if (piMemoryEnabled) {
        await enableOwnerPiMemory();
      }
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
          args.sourceCompletedAt ??
          new Date(now() - 7 * 3_600_000).toISOString(),
        encoding,
        raw_size: args.raw.length,
        encoded_size: encoded.length,
        ...(args.source ? { source: args.source } : {}),
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

  return { ...ownerScope, seed, action, replace };
}

interface ScopedStage1Fixture {
  readonly memory_storage_id: string;
  readonly action: ReturnType<typeof createStorageFixture>["action"];
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
  storage: ScopedStage1Fixture,
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

async function inspectUsage(storage: ScopedStage1Fixture) {
  return (await storage.action({ action: "inspect-usage" })).usage ?? [];
}

async function inspectUsageCategories(
  storage: ScopedStage1Fixture,
): Promise<string[]> {
  const usage = await inspectUsage(storage);
  for (const row of usage) {
    expect(row).toMatchObject({
      run_id: null,
      provider: "deepseek-v4.1-flash",
    });
  }
  return usage
    .map((row) => {
      return row.category;
    })
    .sort();
}

function stage1Headers(secret = CRON_SECRET) {
  return { authorization: `Bearer ${secret}` };
}

function stage1Client(storages: readonly ScopedStage1Fixture[]) {
  return setupApp({
    context,
    routes: cronExtractPiMemoryStage1RoutesForTest({
      memoryStorageIds: storages.map((storage) => {
        return storage.memory_storage_id;
      }),
    }),
  })(cronExtractPiMemoryStage1Contract);
}

beforeEach(async () => {
  mockEnv("PI_MEMORY_BACKGROUND_WORKERS_ENABLED", "true");
  mockEnv("R2_USER_STORAGES_BUCKET_NAME", BUCKET);
  mockEnv("CRON_SECRET", CRON_SECRET);
  context.sessionHistoryBlobs.clear();
  installS3Objects();
  // Auto and independent memory share the managed OpenRouter key, not chat routes.
  await seedBuiltInModelKey(context, "okou-1.0");
});

describe("Pi memory Stage 1 worker", () => {
  // #37440 key33 retains only scoped accounting, redaction and worker fences.
  // Ordinary sources are completed native Pi Runs, selected by the real day producer.
  let publicSourceTime: number;
  async function createPublicStorageFixture() {
    const chat = createChatEventsFixture(context);
    const { actor, agentId, runnerGroup } = await chat.entitledChatActor();
    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("Expected an owned organization");
    }
    const sourceHashes: string[] = [];
    const runs: {
      runId: string;
      piSessionId?: string;
      sandboxToken?: string;
    }[] = [];
    let memoryStorageId: string | undefined;
    const storageTransport = context.mocks.s3.send.getMockImplementation();
    const presign = context.mocks.s3.getSignedUrl.getMockImplementation();
    const kmsKeyId = env("SECRETS_KMS_KEY_ID");

    function restoreTransport() {
      mockEnv("SECRETS_KMS_KEY_ID", kmsKeyId);
      mockEnv("R2_USER_STORAGES_BUCKET_NAME", BUCKET);
      context.mocks.ably.publish.mockResolvedValue(undefined);
      if (storageTransport) {
        context.mocks.s3.send.mockImplementation(storageTransport);
      }
      if (presign) {
        context.mocks.s3.getSignedUrl.mockImplementation(presign);
      }
    }
    const owner = createFixtureOperationOwner(async () => {
      restoreTransport();
      const api = createRunsApi(context);
      api.acceptTelemetryIngest();
      for (const run of runs) {
        const current = await api.readRun(actor, run.runId);
        if (current.status === "pending" || current.status === "running") {
          await api.requestCancelRun(actor, run.runId, [200]);
        }
        if (
          run.sandboxToken &&
          ["pending", "running", "cancelled"].includes(current.status)
        ) {
          await createWebhookCallbackApi(context).requestAgentComplete(
            {
              runId: run.runId,
              exitCode: 1,
              error: "Owned Stage 1 carrier cancelled",
            },
            { authorization: `Bearer ${run.sandboxToken}` },
            [200],
          );
        }
      }
      await flushWaitUntilForTest();
      await createBddApi(context).deleteAgent(actor, agentId);
      await flushWaitUntilForTest();
      if (memoryStorageId) {
        await stateAction({
          action: "cleanup",
          memory_storage_id: memoryStorageId,
          org_id: orgId,
          user_id: actor.userId,
          source_history_hashes: sourceHashes,
          agent_session_ids: [],
        });
      }
      await deleteFeatureSwitchesForUser(context, {
        orgId,
        userId: actor.userId,
      });
    });
    await updateFeatureSwitchesForUser(
      context,
      { orgId, userId: actor.userId },
      { [FeatureSwitchKey.PiMemory]: true },
    );
    await chat.configureBuiltInPiModel(actor, "okou-1.0");

    function scope() {
      if (!memoryStorageId || !orgId) {
        throw new Error("Expected a claimed memory mount");
      }
      return {
        memory_storage_id: memoryStorageId,
        org_id: orgId,
        user_id: actor.userId,
      };
    }
    async function seed(args: {
      readonly raw: (sessionId: string) => Buffer;
      readonly encoding?: SessionHistoryEncoding;
    }): Promise<CandidateFixture> {
      return await owner.run(async () => {
        restoreTransport();
        const run = await chat.sendChatRun(actor, {
          agentId,
          prompt: "Produce owned Stage 1 history",
          model: "okou-1.0",
        });
        const owned: (typeof runs)[number] = {
          runId: run.runId,
          piSessionId: run.threadId,
        };
        runs.push(owned);
        const claimed = await chat.claimChatRun(runnerGroup, run.runId);
        owned.sandboxToken = claimed.claim.sandboxToken;
        expect(claimed.claim.cliAgentType).toBe("pi");
        expect(claimed.claim.piSessionId).toBe(run.threadId);
        const manifest = expectCanonicalStorageManifest(
          claimed.claim.storageManifest,
        );
        const mount = manifest?.storageMounts.find((entry) => {
          return entry.name === "memory" && entry.storageId;
        });
        if (!mount) {
          throw new Error("Expected the source Run's writable memory mount");
        }
        memoryStorageId = mount.storageId;
        const raw = args.raw(run.threadId);
        const encoding = args.encoding ?? SESSION_HISTORY_ENCODING_IDENTITY;
        const encoded = encodeHistory(raw, encoding);
        const hash = createHash("sha256").update(raw).digest("hex");
        sourceHashes.push(hash);
        let objectKey: string | undefined;
        context.mocks.s3.getSignedUrl.mockImplementation((_client, command) => {
          if (command instanceof PutObjectCommand) {
            objectKey = requiredObjectKey(command.input.Key);
          }
          return Promise.resolve("https://r2.example.com/stage1-history");
        });
        await chat.webhooks.requestAgentCheckpointPrepareHistory(
          {
            runId: run.runId,
            hash,
            rawSize: raw.length,
            encodedSize: encoded.length,
            encoding,
          },
          claimed.sandboxHeaders,
          [200],
        );
        const key = requiredObjectKey(objectKey);
        context.sessionHistoryBlobs.set(key, encoded);
        installS3Objects();
        await chat.webhooks.requestAgentEvents(
          {
            runId: run.runId,
            events: [
              {
                type: "assistant",
                sequenceNumber: 1,
                message: {
                  content: [{ type: "text", text: "completed safely" }],
                },
              },
              { type: "result", sequenceNumber: 2, result: "completed safely" },
            ],
          },
          claimed.sandboxHeaders,
          [200],
        );
        await chat.webhooks.requestAgentComplete(
          {
            runId: run.runId,
            exitCode: 0,
            lastEventSequence: 2,
            checkpoint: {
              cliAgentType: "pi",
              cliAgentSessionId: run.threadId,
              cliAgentSessionHistoryHash: hash,
            },
          },
          claimed.sandboxHeaders,
          [200],
        );
        await flushWaitUntilForTest();
        expect((await chat.api.readRun(actor, run.runId)).status).toBe(
          "completed",
        );
        return {
          ...scope(),
          pi_session_id: run.threadId,
          source_history_hash: hash,
          objectKey: key,
        };
      });
    }
    async function prepareExecution(
      executionTime = publicSourceTime + 24 * 3_600_000,
    ) {
      return await owner.run(async () => {
        // Both owners publish before this common later UTC day in the two-owner cases.
        mockNow(new Date(executionTime));
        restoreTransport();
        const trigger = await chat.sendChatRun(actor, {
          agentId,
          prompt: "Request the next owned memory day",
          model: "okou-1.0",
        });
        runs.push({ runId: trigger.runId });
        await chat.api.requestCancelRun(actor, trigger.runId, [200]);
        await flushWaitUntilForTest();
        installS3Objects();
      });
    }
    function sourceRun(fixture: CandidateFixture) {
      const owned = runs.find((run) => {
        return run.piSessionId === fixture.pi_session_id;
      });
      if (!owned?.sandboxToken) {
        throw new Error("Expected the actually claimed public source Run");
      }
      return { runId: owned.runId, sandboxToken: owned.sandboxToken };
    }
    async function seedLegacyPendingCandidate(fixture: CandidateFixture) {
      return await owner.run(async () => {
        const run = sourceRun(fixture);
        await stateAction({
          action: "seed-legacy-pending-candidate",
          ...scope(),
          pi_session_id: fixture.pi_session_id,
          source_run_id: run.runId,
          source_history_hash: fixture.source_history_hash,
        });
      });
    }
    async function replacePublishedHistoryWithInvalidInput(
      fixture: CandidateFixture,
      raw: Buffer,
    ): Promise<CandidateFixture> {
      return await owner.run(async () => {
        const run = sourceRun(fixture);
        const hash = createHash("sha256").update(raw).digest("hex");
        const originalTransport = context.mocks.s3.send.getMockImplementation();
        const originalPresign =
          context.mocks.s3.getSignedUrl.getMockImplementation();
        if (!originalTransport || !originalPresign) {
          throw new Error("Expected the public history object transport");
        }
        let objectKey: string | undefined;
        context.mocks.s3.send.mockImplementation((value: unknown) => {
          if (value instanceof HeadObjectCommand) {
            const key = requiredObjectKey(value.input.Key);
            const body = context.sessionHistoryBlobs.get(key);
            if (!body) {
              return Promise.reject(
                Object.assign(
                  new Error("Missing owned session history object"),
                  {
                    name: "NotFound",
                    $metadata: { httpStatusCode: 404 },
                  },
                ),
              );
            }
            objectKey = key;
            return Promise.resolve({ ContentLength: body.length });
          }
          return originalTransport(value);
        });
        context.mocks.s3.getSignedUrl.mockImplementation((_client, command) => {
          if (command instanceof PutObjectCommand) {
            objectKey = requiredObjectKey(command.input.Key);
          }
          return Promise.resolve("https://r2.example.com/stage1-history");
        });
        const prepared = await settleIncludingAbort(
          (async () => {
            // The real completed Run can prepare metadata, but cannot publish an
            // invalid Pi checkpoint. Only that exact pointer is a key33 input.
            await chat.webhooks.requestAgentCheckpointPrepareHistory(
              {
                runId: run.runId,
                hash,
                rawSize: raw.length,
                encodedSize: raw.length,
                encoding: SESSION_HISTORY_ENCODING_IDENTITY,
              },
              { authorization: `Bearer ${run.sandboxToken}` },
              [200],
            );
            const key = requiredObjectKey(objectKey);
            context.sessionHistoryBlobs.set(key, raw);
            await stateAction({
              action: "replace-published-history-reference",
              ...scope(),
              pi_session_id: fixture.pi_session_id,
              source_run_id: run.runId,
              expected_source_history_hash: fixture.source_history_hash,
              source_history_hash: hash,
            });
            // Static bad hashes can be shared. Public Agent/candidate deletion
            // releases their references; leave zero-ref metadata for normal GC.
            return { ...fixture, source_history_hash: hash, objectKey: key };
          })(),
        );
        context.mocks.s3.send.mockImplementation(originalTransport);
        context.mocks.s3.getSignedUrl.mockImplementation(originalPresign);
        if (!prepared.ok) {
          throw prepared.error;
        }
        return prepared.value;
      });
    }
    async function replace(
      fixture: CandidateFixture,
      raw: Buffer,
    ): Promise<CandidateFixture> {
      return await owner.run(async () => {
        const sourceHistoryHash = createHash("sha256")
          .update(raw)
          .digest("hex");
        sourceHashes.push(sourceHistoryHash);
        const replaced = await stateAction({
          action: "replace",
          ...scope(),
          pi_session_id: fixture.pi_session_id,
          source_history_hash: sourceHistoryHash,
          source_completed_at: new Date(now() - 30_000).toISOString(),
          encoding: SESSION_HISTORY_ENCODING_IDENTITY,
          raw_size: raw.length,
          encoded_size: raw.length,
        });
        const key = requiredObjectKey(replaced.object_key);
        context.sessionHistoryBlobs.set(key, raw);
        return {
          ...scope(),
          pi_session_id: fixture.pi_session_id,
          source_history_hash: sourceHistoryHash,
          objectKey: key,
        };
      });
    }
    async function action(
      body: WithoutOwner<TestPiMemoryStage1StateActionBody>,
      signal?: AbortSignal,
    ) {
      return await owner.run(async () => {
        return await stateAction(
          { ...body, ...scope() } as TestPiMemoryStage1StateActionBody,
          signal,
        );
      });
    }
    async function createActive(fixture: CandidateFixture) {
      return await owner.run(async () => {
        // The pending continuation fences the source; claiming would read the held history.
        const active = await chat.sendChatRun(actor, {
          agentId,
          threadId: fixture.pi_session_id,
          prompt: "Continue the source while its worker download is held",
          model: "okou-1.0",
        });
        runs.push({ runId: active.runId });
        expect((await chat.api.readRun(actor, active.runId)).status).toBe(
          "pending",
        );
        return active.runId;
      });
    }
    return {
      get memory_storage_id() {
        return scope().memory_storage_id;
      },
      actor,
      seed,
      prepareExecution,
      seedLegacyPendingCandidate,
      replacePublishedHistoryWithInvalidInput,
      replace,
      action,
      createActive,
    };
  }

  beforeEach(() => {
    publicSourceTime = now();
  });

  it("retains provider consumption from an incomplete terminal response", async () => {
    const storage = await createPublicStorageFixture();
    await storage.seed({
      raw: (piSessionId) => {
        return settledHistory(piSessionId, "paid incomplete response");
      },
    });
    await storage.prepareExecution();
    const provider = installProvider(() => {
      return { text: "partial", incomplete: true };
    });
    await expect(runScoped(storage)).resolves.toMatchObject({
      claimed: 1,
      succeeded: 0,
    });
    expect(provider.calls).toHaveLength(1);
    await expect(inspectUsage(storage)).resolves.toHaveLength(4);
  });

  it("keeps a completed extraction and its usage when the cost logger throws", async () => {
    const storage = await createPublicStorageFixture();
    await storage.seed({
      raw: (piSessionId) => {
        return settledHistory(piSessionId, "cost transport failure");
      },
    });
    await storage.prepareExecution();
    mockStage1CostLogFailure();
    const provider = installProvider();
    await expect(runScoped(storage)).resolves.toMatchObject({
      succeeded: 1,
      retryableFailure: 0,
    });
    await expect(inspectUsage(storage)).resolves.toHaveLength(4);
    await expect(runScoped(storage)).resolves.toMatchObject({ claimed: 0 });
    expect(provider.calls).toHaveLength(1);
  });

  it("leaves switch-off legacy work unclaimed before any download or provider call", async () => {
    const enabledStorage = await createPublicStorageFixture();
    const disabledStorage = await createPublicStorageFixture();
    await enabledStorage.seed({
      raw: (piSessionId) => {
        return settledHistory(piSessionId, "enabled owner keeps learning");
      },
    });
    const disabled = await disabledStorage.seed({
      raw: (piSessionId) => {
        return settledHistory(
          piSessionId,
          "disabled owner never reaches the provider",
        );
      },
    });
    await updateFeatureSwitchesForUser(
      context,
      {
        orgId: disabled.org_id,
        userId: disabled.user_id,
      },
      { [FeatureSwitchKey.PiMemory]: false },
    );
    // Only this unscheduled legacy candidate (including input retryCount2)
    // needs key33; the owner and completed source were constructed publicly.
    await disabledStorage.seedLegacyPendingCandidate(disabled);
    await enabledStorage.prepareExecution();
    const workerObjectCallStart = context.mocks.s3.send.mock.calls.length;
    const provider = installProvider();

    const result = await accept(
      stage1Client([enabledStorage, disabledStorage]).extract({
        headers: stage1Headers(),
      }),
      [200],
    );

    expect(result.body).toMatchObject({
      success: true,
      scanned: 1,
      claimed: 1,
      succeeded: 1,
      succeededNoOutput: 0,
      retryableFailure: 0,
      terminalFailure: 0,
      staleDiscarded: 0,
    });
    expect(provider.calls).toHaveLength(1);
    const providerRequest = JSON.stringify(provider.calls[0]?.request);
    expect(providerRequest).toContain("enabled owner keeps learning");
    expect(providerRequest).not.toContain("disabled owner");
    expect(
      context.mocks.s3.send.mock.calls
        .slice(workerObjectCallStart)
        .some(([command]) => {
          return (
            command instanceof GetObjectCommand &&
            command.input.Key === disabled.objectKey
          );
        }),
    ).toBeFalsy();
    await expect(inspectUsage(disabledStorage)).resolves.toStrictEqual([]);

    // A settled switch-off candidate is not due again on the next tick.
    await expect(runScoped(disabledStorage)).resolves.toMatchObject({
      scanned: 0,
      claimed: 0,
      terminalFailure: 0,
    });
    expect(provider.calls).toHaveLength(1);
  });

  it("extracts built-in memory through its fixed internal OpenRouter binding", async () => {
    // The maintenance binding is independent of Auto-only chat candidates.
    const selectedModel = "deepseek-v4.1-flash";
    await seedBuiltInModelKey(context, selectedModel);
    const storage = await createPublicStorageFixture();
    const chatModels = await createMiscRoutesApi(context).listRunModels(
      storage.actor,
    );
    expect(chatModels.defaultModel).toBe("okou-1.0");
    expect(chatModels.models).not.toContainEqual(
      expect.objectContaining({ model: selectedModel }),
    );
    await storage.seed({
      raw: (piSessionId) => {
        return settledHistory(piSessionId, "secondary built-in candidate");
      },
    });
    await storage.prepareExecution();
    const provider = installProvider();
    await expect(runScoped(storage)).resolves.toMatchObject({
      scanned: 1,
      claimed: 1,
      succeeded: 1,
      retryableFailure: 0,
      terminalFailure: 0,
    });
    expect(provider.calls).toHaveLength(1);
    const call = provider.calls[0];
    expect(call?.url).toBe("https://openrouter.ai/api/v1/responses");
    expect(call?.request).toMatchObject({
      model: "deepseek/deepseek-v4.1-flash",
      reasoning: { effort: "low" },
    });
    expect(JSON.stringify(call?.request)).toContain(
      "secondary built-in candidate",
    );
    // The route bills the built-in owner on base categories.
    await expect(inspectUsageCategories(storage)).resolves.toStrictEqual([
      "tokens.cache_creation",
      "tokens.cache_read",
      "tokens.input",
      "tokens.output",
    ]);
  });
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

  it("returns all-zero counters without downloading sources when disabled", async () => {
    const storage = await createPublicStorageFixture();
    const fixture = await storage.seed({
      raw: (piSessionId) => {
        return settledHistory(piSessionId, INPUT_SECRET);
      },
    });
    await storage.prepareExecution();
    const provider = installProvider();
    mockEnv("PI_MEMORY_BACKGROUND_WORKERS_ENABLED", "false");
    context.mocks.s3.send.mockClear();

    const response = await accept(
      stage1Client([storage]).extract({ headers: stage1Headers() }),
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
    await expect(inspectUsage(storage)).resolves.toStrictEqual([]);
    expect(provider.calls).toHaveLength(0);
    expect(context.mocks.s3.send).not.toHaveBeenCalled();

    const captured = JSON.stringify(response.body);
    expect(captured).not.toContain(INPUT_SECRET);
    expect(captured).not.toContain(fixture.objectKey);
    expect(captured).not.toContain(CRON_SECRET);
  });

  it("preserves Stage 1 route counters and results when explicitly enabled", async () => {
    const storage = await createPublicStorageFixture();
    await storage.seed({
      raw: (piSessionId) => {
        return settledHistory(piSessionId, "perform bounded memory extraction");
      },
    });
    await storage.prepareExecution();
    const provider = installProvider();

    const response = await accept(
      stage1Client([storage]).extract({ headers: stage1Headers() }),
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
  });

  it.each([
    SESSION_HISTORY_ENCODING_IDENTITY,
    SESSION_HISTORY_ENCODING_GZIP,
    SESSION_HISTORY_ENCODING_ZSTD,
  ] as const)(
    "decodes %s, redacts both boundaries, and records background usage",
    async (encoding) => {
      const storage = await createPublicStorageFixture();
      const fixtures: CandidateFixture[] = [];
      {
        fixtures.push(
          await storage.seed({
            raw: (piSessionId) => {
              return settledHistory(
                piSessionId,
                `perform durable work with ${INPUT_SECRET}`,
              );
            },
            encoding,
          }),
        );
      }
      await storage.prepareExecution();
      const provider = installProvider();

      await expect(runScoped(storage)).resolves.toMatchObject({
        scanned: 1,
        claimed: 1,
        succeeded: 1,
        retryableFailure: 0,
        terminalFailure: 0,
      });
      expect(provider.calls).toHaveLength(1);
      for (const invocation of provider.calls) {
        const serialized = JSON.stringify(invocation.request);
        expect(serialized).not.toContain(INPUT_SECRET);
        expect(serialized).not.toContain(fixtures[0]?.pi_session_id);
        expect(invocation.request).toMatchObject({
          model: "deepseek/deepseek-v4.1-flash",
          reasoning: { effort: "low" },
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
          raw_memory: "safe surrounding text [REDACTED_SECRET]",
          rollout_summary: "Authorization: [REDACTED_SECRET]",
        });
      }
      const usage = await inspectUsage(storage);
      expect(usage.length).toBeGreaterThanOrEqual(3);
      expect(usage).toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({
            run_id: null,
            provider: "deepseek-v4.1-flash",
            category: "tokens.input",
          }),
          expect.objectContaining({
            run_id: null,
            provider: "deepseek-v4.1-flash",
            category: "tokens.output",
          }),
        ]),
      );
      await expect(runScoped(storage)).resolves.toMatchObject({ claimed: 0 });
    },
  );

  it("keeps built-in billing on base categories across the GPT long-context boundary", async () => {
    const below = await createPublicStorageFixture();
    const atBoundary = await createPublicStorageFixture();
    await below.seed({
      raw: (piSessionId) => {
        return settledHistory(piSessionId, "total input below the boundary");
      },
    });
    await atBoundary.seed({
      raw: (piSessionId) => {
        return settledHistory(piSessionId, "total input at the boundary");
      },
    });
    await below.prepareExecution();
    await atBoundary.prepareExecution();
    // Responses usage includes cache reads and cache creation in `input_tokens`;
    // the adapter separates them and the usage service recombines the total.
    installProvider(({ request }) => {
      const boundary = JSON.stringify(request).includes("at the boundary");
      return {
        text: defaultProviderOutput(),
        usage: {
          input_tokens: boundary ? 272_001 : 272_000,
          output_tokens: 8,
          cached_tokens: 1,
          cache_write_tokens: 1,
        },
      };
    });

    await expect(runScoped(below)).resolves.toMatchObject({ succeeded: 1 });
    await expect(runScoped(atBoundary)).resolves.toMatchObject({
      succeeded: 1,
    });
    // DeepSeek has no long-context price band, so the boundary does not apply.
    const baseCategories = [
      "tokens.cache_creation",
      "tokens.cache_read",
      "tokens.input",
      "tokens.output",
    ];
    await expect(inspectUsageCategories(below)).resolves.toStrictEqual(
      baseCategories,
    );
    await expect(inspectUsageCategories(atBoundary)).resolves.toStrictEqual(
      baseCategories,
    );
  });

  it("bills built-in extraction at the served route's catalog long-context threshold", async () => {
    const below = await createPublicStorageFixture();
    const atBoundary = await createPublicStorageFixture();
    await below.seed({
      raw: (piSessionId) => {
        return settledHistory(piSessionId, "total input below the boundary");
      },
    });
    await atBoundary.seed({
      raw: (piSessionId) => {
        return settledHistory(piSessionId, "total input at the boundary");
      },
    });
    await below.prepareExecution();
    await atBoundary.prepareExecution();
    // The pricing-only operator change belongs to extraction, after the
    // ordinary native source/trigger Runs have used their normal priced routes.
    // An operator sets a long-context band on the served OpenRouter route; the
    // extraction must bill that band from the same catalog it routed with.
    const restore = await setBuiltInRouteLongContextThresholdFixture({
      model: "deepseek-v4.1-flash",
      concreteProviderType: "openrouter-codex",
      longContextMinTotalInputTokens: 272_001,
    });
    onTestFinished(restore);
    installProvider(({ request }) => {
      const boundary = JSON.stringify(request).includes("at the boundary");
      return {
        text: defaultProviderOutput(),
        usage: {
          input_tokens: boundary ? 272_001 : 272_000,
          output_tokens: 8,
          cached_tokens: 1,
          cache_write_tokens: 1,
        },
      };
    });

    await expect(runScoped(below)).resolves.toMatchObject({ succeeded: 1 });
    await expect(runScoped(atBoundary)).resolves.toMatchObject({
      succeeded: 1,
    });
    await expect(inspectUsageCategories(below)).resolves.toStrictEqual([
      "tokens.cache_creation",
      "tokens.cache_read",
      "tokens.input",
      "tokens.output",
    ]);
    await expect(inspectUsageCategories(atBoundary)).resolves.toStrictEqual([
      "tokens.cache_creation.long_context",
      "tokens.cache_read.long_context",
      "tokens.input.long_context",
      "tokens.output.long_context",
    ]);
  });

  it("isolates invalid sources permanently before the provider", async () => {
    const storages: Awaited<ReturnType<typeof createPublicStorageFixture>>[] =
      [];
    const invalidHistories: readonly ((piSessionId: string) => Buffer)[] = [
      () => {
        return Buffer.from("{malformed\n", "utf8");
      },
      (piSessionId) => {
        return Buffer.from(
          `${JSON.stringify({
            type: "session",
            version: 999,
            id: piSessionId,
            timestamp: "2026-09-02T00:00:00.000Z",
            cwd: "/workspace",
          })}\n`,
          "utf8",
        );
      },
      () => {
        return settledHistory(randomUUID(), "wrong session");
      },
      (piSessionId) => {
        const unsettled = MemoryPiSession.create({
          cwd: "/workspace",
          id: piSessionId,
        });
        unsettled.appendMessage({
          role: "user",
          content: "not settled",
          timestamp: 1,
        });
        return Buffer.from(unsettled.toJsonl(), "utf8");
      },
    ];
    for (const invalidHistory of invalidHistories) {
      const storage = await createPublicStorageFixture();
      storages.push(storage);
      const source = await storage.seed({
        raw: (piSessionId) => {
          return settledHistory(
            piSessionId,
            "public source before invalid history",
          );
        },
      });
      await storage.replacePublishedHistoryWithInvalidInput(
        source,
        invalidHistory(source.pi_session_id),
      );
    }
    const validStorage = await createPublicStorageFixture();
    storages.push(validStorage);
    await validStorage.seed({
      raw: (piSessionId) => {
        return settledHistory(piSessionId, "valid isolated candidate");
      },
    });
    for (const storage of storages) {
      await storage.prepareExecution();
    }
    const provider = installProvider();

    const response = await accept(
      stage1Client(storages).extract({ headers: stage1Headers() }),
      [200],
    );
    expect(response.body).toMatchObject({
      claimed: 5,
      succeeded: 1,
      terminalFailure: 4,
    });
    expect(provider.calls).toHaveLength(1);
  }, 150_000);

  it.each(["encoded_size", "integrity", "utf8", "gzip", "zstd"])(
    "rejects %s source corruption before extraction",
    async (failure) => {
      const storage = await createPublicStorageFixture();
      const source = await storage.seed({
        raw: (piSessionId) => {
          return settledHistory(piSessionId, "valid source");
        },
        encoding:
          failure === "gzip"
            ? SESSION_HISTORY_ENCODING_GZIP
            : failure === "zstd"
              ? SESSION_HISTORY_ENCODING_ZSTD
              : SESSION_HISTORY_ENCODING_IDENTITY,
      });
      const fixture =
        failure === "utf8"
          ? await storage.replacePublishedHistoryWithInvalidInput(
              source,
              Buffer.from([0xff, 0xfe]),
            )
          : source;
      await storage.prepareExecution();
      const body = context.sessionHistoryBlobs.get(fixture.objectKey);
      if (!body) {
        throw new Error("Missing owned source fixture");
      }
      if (failure === "encoded_size") {
        context.sessionHistoryBlobs.set(fixture.objectKey, body.subarray(1));
      } else if (failure !== "utf8") {
        const corrupted = Buffer.from(body);
        corrupted[0] = 0;
        context.sessionHistoryBlobs.set(fixture.objectKey, corrupted);
      }
      const provider = installProvider();
      await expect(runScoped(storage)).resolves.toMatchObject({
        claimed: 1,
        terminalFailure: 1,
        succeeded: 0,
        retryableFailure: 0,
      });
      expect(provider.calls).toHaveLength(0);
      await expect(inspectUsage(storage)).resolves.toStrictEqual([]);
    },
  );

  it("fences concurrent claims and stale workers while recording both provider usages", async () => {
    const storage = await createPublicStorageFixture();
    const fixture = await storage.seed({
      raw: (piSessionId) => {
        return settledHistory(piSessionId, "lease fencing");
      },
    });
    await storage.prepareExecution();
    const piSessionId = fixture.pi_session_id;
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
      raw_memory: "new lease output",
    });
    expect((await inspectUsage(storage)).length).toBeGreaterThanOrEqual(6);
  });

  it("excludes expired and active-session sources before extraction", async () => {
    const storage = await createPublicStorageFixture();
    await storage.seed({
      raw: (piSessionId) => {
        return settledHistory(piSessionId, "expired");
      },
    });
    const executionTime = publicSourceTime + 31 * 24 * 60 * 60 * 1000;
    mockNow(new Date(executionTime - 7 * 3_600_000));
    const active = await storage.seed({
      raw: (piSessionId) => {
        return settledHistory(piSessionId, "active");
      },
    });
    await storage.prepareExecution(executionTime);
    await storage.createActive(active);
    const provider = installProvider();

    await expect(runScoped(storage)).resolves.toMatchObject({
      scanned: 0,
      claimed: 0,
      sourceExpired: 0,
      sourceActive: 0,
      retryableFailure: 0,
      terminalFailure: 0,
    });
    expect(provider.calls).toHaveLength(0);
  });

  it("rejects an old worker after the exact source hash is replaced", async () => {
    const storage = await createPublicStorageFixture();
    const original = await storage.seed({
      raw: (piSessionId) => {
        return settledHistory(piSessionId, "original generation");
      },
    });
    await storage.prepareExecution();
    const piSessionId = original.pi_session_id;
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
      claimed: 0,
      succeeded: 0,
    });
    oldReleased.resolve(undefined);
    await expect(oldWorker).resolves.toMatchObject({ staleDiscarded: 1 });
    await expect(inspect(replacement)).resolves.toMatchObject({
      raw_memory: null,
    });
    expect((await inspectUsage(storage)).length).toBeGreaterThanOrEqual(3);
  });

  it("records consumed usage but cannot resurrect an owner deleted during provider work", async () => {
    const storage = await createPublicStorageFixture();
    const fixture = await storage.seed({
      raw: (piSessionId) => {
        return settledHistory(piSessionId, "delete owner");
      },
    });
    await storage.prepareExecution();
    const piSessionId = fixture.pi_session_id;
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
    const storage = await createPublicStorageFixture();
    const fixture = await storage.seed({
      raw: (piSessionId) => {
        return settledHistory(piSessionId, "usage collision");
      },
    });
    await storage.prepareExecution();
    const piSessionId = fixture.pi_session_id;
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
      last_error_class: "usage_identity_collision",
    });
  });

  it("commits a valid empty response as succeeded without output", async () => {
    const storage = await createPublicStorageFixture();
    const fixture = await storage.seed({
      raw: (piSessionId) => {
        return settledHistory(piSessionId, "no durable signal");
      },
    });
    await storage.prepareExecution();
    installProvider(() => {
      return JSON.stringify({
        raw_memory: "",
        rollout_summary: "",
        rollout_slug: "",
      });
    });

    await expect(
      runScoped(storage, fixture.pi_session_id),
    ).resolves.toMatchObject({
      claimed: 1,
      succeededNoOutput: 1,
    });
  });

  it("redacts an unsafe secret-bearing slug", async () => {
    const storage = await createPublicStorageFixture();
    const fixture = await storage.seed({
      raw: (piSessionId) => {
        return settledHistory(piSessionId, "secret slug");
      },
    });
    await storage.prepareExecution();
    const provider = installProvider(() => {
      return JSON.stringify({
        raw_memory: "safe memory",
        rollout_summary: "safe summary",
        rollout_slug: `slug-${OUTPUT_SECRET}`,
      });
    });

    await expect(
      runScoped(storage, fixture.pi_session_id),
    ).resolves.toMatchObject({
      claimed: 1,
    });
    expect(provider.calls).toHaveLength(1);
    await expect(inspect(fixture)).resolves.toMatchObject({
      rollout_slug: null,
    });
  });

  it("claims only two threads for one user without refilling the daily batch", async () => {
    const storage = await createPublicStorageFixture();
    for (let index = 0; index < 9; index += 1) {
      await storage.seed({
        raw: (piSessionId) => {
          return settledHistory(piSessionId, `bounded candidate ${index}`);
        },
      });
    }
    await storage.prepareExecution();
    const allStarted = createDeferredPromise<void>(context.signal);
    const released = createDeferredPromise<void>(context.signal);
    let active = 0;
    let maxActive = 0;
    const provider = installProvider(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (active === 2) {
        allStarted.resolve(undefined);
      }
      await released.promise;
      active -= 1;
      return defaultProviderOutput();
    });

    const first = runScoped(storage);
    await allStarted.promise;
    expect(provider.calls).toHaveLength(2);
    expect(maxActive).toBe(2);
    released.resolve(undefined);
    await expect(first).resolves.toMatchObject({ claimed: 2, succeeded: 2 });
    await expect(runScoped(storage)).resolves.toMatchObject({
      claimed: 0,
      succeeded: 0,
    });
    expect(provider.calls).toHaveLength(2);
  });

  it("revalidates a fresh continuation after download and before the provider", async () => {
    const storage = await createPublicStorageFixture();
    const fixture = await storage.seed({
      raw: (piSessionId) => {
        return settledHistory(piSessionId, "frozen provider boundary");
      },
    });
    await storage.prepareExecution();
    const entered = createDeferredPromise<void>(context.signal);
    const released = createDeferredPromise<void>(context.signal);
    const fallback = context.mocks.s3.send.getMockImplementation();
    context.mocks.s3.send.mockImplementation(async (value: unknown) => {
      if (
        value instanceof GetObjectCommand &&
        value.input.Key === fixture.objectKey
      ) {
        entered.resolve(undefined);
        await released.promise;
      }
      return fallback ? await fallback(value) : {};
    });
    const provider = installProvider();
    const worker = runScoped(storage);
    await entered.promise;
    await storage.createActive(fixture);
    released.resolve(undefined);
    await expect(worker).resolves.toMatchObject({
      claimed: 1,
      staleDiscarded: 1,
    });
    expect(provider.calls).toHaveLength(0);
    await expect(inspectUsage(storage)).resolves.toStrictEqual([]);
  });

  describe("with nine independent memory owners", () => {
    async function prepareScenario() {
      const storages = [];
      for (let index = 0; index < 9; index += 1) {
        const storage = await createPublicStorageFixture();
        await storage.seed({
          raw: (piSessionId) => {
            return settledHistory(piSessionId, "global capacity");
          },
        });
        storages.push(storage);
      }
      for (const storage of storages) {
        await storage.prepareExecution();
      }
      const provider = installProvider();
      return { storages, provider };
    }
    let preparedScenario: Awaited<ReturnType<typeof prepareScenario>>;
    beforeEach(async () => {
      preparedScenario = await prepareScenario();
    });
    it("retains the independent eight-call global bound across nine owners", async () => {
      const { storages, provider } = preparedScenario;
      const first = await accept(
        stage1Client(storages).extract({ headers: stage1Headers() }),
        [200],
      );
      expect(first.body).toMatchObject({ claimed: 8, succeeded: 8 });
      expect(provider.calls).toHaveLength(8);
      const second = await accept(
        stage1Client(storages).extract({ headers: stage1Headers() }),
        [200],
      );
      expect(second.body).toMatchObject({ claimed: 1, succeeded: 1 });
      expect(provider.calls).toHaveLength(9);
    });
  });
});

function installSourceProvider(
  responder?: Parameters<typeof installProvider>[0],
) {
  // The provider-management BDD helper owns its own S3 fixture; restore the
  // checkpoint HTTP boundary only after management setup has completed.
  installS3Objects();
  return installProvider(responder);
}

type SourceBinding = NonNullable<
  Extract<TestPiMemoryStage1StateActionBody, { action: "seed" }>["source"]
>;
type StorageFixture = ReturnType<typeof createStorageFixture>;

const personalMemoryRoutes = [
  {
    type: "codex-oauth-token",
    url: "https://chatgpt.com/backend-api/codex/responses",
    model: "gpt-6-luna",
    contextWindow: 1_050_000,
  },
] as const;

function actorFor(storage: StorageFixture) {
  return createBddApi(context).user({
    userId: storage.user_id,
    orgId: storage.org_id,
    orgRole: "org:admin",
  });
}

async function codexSource(
  storage: StorageFixture,
  identity = "source-account-a",
  expired = false,
) {
  const actor = actorFor(storage);
  await updateFeatureSwitchesForUser(
    context,
    { orgId: storage.org_id, userId: storage.user_id },
    {
      [FeatureSwitchKey.PiMemory]: true,
    },
  );
  const token = makeCodexJwt({
    exp: Math.floor(now() / 1000) + (expired ? -60 : 7200),
    identity,
  });
  const misc = createMiscRoutesApi(context);
  const result = await misc.upsertPersonalModelProvider(
    actor,
    {
      type: "codex-oauth-token",
      authMethod: "auth_json",
      secrets: {
        CODEX_AUTH_JSON: makeCodexAuthJson({
          accessToken: token,
          accountId: identity,
          refreshToken: `refresh-${identity}`,
        }),
      },
    },
    [200, 201],
  );
  if (result.status !== 200 && result.status !== 201) {
    throw new Error("Missing subscription fixture");
  }
  onTestFinished(async () => {
    await misc.deletePersonalModelProvider(
      actor,
      "codex-oauth-token",
      [204, 404],
    );
  });
  return {
    token,
    identity,
    binding: {
      modelProvider: "codex-oauth-token",
      modelProviderId: result.body.provider.id,
      modelProviderCredentialScope: "member",
    } satisfies SourceBinding,
  };
}

async function seedSource(
  storage: StorageFixture,
  source: SourceBinding,
  content = "owned source evidence",
) {
  const piSessionId = randomUUID();
  // Historical completed checkpoints, fixed bindings and cron state have no
  // user write API. The existing test-only fixture owns this exception; actual
  // provider creation, rotation, deletion, HTTP and result processing stay real.
  return await storage.seed({
    piSessionId,
    raw: settledHistory(piSessionId, content),
    source,
  });
}

describe("Stage 1 source credentials", () => {
  it.each([null, "org"])(
    "serves an explicit built-in source with %s scope under its original owner",
    async (scope) => {
      const storage = createStorageFixture();
      await seedSource(storage, {
        modelProvider: "built-in",
        modelProviderId: null,
        modelProviderCredentialScope: scope,
      });
      const provider = installSourceProvider();
      await expect(runScoped(storage)).resolves.toMatchObject({ succeeded: 1 });
      expect(provider.calls).toHaveLength(1);
      expect(provider.calls[0]?.request).toMatchObject({
        model: "deepseek/deepseek-v4.1-flash",
        reasoning: { effort: "low" },
      });
      const usage = await inspectUsage(storage);
      expect(usage.length).toBeGreaterThan(0);
      for (const row of usage) {
        expect(row).toMatchObject({
          run_id: null,
          provider: "deepseek-v4.1-flash",
        });
      }
    },
  );

  it.each([
    { modelProviderId: randomUUID(), modelProviderCredentialScope: "org" },
    { modelProviderId: null, modelProviderCredentialScope: "member" },
  ])("rejects an ambiguous built-in binding %j", async (binding) => {
    const storage = createStorageFixture();
    const candidate = await seedSource(storage, {
      modelProvider: "built-in",
      ...binding,
    });
    const provider = installSourceProvider();
    await expect(runScoped(storage)).resolves.toMatchObject({
      terminalFailure: 1,
    });
    expect(provider.calls).toHaveLength(0);
    await expect(inspect(candidate)).resolves.toMatchObject({
      last_error_class: "source_binding_invalid",
      successful_source_history_hash: null,
    });
    await expect(inspectUsage(storage)).resolves.toStrictEqual([]);
  });

  it("routes mixed Auto and personal subscription sources", async () => {
    const storages = Array.from({ length: 2 }, () => {
      return createStorageFixture();
    });
    const [builtin, codex] = storages;
    if (!builtin || !codex) {
      throw new Error("Missing memory owners");
    }
    const subscription = await codexSource(codex);
    await seedSource(
      builtin,
      {
        modelProvider: "built-in",
        modelProviderId: null,
        modelProviderCredentialScope: null,
      },
      "builtin evidence",
    );
    await seedSource(codex, subscription.binding, "personal evidence");
    const provider = installSourceProvider();
    const result = await accept(
      stage1Client(storages).extract({ headers: stage1Headers() }),
      [200],
    );
    expect(result.body).toMatchObject({
      succeeded: 2,
      terminalFailure: 0,
      retryableFailure: 0,
    });
    expect(provider.calls).toHaveLength(2);
    const native = provider.calls.find((call) => {
      return call.url === "https://chatgpt.com/backend-api/codex/responses";
    });
    expect(native?.headers.get("authorization")).toBe(
      `Bearer ${subscription.token}`,
    );
    expect(native?.headers.get("chatgpt-account-id")).toBe(
      subscription.identity,
    );
    expect(native?.request).toMatchObject({
      model: "gpt-6-luna",
      text: { format: { type: "json_schema", strict: true } },
    });
    expect(native?.request).not.toHaveProperty("max_output_tokens");
    const managed = provider.calls.find((call) => {
      return call.url === "https://openrouter.ai/api/v1/responses";
    });
    expect(managed?.request).toMatchObject({
      model: "deepseek/deepseek-v4.1-flash",
      reasoning: { effort: "low" },
    });
    expect((await inspectUsage(builtin)).length).toBeGreaterThan(0);
    await expect(inspectUsage(codex)).resolves.toStrictEqual([]);
  });

  it("does not select today's active subscription for a historical account", async () => {
    const fixture = createPublicPiMemorySource(context);
    await fixture.run(async () => {
      const source = await fixture.prepare(new Date(now() + 24 * 3_600_000));
      const baseline = await observePublicUsage(context, fixture.actor);
      expect(baseline.record.rows).toStrictEqual([]);
      expect(baseline.members).toStrictEqual([]);

      await fixture.activateAccount("source-account-b");
      const provider = installProvider();
      await expect(fixture.extract()).resolves.toMatchObject({ succeeded: 1 });
      expect(provider.calls[0]?.headers.get("chatgpt-account-id")).toBe(
        fixture.account,
      );
      expect(provider.calls[0]?.headers.get("authorization")).toBe(
        `Bearer ${source.subscription.oauth.oauthTokenResponses[0]?.access_token}`,
      );
      await expect(
        observePublicUsage(context, fixture.actor),
      ).resolves.toStrictEqual(baseline);
    });
  });

  it.each(["codex"] as const)(
    "never writes %s model credits for no-output, malformed output and replay",
    async () => {
      const storage = createStorageFixture();
      const source = (await codexSource(storage)).binding;
      const candidate = await seedSource(storage, source);
      installSourceProvider(() => {
        return "not valid JSON";
      });
      await expect(runScoped(storage)).resolves.toMatchObject({
        retryableFailure: 1,
      });
      await expect(inspectUsage(storage)).resolves.toStrictEqual([]);
      await storage.action({
        action: "make-retry-due",
        pi_session_id: candidate.pi_session_id,
      });
      installSourceProvider(() => {
        return JSON.stringify({
          raw_memory: "",
          rollout_summary: "",
          rollout_slug: null,
        });
      });
      await expect(runScoped(storage)).resolves.toMatchObject({
        succeededNoOutput: 1,
      });
      await expect(inspectUsage(storage)).resolves.toStrictEqual([]);
      // Writer boundary exception: deliberately replay reported vendor usage
      // directly through the test route, independently from the worker's caller.
      for (const usage of [
        { input: 272_001, output: 5, cacheRead: 7, cacheWrite: 8 },
        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ]) {
        for (let replay = 0; replay < 2; replay += 1) {
          await storage.action({
            action: "record-usage",
            pi_session_id: candidate.pi_session_id,
            source_history_hash: candidate.source_history_hash,
            response_source_id: "subscription-replay",
            billing_mode: "subscription",
            usage,
          });
        }
      }
      await expect(inspectUsage(storage)).resolves.toStrictEqual([]);
    },
  );

  it.each([
    "missing-provider",
    "missing-id",
    "missing-scope",
    "wrong-scope",
    "unsupported",
  ])(
    "skips %s without a request, watermark or repeated attempt",
    async (kind) => {
      const storage = createStorageFixture();
      const source: SourceBinding =
        kind === "wrong-scope"
          ? {
              ...(await codexSource(storage).then(({ binding }) => {
                return binding;
              })),
              modelProviderCredentialScope: "org",
            }
          : {
              modelProvider:
                kind === "missing-provider"
                  ? null
                  : kind === "unsupported"
                    ? "claude-code-oauth-token"
                    : "codex-oauth-token",
              modelProviderId: kind === "missing-id" ? null : randomUUID(),
              modelProviderCredentialScope:
                kind === "missing-scope" ? null : "member",
            };
      const candidate = await seedSource(storage, source);
      const provider = installSourceProvider();
      await expect(runScoped(storage)).resolves.toMatchObject({
        terminalFailure: 1,
      });
      expect(provider.calls).toHaveLength(0);
      await expect(inspect(candidate)).resolves.toMatchObject({
        successful_source_history_hash: null,
        raw_memory: null,
        status: "terminal_failure",
      });
      await expect(runScoped(storage)).resolves.toMatchObject({ claimed: 0 });
      await expect(inspectUsage(storage)).resolves.toStrictEqual([]);
    },
  );
});

async function disconnectCodex(storage: StorageFixture, id: string) {
  createRouteMocks(context).clerk.session(
    storage.user_id,
    storage.org_id,
    "org:admin",
  );
  await accept(
    setupApp({ context, routes: meModelProviderAccountRoutes })(
      personalModelProviderAccountsByIdContract,
    ).delete({
      headers: { authorization: "Bearer clerk-session" },
      params: { id },
    }),
    [204],
  );
}

function installRefresh(
  identity: string,
  token: string,
  beforeResponse?: () => Promise<void>,
  revoke = false,
) {
  const requests: string[] = [];
  server.use(
    http.post("https://auth.openai.com/oauth/token", async ({ request }) => {
      requests.push(await request.text());
      await beforeResponse?.();
      if (revoke) {
        return HttpResponse.json(
          { error: "invalid_grant", error_description: "refresh_token_reused" },
          { status: 400 },
        );
      }
      return HttpResponse.json({
        access_token: token,
        refresh_token: `refreshed-${identity}`,
        token_type: "Bearer",
        expires_in: 7200,
        id_token: makeCodexJwt({
          "https://api.openai.com/auth": {
            chatgpt_account_id: identity,
            chatgpt_plan_type: "plus",
          },
        }),
      });
    }),
  );
  return requests;
}

describe("Stage 1 credential lifecycle fences", () => {
  it("keeps transient refresh failures on the existing hourly retry policy", async () => {
    const storage = createStorageFixture();
    const source = await codexSource(storage, "transient-refresh", true);
    const candidate = await seedSource(storage, source.binding);
    let refreshCalls = 0;
    server.use(
      http.post("https://auth.openai.com/oauth/token", () => {
        refreshCalls += 1;
        return HttpResponse.json({ error: "server_error" }, { status: 503 });
      }),
    );
    const provider = installSourceProvider();
    await expect(runScoped(storage)).resolves.toMatchObject({
      retryableFailure: 1,
    });
    expect(refreshCalls).toBe(1);
    expect(provider.calls).toHaveLength(0);
    await expect(inspect(candidate)).resolves.toMatchObject({
      status: "retryable_failure",
      last_error_class: "credential_refresh_failed",
      successful_source_history_hash: null,
    });
    await expect(runScoped(storage)).resolves.toMatchObject({ claimed: 0 });
    await storage.action({
      action: "make-retry-due",
      pi_session_id: candidate.pi_session_id,
    });
    installRefresh(
      source.identity,
      makeCodexJwt({ exp: Math.floor(now() / 1000) + 7200 }),
    );
    await expect(runScoped(storage)).resolves.toMatchObject({ succeeded: 1 });
    expect(provider.calls).toHaveLength(1);
    await expect(inspectUsage(storage)).resolves.toStrictEqual([]);
  });

  it("refreshes the original subscription and then reads that same account ID", async () => {
    const fixture = createPublicPiMemorySource(context);
    await fixture.run(async () => {
      const source = await fixture.prepare(new Date(now() + 24 * 3_600_000));
      const baseline = await observePublicUsage(context, fixture.actor);
      expect(baseline.record.rows).toStrictEqual([]);
      expect(baseline.members).toStrictEqual([]);

      await fixture.expireCredential(source.subscription.accountSourceId);
      await fixture.activateAccount("active-account-b");
      const refreshed = makeCodexJwt({
        exp: Math.floor(now() / 1000) + 7200,
        identity: "refreshed-a",
      });
      const refreshes = installRefresh(fixture.account, refreshed);
      const provider = installProvider();
      await expect(fixture.extract()).resolves.toMatchObject({ succeeded: 1 });
      expect(refreshes).toHaveLength(1);
      expect(refreshes[0]).toContain(`refresh-${fixture.account}`);
      expect(provider.calls).toHaveLength(1);
      expect(provider.calls[0]?.headers.get("authorization")).toBe(
        `Bearer ${refreshed}`,
      );
      expect(provider.calls[0]?.headers.get("chatgpt-account-id")).toBe(
        fixture.account,
      );
      await expect(
        observePublicUsage(context, fixture.actor),
      ).resolves.toStrictEqual(baseline);
    });
  });

  it.each(["disconnected", "refresh-revoked", "provider-revoked"])(
    "settles %s without rapid retries or model credits",
    async (mode) => {
      const fixture = createPublicPiMemorySource(context);
      await fixture.run(async () => {
        const source = await fixture.prepare(new Date(now() + 24 * 3_600_000));
        const baseline = await observePublicUsage(context, fixture.actor);
        expect(baseline.record.rows).toStrictEqual([]);
        expect(baseline.members).toStrictEqual([]);

        if (mode === "refresh-revoked") {
          await fixture.expireCredential(source.subscription.accountSourceId);
        }
        if (mode === "disconnected") {
          await fixture.disconnect(source.subscription.accountSourceId);
        }
        const refreshes = installRefresh(
          fixture.account,
          "unused-token",
          undefined,
          true,
        );
        const provider = installProvider();
        let denied = 0;
        if (mode === "provider-revoked") {
          server.use(
            http.post("https://chatgpt.com/backend-api/codex/responses", () => {
              denied += 1;
              return HttpResponse.json(
                { error: { message: "revoked synthetic credential" } },
                { status: 401 },
              );
            }),
          );
        }
        await expect(fixture.extract()).resolves.toMatchObject({
          terminalFailure: 1,
        });
        expect(provider.calls).toHaveLength(0);
        expect(denied).toBe(mode === "provider-revoked" ? 1 : 0);
        expect(refreshes).toHaveLength(mode === "refresh-revoked" ? 1 : 0);
        await expect(fixture.extract()).resolves.toMatchObject({ claimed: 0 });
        await expect(
          observePublicUsage(context, fixture.actor),
        ).resolves.toStrictEqual(baseline);
      });
    },
  );

  it.each(["cancel", "source-missing", "lease-expired", "new-source"])(
    "sends no model request when %s wins during refresh",
    async (race) => {
      const storage = createStorageFixture();
      const original = await codexSource(storage, "refresh-race", true);
      const candidate = await seedSource(storage, original.binding);
      await updateFeatureSwitchesForUser(
        context,
        { orgId: storage.org_id, userId: storage.user_id },
        {
          [FeatureSwitchKey.PiMemory]: true,
        },
      );
      const controller = new AbortController();
      onTestFinished(() => {
        return controller.abort();
      });
      const entered = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      const refreshed = makeCodexJwt({ exp: Math.floor(now() / 1000) + 7200 });
      const refreshes = installRefresh(
        original.identity,
        refreshed,
        async () => {
          entered.resolve();
          await release.promise;
        },
      );
      const provider = installSourceProvider();
      const running = runScoped(storage, undefined, controller.signal);
      const settled = running.then(
        (value) => {
          return { value };
        },
        (error) => {
          return { error: String(error) };
        },
      );
      await entered.promise;
      if (race === "cancel") {
        controller.abort();
      }
      if (race === "source-missing") {
        await storage.action({
          action: "delete-source",
          pi_session_id: candidate.pi_session_id,
        });
      }
      if (race === "lease-expired") {
        await storage.action({
          action: "expire-lease",
          pi_session_id: candidate.pi_session_id,
        });
      }
      if (race === "new-source") {
        await storage.replace(
          candidate,
          settledHistory(candidate.pi_session_id, "new source revision"),
        );
      }
      release.resolve();
      await settled;
      expect(refreshes).toHaveLength(1);
      expect(provider.calls).toHaveLength(0);
      await expect(inspectUsage(storage)).resolves.toStrictEqual([]);
      await expect(inspect(candidate)).resolves.toMatchObject({
        raw_memory: null,
        successful_source_history_hash: null,
      });
    },
  );

  it("preserves completed output after its source disappears", async () => {
    const storage = createStorageFixture();
    const candidate = await seedSource(
      storage,
      await codexSource(storage).then(({ binding }) => {
        return binding;
      }),
    );
    const provider = installSourceProvider();
    await expect(runScoped(storage)).resolves.toMatchObject({ succeeded: 1 });
    const before = await inspect(candidate);
    await storage.action({
      action: "delete-source",
      pi_session_id: candidate.pi_session_id,
    });
    await expect(runScoped(storage)).resolves.toMatchObject({ claimed: 0 });
    await expect(inspect(candidate)).resolves.toMatchObject({
      raw_memory: before?.raw_memory,
      status: "succeeded",
    });
    expect(provider.calls).toHaveLength(1);
  });

  it("does not refill a frozen daily slot when a selected source is unservable", async () => {
    const storage = createStorageFixture();
    for (let index = 0; index < 3; index += 1) {
      await seedSource(storage, {
        modelProvider: "claude-code-oauth-token",
        modelProviderId: randomUUID(),
        modelProviderCredentialScope: "member",
      });
    }
    const provider = installSourceProvider();
    await expect(runScoped(storage)).resolves.toMatchObject({
      claimed: 2,
      terminalFailure: 2,
    });
    await expect(runScoped(storage)).resolves.toMatchObject({ claimed: 0 });
    expect(provider.calls).toHaveLength(0);
    await expect(inspectUsage(storage)).resolves.toStrictEqual([]);
  });
});

describe("Stage 1 source preparation identity", () => {
  it.each(
    personalMemoryRoutes.flatMap(({ type }) => {
      return (["orgId", "userId"] as const).map((field) => {
        return { type, field };
      });
    }),
  )(
    "rejects a $type $field change while history is being prepared",
    async ({ field }) => {
      const storage = createStorageFixture();
      const source = await codexSource(storage).then(({ binding }) => {
        return binding;
      });
      const candidate = await seedSource(storage, source);
      const provider = installSourceProvider();
      const read = context.mocks.s3.send.getMockImplementation();
      context.mocks.s3.send.mockImplementation(
        async (commandValue: unknown) => {
          if (
            commandValue instanceof GetObjectCommand &&
            commandValue.input.Key === candidate.objectKey
          ) {
            await storage.action({
              action: "source-binding",
              pi_session_id: candidate.pi_session_id,
              source: { ...source, [field]: `changed-${randomUUID()}` },
            });
          }
          return read ? await read(commandValue) : {};
        },
      );
      await expect(runScoped(storage)).resolves.toMatchObject({
        staleDiscarded: 1,
      });
      expect(provider.calls).toHaveLength(0);
      await expect(inspectUsage(storage)).resolves.toStrictEqual([]);
      await expect(inspect(candidate)).resolves.toMatchObject({
        raw_memory: null,
        successful_source_history_hash: null,
      });
    },
  );

  it("keeps a missing-source candidate behind the existing selection fence", async () => {
    const storage = createStorageFixture();
    const candidate = await seedSource(
      storage,
      await codexSource(storage).then(({ binding }) => {
        return binding;
      }),
    );
    const provider = installSourceProvider();
    const read = context.mocks.s3.send.getMockImplementation();
    context.mocks.s3.send.mockImplementation(async (commandValue: unknown) => {
      if (
        commandValue instanceof GetObjectCommand &&
        commandValue.input.Key === candidate.objectKey
      ) {
        await storage.action({
          action: "delete-source",
          pi_session_id: candidate.pi_session_id,
        });
      }
      return read ? await read(commandValue) : {};
    });
    await expect(runScoped(storage)).resolves.toMatchObject({
      staleDiscarded: 1,
    });
    await expect(runScoped(storage)).resolves.toMatchObject({ claimed: 0 });
    expect(provider.calls).toHaveLength(0);
    await expect(inspectUsage(storage)).resolves.toStrictEqual([]);
    await expect(inspect(candidate)).resolves.toMatchObject({
      raw_memory: null,
      successful_source_history_hash: null,
    });
  });
});

describe("Stage 1 background credential availability", () => {
  it("exposes only fixed Auto as a platform chat route", async () => {
    const actor = createBddApi(context).user();
    const models = await createMiscRoutesApi(context).listRunModels(actor);
    expect(models.defaultModel).toBe("okou-1.0");
    expect(
      models.models
        .filter((model) => {
          return model.memberEffective.providerType === "built-in";
        })
        .map(({ model }) => {
          return model;
        }),
    ).toStrictEqual(["okou-1.0"]);
  });

  it.each(
    personalMemoryRoutes.map((route) => {
      return { ...route, scope: "member" };
    }),
  )(
    "uses the exact $scope $type source route",
    async ({ url, model, contextWindow }) => {
      const storage = createStorageFixture();
      const subscription = await codexSource(storage, "exact-owned-account");
      const source = subscription.binding;
      const piSessionId = randomUUID();
      const history = MemoryPiSession.create({
        cwd: "/private/source",
        id: piSessionId,
      });
      // Historical checkpoint fixture exception: exercise the actual worker's
      // final serialized request with enough evidence to exceed its input budget.
      for (let index = 0; index < 180; index += 1) {
        history.appendMessage({
          role: "user",
          timestamp: index,
          content: `human-${index} ${String.raw`"\汉😀 `.repeat(600)}`,
        });
      }
      history.appendMessage(assistantMessage("completed safely", 181));
      const candidate = await storage.seed({
        piSessionId,
        raw: Buffer.from(history.toJsonl(), "utf8"),
        source,
      });
      const provider = installSourceProvider();
      await expect(runScoped(storage)).resolves.toMatchObject({
        succeeded: 1,
      });
      expect(provider.calls).toHaveLength(1);
      const call = provider.calls[0];
      expect(call?.url).toBe(url);
      expect(call?.headers.get("authorization")).toBe(
        `Bearer ${subscription.token}`,
      );
      expect(call?.headers.get("chatgpt-account-id")).toBe(
        subscription.identity,
      );
      expect(call?.request).toMatchObject({
        model,
        reasoning: { effort: "low" },
        text: {
          format: {
            type: "json_schema",
            strict: true,
            schema: PI_MEMORY_STAGE1_RESPONSE_SCHEMA,
          },
        },
      });
      expect(call?.request).not.toHaveProperty("service_tier");
      expect(call?.request).not.toHaveProperty("tools");
      if (!call) {
        throw new Error("Missing source HTTP request");
      }
      const body = call.body;
      expect(call.request).not.toHaveProperty("max_output_tokens");
      const tokens = encode(body).length;
      expect(tokens).toBeGreaterThan(100_000);
      expect(tokens).toBeLessThanOrEqual(
        Math.min(250_000, contextWindow - 32_768 - 8192),
      );
      expect(body).toContain("human-179");
      expect(body).not.toContain("human-0 ");
      await expect(inspect(candidate)).resolves.toMatchObject({
        status: "succeeded",
        successful_source_history_hash: candidate.source_history_hash,
      });
      await expect(runScoped(storage)).resolves.toMatchObject({ claimed: 0 });
      await expect(inspectUsage(storage)).resolves.toStrictEqual([]);
    },
  );

  it("does not borrow an account retained for another active foreground run", async () => {
    const fixture = createPublicPiMemorySource(context);
    await fixture.run(async () => {
      const source = await fixture.prepare(new Date(now() + 24 * 3_600_000));
      const baseline = await observePublicUsage(context, fixture.actor);
      expect(baseline.record.rows).toStrictEqual([]);
      expect(baseline.members).toStrictEqual([]);
      const actor = fixture.actor;
      const bdd = createBddApi(context);
      const runs = createRunsApi(context);
      const runnerGroup = runs.configureRunnerGroup();
      const agent = await bdd.createAgent(actor, {
        displayName: "Retained source account",
        visibility: "private",
      });
      fixture.registerAgent(agent.agentId);
      const { runId } = await createChatFilesBddApi(context).sendAndLaunch(
        actor,
        {
          agentId: agent.agentId,
          prompt: "active foreground source",
          model: "gpt-6-astra",
        },
      );
      fixture.registerRun(runId);
      const foregroundState = await runs.readRun(actor, runId);
      expect(foregroundState.status, JSON.stringify(foregroundState)).toBe(
        "pending",
      );
      await runs.heartbeatRunner(runnerGroup);
      const claim = await runs.claimRunnerJob(runId);
      fixture.registerClaim(runId, claim.sandboxToken);
      expect(
        claim.secretConnectorMetadataMap?.CHATGPT_ACCESS_TOKEN?.sourceId,
      ).toBe(source.subscription.accountSourceId);
      await fixture.disconnect(source.subscription.accountSourceId);
      if (!claim.encryptedSecrets) {
        throw new Error("Expected retained runtime envelope");
      }
      const foreground = await createFirewallApi(context).requestFirewallAuth(
        { authorization: `Bearer ${claim.sandboxToken}` },
        {
          encryptedSecrets: claim.encryptedSecrets,
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("CHATGPT_ACCESS_TOKEN")}`,
            "ChatGPT-Account-ID": secretTemplate("CHATGPT_ACCOUNT_ID"),
          },
          secretConnectorMap: claim.secretConnectorMap ?? undefined,
          secretConnectorMetadataMap:
            claim.secretConnectorMetadataMap ?? undefined,
        },
        [200],
      );
      expect(foreground.body).toMatchObject({
        headers: { "ChatGPT-Account-ID": fixture.account },
      });
      const provider = installProvider();
      await expect(fixture.extract()).resolves.toMatchObject({
        terminalFailure: 1,
      });
      expect(provider.calls).toHaveLength(0);
      await expect(
        observePublicUsage(context, fixture.actor),
      ).resolves.toStrictEqual(baseline);
    });
  });

  it("rechecks disconnection after serial preparation and before native HTTP", async () => {
    const fixture = createPublicPiMemorySource(context, {
      sources: ["source one", "source two"],
    });
    await fixture.run(async () => {
      const source = await fixture.prepare(new Date(now() + 24 * 3_600_000));
      const baseline = await observePublicUsage(context, fixture.actor);
      expect(baseline.record.rows).toStrictEqual([]);
      expect(baseline.members).toStrictEqual([]);

      const provider = installProvider();
      const read = context.mocks.s3.send.getMockImplementation();
      const historyKeys = new Set(
        source.sources.map((entry) => {
          return entry.objectKey;
        }),
      );
      let downloads = 0;
      context.mocks.s3.send.mockImplementation(
        async (commandValue: unknown) => {
          if (
            commandValue instanceof GetObjectCommand &&
            commandValue.input.Key &&
            historyKeys.has(commandValue.input.Key) &&
            ++downloads === 2
          ) {
            await fixture.disconnect(source.subscription.accountSourceId);
          }
          return read ? await read(commandValue) : {};
        },
      );
      await expect(fixture.extract()).resolves.toMatchObject({
        terminalFailure: 2,
      });
      expect(provider.calls).toHaveLength(0);
      await expect(
        observePublicUsage(context, fixture.actor),
      ).resolves.toStrictEqual(baseline);
    });
  });
});

describe("Stage 1 source quota at the model HTTP boundary", () => {
  it.each(nativeMemoryQuotaCases)(
    "$name",
    async ({ payload, raw, status, reason }) => {
      const fixture = createPublicPiMemorySource(context);
      await fixture.run(async () => {
        const source = await fixture.prepare(new Date(now() + 24 * 3_600_000));
        const baseline = await observePublicUsage(context, fixture.actor);
        expect(baseline.record.rows).toStrictEqual([]);
        expect(baseline.members).toStrictEqual([]);

        const quotaRequests: Headers[] = [];
        server.use(
          http.get(
            "https://chatgpt.com/backend-api/wham/usage",
            ({ request }) => {
              quotaRequests.push(request.headers);
              return new HttpResponse(raw ?? JSON.stringify(payload), {
                status: status ?? 200,
                headers: { "content-type": "application/json" },
              });
            },
          ),
        );
        const provider = installProvider();
        const result = await fixture.extract();
        expect(quotaRequests).toHaveLength(1);
        expect(quotaRequests[0]?.get("authorization")).toBe(
          `Bearer ${source.subscription.oauth.oauthTokenResponses[0]?.access_token}`,
        );
        expect(quotaRequests[0]?.get("chatgpt-account-id")).toBe(
          fixture.account,
        );
        expect(provider.calls).toHaveLength(reason ? 0 : 1);
        if (reason) {
          expect(result).toMatchObject({ retryableFailure: 1, succeeded: 0 });
        } else {
          expect(result).toMatchObject({ succeeded: 1 });
        }
        await expect(
          observePublicUsage(context, fixture.actor),
        ).resolves.toStrictEqual(baseline);
      });
    },
  );

  it("refreshes quota on hourly retries without refilling frozen slots", async () => {
    const storage = createStorageFixture();
    const native = await codexSource(storage);
    const first = await seedSource(storage, native.binding, "first");
    await seedSource(storage, native.binding, "second");

    let used = 90;
    let reads = 0;
    server.use(
      http.get("https://chatgpt.com/backend-api/wham/usage", () => {
        reads++;
        return HttpResponse.json({
          rate_limit: { primary_window: { used_percent: used } },
        });
      }),
    );
    const provider = installSourceProvider();
    await expect(runScoped(storage)).resolves.toMatchObject({
      retryableFailure: 2,
      succeeded: 0,
    });
    expect(reads).toBe(2);
    const third = await seedSource(storage, native.binding, "third");
    await expect(runScoped(storage)).resolves.toMatchObject({ claimed: 0 });
    expect(provider.calls).toHaveLength(0);
    // Infrastructure exception: make only an existing frozen slot due, not a new selection.
    await storage.action({
      action: "make-retry-due",
      pi_session_id: first.pi_session_id,
    });
    used = 75;
    await expect(runScoped(storage)).resolves.toMatchObject({ succeeded: 1 });
    expect(reads).toBe(3);
    expect(provider.calls).toHaveLength(1);
    expect((await inspect(third))?.successful_source_history_hash).toBeNull();
  });

  it.each(["disconnect", "feature", "source", "lease", "cancel"])(
    "fences %s during quota I/O",
    async (fault) => {
      const storage = createStorageFixture();
      const native = await codexSource(storage);
      const candidate = await seedSource(storage, native.binding);
      const controller = new AbortController();
      onTestFinished(() => {
        return controller.abort();
      });
      server.use(
        http.get("https://chatgpt.com/backend-api/wham/usage", async () => {
          if (fault === "disconnect") {
            await disconnectCodex(storage, native.binding.modelProviderId);
          }
          if (fault === "feature") {
            await updateFeatureSwitchesForUser(
              context,
              { orgId: storage.org_id, userId: storage.user_id },
              { [FeatureSwitchKey.PiMemory]: false },
            );
          }
          if (fault === "source") {
            await storage.action({
              action: "source-binding",
              pi_session_id: candidate.pi_session_id,
              source: { ...native.binding, modelProviderId: randomUUID() },
            });
          }
          if (fault === "lease") {
            await storage.action({
              action: "expire-lease",
              pi_session_id: candidate.pi_session_id,
            });
          }
          if (fault === "cancel") {
            controller.abort();
          }
          return HttpResponse.json({
            rate_limit: { primary_window: { used_percent: 0 } },
          });
        }),
      );
      const provider = installSourceProvider();
      const work = runScoped(storage, undefined, controller.signal);
      if (fault === "cancel") {
        await expect(work).rejects.toThrow("Unknown response status 500");
      } else {
        await work;
      }
      expect(provider.calls).toHaveLength(0);
      await expect(inspectUsage(storage)).resolves.toStrictEqual([]);
      expect(
        (await inspect(candidate))?.successful_source_history_hash,
      ).toBeNull();
    },
  );

  it.each(["malformed-json", "network", "timeout"])(
    "allows unknown %s through ordinary source admission",
    async (fault) => {
      const fixture = createPublicPiMemorySource(context);
      await fixture.run(async () => {
        await fixture.prepare(new Date(now() + 24 * 3_600_000));
        server.use(
          http.get(
            "https://chatgpt.com/backend-api/wham/usage",
            async ({ request }) => {
              if (fault === "network") {
                return HttpResponse.error();
              }
              if (fault === "timeout") {
                const deadline = createDeferredPromise<void>(context.signal);
                if (request.signal.aborted) {
                  deadline.resolve();
                } else {
                  request.signal.addEventListener(
                    "abort",
                    () => {
                      deadline.resolve();
                    },
                    { once: true },
                  );
                }
                await deadline.promise;
              }
              return new HttpResponse("malformed JSON");
            },
          ),
        );
        const provider = installSourceProvider();
        await expect(fixture.extract()).resolves.toMatchObject({
          succeeded: 1,
        });
        expect(provider.calls).toHaveLength(1);
      });
    },
    10_000, // Includes the real five-second metadata deadline.
  );

  it("requires ordinary credit admission for genuine runless built-in work", async () => {
    const storage = createStorageFixture();
    const candidate = await seedSource(storage, {
      modelProvider: "built-in",
      modelProviderId: null,
      modelProviderCredentialScope: null,
    });
    await seedOrgMetadata({ orgId: storage.org_id, tier: "pro", credits: 0 });
    const provider = installSourceProvider();
    await expect(runScoped(storage)).resolves.toMatchObject({
      retryableFailure: 1,
    });
    expect(provider.calls).toHaveLength(0);
    expect((await inspect(candidate))?.last_error_class).toBe(
      "source_admission_denied",
    );
    await expect(inspectUsage(storage)).resolves.toStrictEqual([]);
  });
});

describe("Stage 1 built-in reserves with positive cash", () => {
  it.each(builtinMemoryQuotaCases)("%s", async (scenario) => {
    const storage = createStorageFixture();
    const candidate = await seedSource(storage, {
      modelProvider: "built-in",
      modelProviderId: null,
      modelProviderCredentialScope: "org",
    });
    const { denied } = await seedMemoryQuotaCase(
      { orgId: storage.org_id, userId: storage.user_id },
      new Date(now()),
      scenario,
    );
    const provider = installSourceProvider();
    const result = await runScoped(storage);
    expect(result).toMatchObject(
      denied ? { retryableFailure: 1, succeeded: 0 } : { succeeded: 1 },
    );
    expect(provider.calls).toHaveLength(denied ? 0 : 1);
    if (denied) {
      await expect(inspect(candidate)).resolves.toMatchObject({
        last_error_class: "quota_below_threshold",
        successful_source_history_hash: null,
      });
      await expect(inspectUsage(storage)).resolves.toStrictEqual([]);
    }
  });
});
