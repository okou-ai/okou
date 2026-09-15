import {
  builtinMemoryQuotaCases,
  seedMemoryQuotaCase,
} from "../../../test-fixtures/pi-memory-builtin-quota";
import { nativeMemoryQuotaCases } from "../../../test-fixtures/pi-memory-quota";
import { seedOrgMetadata } from "../../../test-fixtures/system-config-seeds";
import { installApiTestConnectorCatalog } from "../../../test-fixtures/connector-catalog";
import {
  modelProviderConnectionsMainContract,
  modelProviderConnectionsByIdContract,
} from "@okouai/api-contracts/contracts/model-provider-gateways";
import { personalModelProviderAccountsByIdContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { modelProviderGatewayRoutes } from "../model-provider-gateways";
import { meModelProviderAccountRoutes } from "../me-model-provider-accounts";
import { createRouteMocks } from "./helpers/route-test";
import { createAuthDeviceSupportApi } from "./helpers/api-bdd-auth-device-support";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import {
  makeCodexAuthJson,
  makeCodexJwt,
  mockCodexDeviceAuthProvider,
  createAuthDeviceApiActions,
} from "./helpers/api-bdd-auth-device";
import { createHash, randomUUID } from "node:crypto";
import { gzipSync, zstdCompressSync, zstdDecompressSync } from "node:zlib";

import { GetObjectCommand } from "@aws-sdk/client-s3";
import {
  getProvidersForModel,
  getSecretNameForType,
} from "@okouai/api-contracts/contracts/model-providers";
import { isPiExecutionRoute } from "@okouai/core/pi-execution";
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
import { mockEnv } from "../../../lib/env";
import { mockNow, now, nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  seedBuiltInModelKey,
  seedBuiltInModelCandidateKeys,
  resolveBuiltInModelRouteFixture,
} from "./helpers/runtime-state";
import {
  deleteFeatureSwitchesForUser,
  updateFeatureSwitchesForUser,
} from "./helpers/feature-switches";
import {
  withBuiltInModelRuntimeRouteCandidateUnavailableForTest,
  withBuiltInModelRuntimeRouteUnavailableForTest,
} from "../../../test-fixtures/built-in-model-runtime-route";
import { createFixtureOperationOwner } from "./helpers/fixture-operation-owner";
import { flushWaitUntilForTest } from "../../context/wait-until";
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
  usage: ProviderUsage = {
    input_tokens: 12,
    output_tokens: 8,
    cached_tokens: 2,
    cache_write_tokens: 3,
  },
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
      /https:\/\/(?:api\.openai\.com|(?:us\.)?openrouter\.ai|chatgpt\.com|ai-gateway\.vercel\.sh|stage1-gateway\.example)\/.*\/responses/u,
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
        const { text, usage } =
          typeof reply === "string" ? { text: reply, usage: undefined } : reply;
        return new HttpResponse(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  responsesSse(text, invocation.sequence, usage),
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

async function inspectUsageCategories(
  storage: ReturnType<typeof createStorageFixture>,
): Promise<string[]> {
  const usage = await inspectUsage(storage);
  for (const row of usage) {
    expect(row).toMatchObject({ run_id: null, provider: "gpt-5.6-luna" });
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

function stage1Client(
  storages: readonly ReturnType<typeof createStorageFixture>[],
) {
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
  await seedBuiltInModelKey(context, "gpt-5.6-luna");
});

async function corruptStage1CatalogPayload(value: unknown): Promise<void> {
  // Infrastructure exception: an unmeasurable SDK payload cannot be produced
  // through a user API. Load the runtime-owned external SDK, retaining its
  // actual serializer/onPayload/error folding and the worker's real route.
  if (typeof value === "object" && value !== null) {
    Object.defineProperty(value, "recursive", { value, enumerable: true });
  }
  const sdkUrl = new URL(
    "../node_modules/@earendil-works/pi-ai/dist/providers/openai.js",
    import.meta.resolve("@okouai/pi-agent-runtime/node"),
  );
  const sdk: unknown = await import(sdkUrl.href);
  if (
    typeof sdk !== "object" ||
    sdk === null ||
    !("openaiProvider" in sdk) ||
    typeof sdk.openaiProvider !== "function"
  ) {
    throw new Error("Missing SDK provider");
  }
  const provider: unknown = sdk.openaiProvider();
  if (
    typeof provider !== "object" ||
    provider === null ||
    !("getModels" in provider) ||
    typeof provider.getModels !== "function"
  ) {
    throw new Error("Missing SDK catalog");
  }
  const models: unknown = provider.getModels();
  if (!Array.isArray(models)) {
    throw new Error("Invalid SDK catalog");
  }
  const model: unknown = models.find((item: unknown) => {
    return (
      typeof item === "object" &&
      item !== null &&
      "id" in item &&
      item.id === "gpt-5.6-luna"
    );
  });
  if (typeof model !== "object" || model === null) {
    throw new Error("Missing Luna");
  }
  const descriptor = Object.getOwnPropertyDescriptor(model, "thinkingLevelMap");
  Object.defineProperty(model, "thinkingLevelMap", {
    value: { low: value },
    configurable: true,
    writable: true,
  });
  onTestFinished(() => {
    if (descriptor) {
      Object.defineProperty(model, "thinkingLevelMap", descriptor);
    } else {
      Reflect.deleteProperty(model, "thinkingLevelMap");
    }
  });
}

describe("Pi memory Stage 1 worker", () => {
  it("leaves switch-off legacy work unclaimed before any download or provider call", async () => {
    const enabledStorage = createStorageFixture();
    const disabledStorage = createStorageFixture({ piMemoryEnabled: false });
    const enabledSessionId = randomUUID();
    const enabled = await enabledStorage.seed({
      piSessionId: enabledSessionId,
      raw: settledHistory(enabledSessionId, "enabled owner keeps learning"),
    });
    const disabledSessionId = randomUUID();
    const disabled = await disabledStorage.seed({
      piSessionId: disabledSessionId,
      raw: settledHistory(
        disabledSessionId,
        "disabled owner never reaches the provider",
      ),
      retryCount: 2,
    });
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
      context.mocks.s3.send.mock.calls.some(([command]) => {
        return (
          command instanceof GetObjectCommand &&
          command.input.Key === disabled.objectKey
        );
      }),
    ).toBeFalsy();
    await expect(inspect(enabled)).resolves.toMatchObject({
      status: "succeeded",
      retry_count: 0,
      last_error_class: null,
    });
    // Unscheduled legacy work remains pending with its attempt count untouched.
    await expect(inspect(disabled)).resolves.toStrictEqual({
      status: "pending",
      retry_count: 2,
      retry_at: null,
      successful_source_history_hash: null,
      last_error_class: null,
      raw_memory: null,
      rollout_summary: null,
      rollout_slug: null,
    });
    await expect(inspectUsage(disabledStorage)).resolves.toStrictEqual([]);

    // A settled switch-off candidate is not due again on the next tick.
    await expect(runScoped(disabledStorage)).resolves.toMatchObject({
      scanned: 0,
      claimed: 0,
      terminalFailure: 0,
    });
    expect(provider.calls).toHaveLength(1);
  });

  it("selects the OpenRouter region from each work owner's switch in one batch", async () => {
    const selectedModel = "gpt-5.6-luna";
    await seedBuiltInModelCandidateKeys(context, selectedModel);
    const primary = await resolveBuiltInModelRouteFixture(
      context,
      selectedModel,
    );
    if (!primary || primary.provider_type !== "openai-api-key") {
      throw new Error("Expected primary OpenAI route");
    }
    const storages = [createStorageFixture(), createStorageFixture()];
    for (const [index, storage] of storages.entries()) {
      const piSessionId = randomUUID();
      await storage.seed({
        piSessionId,
        raw: settledHistory(piSessionId, `regional owner ${index}`),
      });
      await updateFeatureSwitchesForUser(
        context,
        { orgId: storage.org_id, userId: storage.user_id },
        {
          [FeatureSwitchKey.OpenRouterUsRouting]: index === 0,
        },
      );
    }
    const provider = installProvider();
    await withBuiltInModelRuntimeRouteCandidateUnavailableForTest(
      {
        selectedModel,
        providerType: primary.provider_type,
        upstreamModel: primary.upstream_model,
      },
      async () => {
        const result = await accept(
          stage1Client(storages).extract({ headers: stage1Headers() }),
          [200],
        );
        expect(result.body).toMatchObject({
          success: true,
          scanned: 2,
          claimed: 2,
          succeeded: 2,
          retryableFailure: 0,
          terminalFailure: 0,
        });
      },
    );
    expect(provider.calls).toHaveLength(2);
    for (const [index, host] of [
      "us.openrouter.ai",
      "openrouter.ai",
    ].entries()) {
      const invocation = provider.calls.find((call) => {
        return JSON.stringify(call.request).includes(`regional owner ${index}`);
      });
      expect(invocation?.url).toBe(`https://${host}/api/v1/responses`);
      expect(invocation?.request).toMatchObject({
        model: "openai/gpt-5.6-luna",
      });
    }
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

  it("returns all-zero counters without touching pending work when disabled", async () => {
    const storage = createStorageFixture();
    const fixture = await storage.seed({
      raw: settledHistory(randomUUID(), INPUT_SECRET),
    });
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

  it("preserves Stage 1 route counters and results when explicitly enabled", async () => {
    const storage = createStorageFixture();
    const piSessionId = randomUUID();
    const fixture = await storage.seed({
      piSessionId,
      raw: settledHistory(piSessionId, "perform bounded memory extraction"),
    });
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
    await expect(inspect(fixture)).resolves.toMatchObject({
      status: "succeeded",
    });
  });

  it.each([
    SESSION_HISTORY_ENCODING_IDENTITY,
    SESSION_HISTORY_ENCODING_GZIP,
    SESSION_HISTORY_ENCODING_ZSTD,
  ] as const)(
    "decodes %s, redacts both boundaries, and records background usage",
    async (encoding) => {
      const storage = createStorageFixture();
      const fixtures: CandidateFixture[] = [];
      {
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
          model: "gpt-5.6-luna",
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
          status: "succeeded",
          raw_memory: "safe surrounding text [REDACTED_SECRET]",
          rollout_summary: "Authorization: [REDACTED_SECRET]",
          rollout_slug: "pi-stage1-result",
        });
      }
      const usage = await inspectUsage(storage);
      expect(usage.length).toBeGreaterThanOrEqual(3);
      expect(usage).toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({
            run_id: null,
            provider: "gpt-5.6-luna",
            category: "tokens.input",
          }),
          expect.objectContaining({
            run_id: null,
            provider: "gpt-5.6-luna",
            category: "tokens.output",
          }),
        ]),
      );
      await expect(runScoped(storage)).resolves.toMatchObject({ claimed: 0 });
    },
  );

  it.each(["unmeasurable", "over_budget"])(
    "settles a final %s SDK payload once without HTTP, usage or a success watermark",
    async (failure) => {
      await corruptStage1CatalogPayload(
        failure === "unmeasurable"
          ? { recursive: null }
          : "overhead ".repeat(260_000),
      );
      const storage = createStorageFixture();
      const piSessionId = randomUUID();
      const fixture = await storage.seed({
        piSessionId,
        raw: settledHistory(piSessionId, "retain human decision"),
      });
      const provider = installProvider();
      const result = await runScoped(storage);
      expect(
        provider.calls.map((call) => {
          return call.url;
        }),
      ).toStrictEqual([]);
      expect(result).toMatchObject({
        claimed: 1,
        terminalFailure: 1,
        retryableFailure: 0,
        succeeded: 0,
        succeededNoOutput: 0,
      });
      expect(provider.calls).toHaveLength(0);
      await expect(inspectUsage(storage)).resolves.toStrictEqual([]);
      await expect(inspect(fixture)).resolves.toMatchObject({
        status: "terminal_failure",
        last_error_class:
          failure === "unmeasurable"
            ? "input_payload_unmeasurable"
            : "input_budget_exceeded",
        raw_memory: null,
        successful_source_history_hash: null,
      });
      await expect(runScoped(storage)).resolves.toMatchObject({ claimed: 0 });
      expect(provider.calls).toHaveLength(0);
    },
  );

  it("bills the luna long-context tier from the 272,001 total-input boundary", async () => {
    const below = createStorageFixture();
    const atBoundary = createStorageFixture();
    const belowId = randomUUID();
    const atBoundaryId = randomUUID();
    await below.seed({
      piSessionId: belowId,
      raw: settledHistory(belowId, "total input below the boundary"),
    });
    await atBoundary.seed({
      piSessionId: atBoundaryId,
      raw: settledHistory(atBoundaryId, "total input at the boundary"),
    });
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

  it("isolates malformed and cyclic sources permanently before the provider", async () => {
    if (await runInIsolatedProcess(import.meta.url)) {
      return;
    }
    const storages: ReturnType<typeof createStorageFixture>[] = [];
    const storage = {
      seed: async (
        args: Parameters<ReturnType<typeof createStorageFixture>["seed"]>[0],
      ) => {
        const owner = createStorageFixture();
        storages.push(owner);
        return await owner.seed(args);
      },
    };
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

    const response = await accept(
      stage1Client(storages).extract({ headers: stage1Headers() }),
      [200],
    );
    expect(response.body).toMatchObject({
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

  it.each(["encoded_size", "integrity", "utf8", "gzip", "zstd"])(
    "rejects %s source corruption before extraction",
    async (failure) => {
      const storage = createStorageFixture();
      const piSessionId = randomUUID();
      const fixture = await storage.seed({
        piSessionId,
        raw:
          failure === "utf8"
            ? Buffer.from([0xff, 0xfe])
            : settledHistory(piSessionId, "valid source"),
        encoding:
          failure === "gzip"
            ? SESSION_HISTORY_ENCODING_GZIP
            : failure === "zstd"
              ? SESSION_HISTORY_ENCODING_ZSTD
              : SESSION_HISTORY_ENCODING_IDENTITY,
      });
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
      await expect(inspect(fixture)).resolves.toMatchObject({
        status: "terminal_failure",
        successful_source_history_hash: null,
        last_error_class:
          failure === "encoded_size"
            ? "source_encoded_size_invalid"
            : failure === "integrity"
              ? "source_integrity_invalid"
              : failure === "utf8"
                ? "source_utf8_invalid"
                : "source_decompression_invalid",
      });
    },
  );

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
      scanned: 1,
      claimed: 1,
      sourceExpired: 0,
      sourceActive: 0,
      retryableFailure: 1,
      terminalFailure: 0,
    });
    expect(provider.calls).toHaveLength(0);
    await expect(inspect(expired)).resolves.toMatchObject({
      status: "pending",
      last_error_class: null,
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
      claimed: 1,
      succeeded: 1,
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
      claimed: 0,
      succeeded: 0,
    });
    oldReleased.resolve(undefined);
    await expect(oldWorker).resolves.toMatchObject({ staleDiscarded: 1 });
    await expect(inspect(replacement)).resolves.toMatchObject({
      status: "pending",
      raw_memory: null,
    });
    expect((await inspectUsage(storage)).length).toBeGreaterThanOrEqual(3);
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

  it("claims only two threads for one user without refilling the daily batch", async () => {
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
    const storage = createStorageFixture();
    const piSessionId = randomUUID();
    const fixture = await storage.seed({
      piSessionId,
      raw: settledHistory(piSessionId, "frozen provider boundary"),
    });
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

  it("waits a full hour after a real failed provider attempt", async () => {
    mockNow(new Date("2026-09-14T12:00:00Z"));
    const storage = createStorageFixture();
    const piSessionId = randomUUID();
    const fixture = await storage.seed({
      piSessionId,
      raw: settledHistory(piSessionId, "hourly provider retry"),
    });
    const provider = installProvider(() => {
      return "invalid structured output";
    });
    await expect(runScoped(storage)).resolves.toMatchObject({
      retryableFailure: 1,
    });
    await expect(inspect(fixture)).resolves.toMatchObject({
      retry_at: "2026-09-14T13:00:00.000Z",
    });
    mockNow(new Date("2026-09-14T12:59:59.999Z"));
    await expect(runScoped(storage)).resolves.toMatchObject({ claimed: 0 });
    expect(provider.calls).toHaveLength(1);
    mockNow(new Date("2026-09-14T13:00:00Z"));
    await expect(runScoped(storage)).resolves.toMatchObject({
      claimed: 1,
      retryableFailure: 1,
    });
    expect(provider.calls).toHaveLength(2);
  });

  it("retains the independent eight-call global bound across nine owners", async () => {
    const storages = [];
    for (let index = 0; index < 9; index += 1) {
      const storage = createStorageFixture();
      const piSessionId = randomUUID();
      await storage.seed({
        piSessionId,
        raw: settledHistory(piSessionId, "global capacity"),
      });
      storages.push(storage);
    }
    const provider = installProvider();
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

const lunaApiKeyRoutes = [
  {
    type: "openai-api-key",
    url: "https://api.openai.com/v1/responses",
    model: "gpt-5.6-luna",
    contextWindow: 272_000,
  },
  {
    type: "openrouter-codex",
    url: "https://openrouter.ai/api/v1/responses",
    model: "openai/gpt-5.6-luna",
    contextWindow: 1_050_000,
  },
  {
    type: "vercel-ai-gateway-codex",
    url: "https://ai-gateway.vercel.sh/v1/responses",
    model: "openai/gpt-5.6-luna",
    contextWindow: 272_000,
  },
] as const;
type LunaApiKeyProvider = (typeof lunaApiKeyRoutes)[number]["type"];

function actorFor(storage: StorageFixture) {
  return createBddApi(context).user({
    userId: storage.user_id,
    orgId: storage.org_id,
    orgRole: "org:admin",
  });
}

async function apiKeySource(
  storage: StorageFixture,
  key = "source-openai-key",
  type: LunaApiKeyProvider = "openai-api-key",
  scope: "org" | "member" = "org",
) {
  const actor = actorFor(storage);
  const misc = createMiscRoutesApi(context);
  const result = await misc.upsertOrgModelProvider(
    actor,
    { type, secret: key },
    [200, 201],
  );
  if (result.status !== 200 && result.status !== 201) {
    throw new Error("Missing key fixture");
  }
  if (scope === "member") {
    await storage.action({
      action: "historical-key-owner",
      provider_id: result.body.provider.id,
      scope,
    });
  }
  onTestFinished(async () => {
    if (scope === "member") {
      await storage.action({
        action: "historical-key-owner",
        provider_id: result.body.provider.id,
        scope: "org",
      });
    }
    await misc.deleteOrgModelProvider(actor, type, [204, 404]);
  });
  return {
    modelProvider: type,
    modelProviderId: result.body.provider.id,
    modelProviderCredentialScope: scope,
  } satisfies SourceBinding;
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
      [FeatureSwitchKey.PersonalModelProviderAccounts]: true,
      [FeatureSwitchKey.PersonalSubscriptionPriority]: true,
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

async function activateAnotherCodexAccount(
  storage: StorageFixture,
  identity: string,
) {
  const actor = actorFor(storage);
  await updateFeatureSwitchesForUser(
    context,
    { orgId: storage.org_id, userId: storage.user_id },
    {
      [FeatureSwitchKey.PiMemory]: true,
      [FeatureSwitchKey.PersonalModelProviderAccounts]: true,
      [FeatureSwitchKey.PersonalSubscriptionPriority]: true,
    },
  );
  const auth = createAuthDeviceApiActions(context);
  mockCodexDeviceAuthProvider({ tokenScope: "personal", accountId: identity });
  const started = await auth.requestCodexStart(actor, "personal", [200], {
    mode: "add",
  });
  if (started.status !== 200) {
    throw new Error("Expected device auth start");
  }
  const result = await auth.requestCodexComplete(
    actor,
    started.body.sessionToken,
    [200],
  );
  if (!("status" in result.body) || result.body.status !== "complete") {
    throw new Error("Expected device auth completion");
  }
  await createAuthDeviceSupportApi(
    context,
  ).activatePersonalModelProviderAccount(actor, result.body.provider.id);
}

async function gatewaySource(storage: StorageFixture, mapsLuna = true) {
  createRouteMocks(context).clerk.session(
    storage.user_id,
    storage.org_id,
    "org:admin",
  );
  const created = await accept(
    setupApp({ context, routes: modelProviderGatewayRoutes })(
      modelProviderConnectionsMainContract,
    ).create({
      headers: { authorization: "Bearer clerk-session" },
      body: {
        displayName: "Stage 1 gateway",
        secret: "gateway-only-secret",
        surfaces: [
          {
            protocol: "openai-responses",
            apiBaseUrl: "https://stage1-gateway.example/v1",
            authHeaderName: "x-source-key",
            authHeaderTemplate: "Key {{secret}}",
            modelMappings: mapsLuna
              ? { "gpt-5.6-luna": "mapped-luna" }
              : { "deepseek-v4-flash": "deepseek-only" },
          },
        ],
      },
    }),
    [201],
  );
  const surface = created.body.surfaces[0];
  if (!surface) {
    throw new Error("Missing gateway surface");
  }
  onTestFinished(async () => {
    createRouteMocks(context).clerk.session(
      storage.user_id,
      storage.org_id,
      "org:admin",
    );
    await accept(
      setupApp({ context, routes: modelProviderGatewayRoutes })(
        modelProviderConnectionsByIdContract,
      ).delete({
        headers: { authorization: "Bearer clerk-session" },
        params: { id: created.body.id },
      }),
      [204],
    );
  });
  return {
    modelProvider: "custom-openai-responses",
    modelProviderId: surface.id,
    modelProviderCredentialScope: "org",
  } satisfies SourceBinding;
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
        model: "gpt-5.6-luna",
        reasoning: { effort: "low" },
      });
      const usage = await inspectUsage(storage);
      expect(usage.length).toBeGreaterThan(0);
      for (const row of usage) {
        expect(row).toMatchObject({
          run_id: null,
          provider: "gpt-5.6-luna",
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

  it("routes a mixed batch to each original source and charges only built-in", async () => {
    const storages = Array.from({ length: 5 }, () => {
      return createStorageFixture();
    });
    const [builtin, api, codex, gateway, vercel] = storages;
    if (!builtin || !api || !codex || !gateway || !vercel) {
      throw new Error("Missing owners");
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
    await seedSource(api, await apiKeySource(api), "api evidence");
    await seedSource(codex, subscription.binding, "codex evidence");
    await seedSource(gateway, await gatewaySource(gateway), "gateway evidence");
    await seedSource(
      vercel,
      await apiKeySource(vercel, "vercel-owned-key", "vercel-ai-gateway-codex"),
      "vercel evidence",
    );
    const provider = installSourceProvider();
    const result = await accept(
      stage1Client(storages).extract({ headers: stage1Headers() }),
      [200],
    );
    expect(result.body).toMatchObject({
      succeeded: 5,
      terminalFailure: 0,
      retryableFailure: 0,
    });
    expect(provider.calls).toHaveLength(5);
    const callFor = (content: string) => {
      const call = provider.calls.find((call) => {
        return JSON.stringify(call.request).includes(content);
      });
      if (!call) {
        throw new Error("Missing source HTTP request");
      }
      return call;
    };
    const apiCall = callFor("api evidence");
    expect(apiCall.url).toBe("https://api.openai.com/v1/responses");
    expect(apiCall.headers.get("authorization")).toBe(
      "Bearer source-openai-key",
    );
    const vercelCall = callFor("vercel evidence");
    expect(vercelCall.url).toBe("https://ai-gateway.vercel.sh/v1/responses");
    expect(vercelCall.headers.get("authorization")).toBe(
      "Bearer vercel-owned-key",
    );
    expect(vercelCall.request).toMatchObject({ model: "openai/gpt-5.6-luna" });
    const native = callFor("codex evidence");
    expect(native.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(native.headers.get("authorization")).toBe(
      `Bearer ${subscription.token}`,
    );
    expect(native.headers.get("chatgpt-account-id")).toBe(
      subscription.identity,
    );
    expect(native.request).toMatchObject({
      instructions: expect.any(String),
      text: { format: { type: "json_schema", strict: true } },
    });
    expect(native.request).not.toHaveProperty("max_output_tokens");
    const custom = callFor("gateway evidence");
    expect(custom.url).toBe("https://stage1-gateway.example/v1/responses");
    expect(custom.headers.get("x-source-key")).toBe("Key gateway-only-secret");
    expect(custom.headers.get("authorization")).toBeNull();
    expect(custom.request).toMatchObject({ model: "mapped-luna" });
    for (const call of provider.calls) {
      expect(call.request).toMatchObject({ reasoning: { effort: "low" } });
      expect(call.request).not.toHaveProperty("service_tier");
      expect(call.request).not.toHaveProperty("tools");
      if (call !== custom && call !== vercelCall) {
        expect(call.request).toMatchObject({ model: "gpt-5.6-luna" });
      }
    }
    expect((await inspectUsage(builtin)).length).toBeGreaterThan(0);
    for (const storage of [api, codex, gateway, vercel]) {
      await expect(inspectUsage(storage)).resolves.toStrictEqual([]);
    }
  });

  it.each(lunaApiKeyRoutes)(
    "keeps the exact $type key after default changes and surviving-key rotation",
    async ({ type, url }) => {
      const storage = createStorageFixture();
      const source = await apiKeySource(storage, "original-key", type);
      const actor = actorFor(storage);
      const runs = createRunsApi(context);
      await runs.updateOrgModelPolicies(actor, [
        {
          model: "gpt-5.6-luna",
          isDefault: true,
          defaultProviderType: type,
          credentialScope: "org",
          modelProviderId: source.modelProviderId,
        },
      ]);
      await seedSource(storage, source);
      const rotated = await apiKeySource(storage, "rotated-key", type);
      expect(rotated.modelProviderId).toBe(source.modelProviderId);
      const replacement = await apiKeySource(
        storage,
        "new-default-key",
        type === "openrouter-codex" ? "openai-api-key" : "openrouter-codex",
      );
      await runs.updateOrgModelPolicies(actor, [
        {
          model: "gpt-5.6-luna",
          isDefault: true,
          defaultProviderType: replacement.modelProvider,
          credentialScope: "org",
          modelProviderId: replacement.modelProviderId,
        },
      ]);
      expect(
        (await createMiscRoutesApi(context).listModelPolicies(actor)).policies,
      ).toContainEqual(
        expect.objectContaining({
          model: "gpt-5.6-luna",
          isDefault: true,
          modelProviderId: replacement.modelProviderId,
        }),
      );
      const provider = installSourceProvider();
      await expect(runScoped(storage)).resolves.toMatchObject({ succeeded: 1 });
      expect(provider.calls).toHaveLength(1);
      expect(provider.calls[0]?.headers.get("authorization")).toBe(
        "Bearer rotated-key",
      );
      expect(provider.calls[0]?.url).toBe(url);
      await expect(inspectUsage(storage)).resolves.toStrictEqual([]);
    },
  );

  it.each(lunaApiKeyRoutes)(
    "cannot replace a deleted $type ID with a same-type provider",
    async ({ type }) => {
      const storage = createStorageFixture();
      const source = await apiKeySource(storage, "deleted-key", type);
      const candidate = await seedSource(storage, source);
      await createMiscRoutesApi(context).deleteOrgModelProvider(
        actorFor(storage),
        type,
        [204],
      );
      const replacement = await apiKeySource(storage, "replacement-key", type);
      expect(replacement.modelProviderId).not.toBe(source.modelProviderId);
      const provider = installSourceProvider();
      await expect(runScoped(storage)).resolves.toMatchObject({
        terminalFailure: 1,
      });
      expect(provider.calls).toHaveLength(0);
      await expect(inspect(candidate)).resolves.toMatchObject({
        last_error_class: "credential_unavailable",
        successful_source_history_hash: null,
      });
      await expect(runScoped(storage)).resolves.toMatchObject({ claimed: 0 });
      await expect(inspectUsage(storage)).resolves.toStrictEqual([]);
    },
  );

  it.each(["org", "member"] as const)(
    "rejects a Vercel key whose %s owner disagrees with the source scope",
    async (scope) => {
      const storage = createStorageFixture();
      const source = await apiKeySource(
        storage,
        "wrong-scope-key",
        "vercel-ai-gateway-codex",
        scope,
      );
      const candidate = await seedSource(storage, {
        ...source,
        modelProviderCredentialScope: scope === "org" ? "member" : "org",
      });
      const provider = installSourceProvider();
      await expect(runScoped(storage)).resolves.toMatchObject({
        terminalFailure: 1,
      });
      expect(provider.calls).toHaveLength(0);
      await expect(inspect(candidate)).resolves.toMatchObject({
        last_error_class: "credential_unavailable",
        successful_source_history_hash: null,
      });
      await expect(inspectUsage(storage)).resolves.toStrictEqual([]);
    },
  );

  it("rejects a Vercel provider ID owned by another organization", async () => {
    const storage = createStorageFixture();
    const foreign = createStorageFixture();
    await seedSource(
      storage,
      await apiKeySource(foreign, "foreign-key", "vercel-ai-gateway-codex"),
    );
    const provider = installSourceProvider();
    await expect(runScoped(storage)).resolves.toMatchObject({
      terminalFailure: 1,
    });
    expect(provider.calls).toHaveLength(0);
    await expect(inspectUsage(storage)).resolves.toStrictEqual([]);
    await expect(inspectUsage(foreign)).resolves.toStrictEqual([]);
  });

  it("does not select today's active subscription for a historical account", async () => {
    const storage = createStorageFixture();
    const original = await codexSource(storage);
    await seedSource(storage, original.binding);
    await activateAnotherCodexAccount(storage, "source-account-b");
    const provider = installSourceProvider();
    await expect(runScoped(storage)).resolves.toMatchObject({ succeeded: 1 });
    expect(provider.calls[0]?.headers.get("chatgpt-account-id")).toBe(
      original.identity,
    );
    expect(provider.calls[0]?.headers.get("authorization")).toBe(
      `Bearer ${original.token}`,
    );
    await expect(inspectUsage(storage)).resolves.toStrictEqual([]);
  });

  it.each([
    "openai-api-key",
    "openrouter-codex",
    "vercel-ai-gateway-codex",
    "codex",
    "gateway",
  ] as const)(
    "never writes %s model credits for no-output, malformed output and replay",
    async (kind) => {
      const storage = createStorageFixture();
      const source =
        kind === "codex"
          ? (await codexSource(storage)).binding
          : kind === "gateway"
            ? await gatewaySource(storage)
            : await apiKeySource(storage, "byok-key", kind);
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
            response_source_id: "byok-replay",
            billing_mode: "byok",
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
    "deepseek-only",
  ])(
    "skips %s without a request, watermark or repeated attempt",
    async (kind) => {
      const storage = createStorageFixture();
      const source: SourceBinding =
        kind === "deepseek-only"
          ? await gatewaySource(storage, false)
          : kind === "wrong-scope"
            ? {
                ...(await apiKeySource(storage)),
                modelProviderCredentialScope: "member",
              }
            : {
                modelProvider:
                  kind === "missing-provider"
                    ? null
                    : kind === "unsupported"
                      ? "anthropic-api-key"
                      : "openai-api-key",
                modelProviderId: kind === "missing-id" ? null : randomUUID(),
                modelProviderCredentialScope:
                  kind === "missing-scope" ? null : "org",
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
    const storage = createStorageFixture();
    const original = await codexSource(storage, "refresh-account-a", true);
    const candidate = await seedSource(storage, original.binding);
    await activateAnotherCodexAccount(storage, "active-account-b");
    const refreshed = makeCodexJwt({
      exp: Math.floor(now() / 1000) + 7200,
      identity: "refreshed-a",
    });
    const refreshes = installRefresh(original.identity, refreshed);
    const provider = installSourceProvider();
    await expect(runScoped(storage)).resolves.toMatchObject({ succeeded: 1 });
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]).toContain("refresh-refresh-account-a");
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.headers.get("authorization")).toBe(
      `Bearer ${refreshed}`,
    );
    expect(provider.calls[0]?.headers.get("chatgpt-account-id")).toBe(
      original.identity,
    );
    await expect(inspectUsage(storage)).resolves.toStrictEqual([]);
    await expect(inspect(candidate)).resolves.toMatchObject({
      status: "succeeded",
    });
  });

  it.each(["disconnected", "refresh-revoked", "provider-revoked"])(
    "settles %s without rapid retries or model credits",
    async (mode) => {
      const storage = createStorageFixture();
      const original = await codexSource(
        storage,
        "revoked-account",
        mode === "refresh-revoked",
      );
      const candidate = await seedSource(storage, original.binding);
      // Keep account controls enabled after the checkpoint fixture's PiMemory setup.
      await updateFeatureSwitchesForUser(
        context,
        { orgId: storage.org_id, userId: storage.user_id },
        {
          [FeatureSwitchKey.PiMemory]: true,
          [FeatureSwitchKey.PersonalModelProviderAccounts]: true,
          [FeatureSwitchKey.PersonalSubscriptionPriority]: true,
        },
      );
      if (mode === "disconnected") {
        await disconnectCodex(storage, original.binding.modelProviderId);
      }
      const refreshes = installRefresh(
        original.identity,
        "unused-token",
        undefined,
        true,
      );
      const provider = installSourceProvider();
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
      await expect(runScoped(storage)).resolves.toMatchObject({
        terminalFailure: 1,
      });
      await expect(inspect(candidate)).resolves.toMatchObject({
        status: "terminal_failure",
        last_error_class: "credential_unavailable",
        successful_source_history_hash: null,
      });
      expect(provider.calls).toHaveLength(0);
      expect(denied).toBe(mode === "provider-revoked" ? 1 : 0);
      expect(refreshes).toHaveLength(mode === "refresh-revoked" ? 1 : 0);
      await expect(runScoped(storage)).resolves.toMatchObject({ claimed: 0 });
      await expect(inspectUsage(storage)).resolves.toStrictEqual([]);
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
          [FeatureSwitchKey.PersonalModelProviderAccounts]: true,
          [FeatureSwitchKey.PersonalSubscriptionPriority]: true,
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
    const candidate = await seedSource(storage, await apiKeySource(storage));
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
        modelProvider: "anthropic-api-key",
        modelProviderId: randomUUID(),
        modelProviderCredentialScope: "org",
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
    lunaApiKeyRoutes.flatMap(({ type }) => {
      return (["orgId", "userId"] as const).map((field) => {
        return { type, field };
      });
    }),
  )(
    "rejects a $type $field change while history is being prepared",
    async ({ type, field }) => {
      const storage = createStorageFixture();
      const source = await apiKeySource(storage, "owned-key", type);
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

  it.each(lunaApiKeyRoutes)(
    "revalidates an already prepared $type key after another history download",
    async ({ type, url }) => {
      const storage = createStorageFixture();
      const source = await apiKeySource(storage, "prepared-key", type);
      await seedSource(storage, source, "prepared source one");
      await seedSource(storage, source, "prepared source two");
      const provider = installSourceProvider();
      const read = context.mocks.s3.send.getMockImplementation();
      let downloads = 0;
      context.mocks.s3.send.mockImplementation(
        async (commandValue: unknown) => {
          if (commandValue instanceof GetObjectCommand) {
            downloads += 1;
            if (downloads === 2) {
              const replacement = await apiKeySource(
                storage,
                "rotated-during-preparation",
                type,
              );
              expect(replacement.modelProviderId).toBe(source.modelProviderId);
            }
          }
          return read ? await read(commandValue) : {};
        },
      );
      await expect(runScoped(storage)).resolves.toMatchObject({
        succeeded: 1,
        terminalFailure: 1,
      });
      expect(provider.calls).toHaveLength(1);
      expect(provider.calls[0]?.headers.get("authorization")).toBe(
        "Bearer rotated-during-preparation",
      );
      expect(provider.calls[0]?.url).toBe(url);
      await expect(inspectUsage(storage)).resolves.toStrictEqual([]);
    },
  );

  it("rejects a Vercel key deleted after preparation before sending stale HTTP", async () => {
    const storage = createStorageFixture();
    const type = "vercel-ai-gateway-codex";
    const source = await apiKeySource(storage, "prepared-vercel-key", type);
    await seedSource(storage, source, "source one");
    await seedSource(storage, source, "source two");
    const provider = installSourceProvider();
    const read = context.mocks.s3.send.getMockImplementation();
    let downloads = 0;
    context.mocks.s3.send.mockImplementation(async (commandValue: unknown) => {
      if (commandValue instanceof GetObjectCommand && ++downloads === 2) {
        await createMiscRoutesApi(context).deleteOrgModelProvider(
          actorFor(storage),
          type,
          [204],
        );
      }
      return read ? await read(commandValue) : {};
    });
    await expect(runScoped(storage)).resolves.toMatchObject({
      terminalFailure: 2,
    });
    expect(provider.calls).toHaveLength(0);
    await expect(inspectUsage(storage)).resolves.toStrictEqual([]);
  });

  it("keeps a missing-source candidate behind the existing selection fence", async () => {
    const storage = createStorageFixture();
    const candidate = await seedSource(storage, await apiKeySource(storage));
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
  it("covers every currently servable Luna Pi API-key source", () => {
    const supported = getProvidersForModel("gpt-5.6-luna").filter((type) => {
      return (
        getSecretNameForType(type) !== undefined &&
        isPiExecutionRoute({
          selectedModel: "gpt-5.6-luna",
          modelProviderType: type,
          runtimeProviderType: type,
          codexServiceTier: undefined,
          piEnabled: true,
          codexFastModeEnabled: false,
        })
      );
    });
    expect(supported.sort()).toStrictEqual(
      lunaApiKeyRoutes
        .map(({ type }) => {
          return type;
        })
        .sort(),
    );
  });

  it.each(
    lunaApiKeyRoutes.flatMap((route) => {
      return (["org", "member"] as const).map((scope) => {
        return { ...route, scope };
      });
    }),
  )(
    "uses the exact $scope $type route while company routing is unavailable",
    async ({ type, scope, url, model, contextWindow }) => {
      const storage = createStorageFixture();
      const source = await apiKeySource(
        storage,
        "exact-owned-key",
        type,
        scope,
      );
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
      await expect(
        withBuiltInModelRuntimeRouteUnavailableForTest(
          "gpt-5.6-luna",
          async () => {
            return await runScoped(storage);
          },
        ),
      ).resolves.toMatchObject({ succeeded: 1 });
      expect(provider.calls).toHaveLength(1);
      const call = provider.calls[0];
      expect(call?.url).toBe(url);
      expect(call?.headers.get("authorization")).toBe("Bearer exact-owned-key");
      expect(call?.headers.get("chatgpt-account-id")).toBeNull();
      expect(call?.request).toMatchObject({
        model,
        reasoning: { effort: "low" },
        max_output_tokens: 32_768,
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
    const storage = createStorageFixture();
    const source = await codexSource(storage, "retained-foreground-account");
    const candidate = await seedSource(storage, source.binding);
    const actor = actorFor(storage);
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const runnerGroup = runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await updateFeatureSwitchesForUser(
      context,
      { orgId: storage.org_id, userId: storage.user_id },
      {
        [FeatureSwitchKey.PiLoop]: false,
        [FeatureSwitchKey.PiMemory]: true,
        [FeatureSwitchKey.PersonalModelProviderAccounts]: true,
        [FeatureSwitchKey.PersonalSubscriptionPriority]: true,
      },
    );
    await runs.updateOrgModelPolicies(actor, [
      {
        model: "gpt-5.6-luna",
        isDefault: true,
        defaultProviderType: "codex-oauth-token",
        credentialScope: "member",
        modelProviderId: null,
      },
    ]);
    const agent = await bdd.createAgent(actor, {
      displayName: "Retained source account",
      visibility: "private",
    });
    const sent = await createChatFilesBddApi(context).requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        prompt: "active foreground source",
        model: "gpt-5.6-luna",
      },
      [201],
    );
    if (sent.status !== 201 || !sent.body.runId) {
      throw new Error("Expected admitted foreground run");
    }
    const runId = sent.body.runId;
    onTestFinished(async () => {
      await runs.requestCancelRun(actor, runId, [200]);
      // Cancellation schedules chat writes that must settle before fixture deletion.
      await flushWaitUntilForTest();
    });
    const foregroundState = await runs.readRun(actor, runId);
    expect(foregroundState.status, JSON.stringify(foregroundState)).toBe(
      "pending",
    );
    await runs.heartbeatRunner(runnerGroup);
    const claim = await runs.claimRunnerJob(runId);
    expect(
      claim.secretConnectorMetadataMap?.CHATGPT_ACCESS_TOKEN?.sourceId,
    ).toBe(source.binding.modelProviderId);
    await disconnectCodex(storage, source.binding.modelProviderId);
    if (!claim.encryptedSecrets) {
      throw new Error("Expected retained runtime envelope");
    }
    // This suite uses a separate storage bucket, which is part of catalog identity.
    await installApiTestConnectorCatalog();
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
      headers: { "ChatGPT-Account-ID": source.identity },
    });
    const provider = installSourceProvider();
    await expect(runScoped(storage)).resolves.toMatchObject({
      terminalFailure: 1,
    });
    expect(provider.calls).toHaveLength(0);
    await expect(inspect(candidate)).resolves.toMatchObject({
      last_error_class: "credential_unavailable",
      successful_source_history_hash: null,
    });
    await expect(inspectUsage(storage)).resolves.toStrictEqual([]);
  });

  it("rechecks disconnection after serial preparation and before native HTTP", async () => {
    const storage = createStorageFixture();
    const source = await codexSource(storage, "prepared-subscription");
    await seedSource(storage, source.binding, "source one");
    await seedSource(storage, source.binding, "source two");
    await updateFeatureSwitchesForUser(
      context,
      { orgId: storage.org_id, userId: storage.user_id },
      {
        [FeatureSwitchKey.PiMemory]: true,
        [FeatureSwitchKey.PersonalModelProviderAccounts]: true,
        [FeatureSwitchKey.PersonalSubscriptionPriority]: true,
      },
    );
    const provider = installSourceProvider();
    const read = context.mocks.s3.send.getMockImplementation();
    let downloads = 0;
    context.mocks.s3.send.mockImplementation(async (commandValue: unknown) => {
      if (commandValue instanceof GetObjectCommand && ++downloads === 2) {
        await disconnectCodex(storage, source.binding.modelProviderId);
      }
      return read ? await read(commandValue) : {};
    });
    await expect(runScoped(storage)).resolves.toMatchObject({
      terminalFailure: 2,
    });
    expect(provider.calls).toHaveLength(0);
    await expect(inspectUsage(storage)).resolves.toStrictEqual([]);
  });
});

describe("Stage 1 source quota at the model HTTP boundary", () => {
  it.each(nativeMemoryQuotaCases)(
    "$name",
    async ({ payload, raw, status, reason }) => {
      const storage = createStorageFixture();
      const native = await codexSource(storage);
      const candidate = await seedSource(storage, native.binding);
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
      const provider = installSourceProvider();
      const result = await runScoped(storage);
      expect(quotaRequests).toHaveLength(1);
      expect(quotaRequests[0]?.get("authorization")).toBe(
        `Bearer ${native.token}`,
      );
      expect(quotaRequests[0]?.get("chatgpt-account-id")).toBe(native.identity);
      expect(provider.calls).toHaveLength(reason ? 0 : 1);
      if (reason) {
        expect(result).toMatchObject({ retryableFailure: 1, succeeded: 0 });
        await expect(inspect(candidate)).resolves.toMatchObject({
          status: "retryable_failure",
          last_error_class: reason,
          successful_source_history_hash: null,
        });
      } else {
        expect(result).toMatchObject({ succeeded: 1 });
      }
      await expect(inspectUsage(storage)).resolves.toStrictEqual([]);
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
      const storage = createStorageFixture();
      const native = await codexSource(storage);
      await seedSource(storage, native.binding);
      server.use(
        http.get(
          "https://chatgpt.com/backend-api/wham/usage",
          async ({ request }) => {
            if (fault === "network") {
              return HttpResponse.error();
            }
            if (fault === "timeout") {
              const deadline = createDeferredPromise<void>(
                testContext().signal,
              );
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
      await expect(runScoped(storage)).resolves.toMatchObject({ succeeded: 1 });
      expect(provider.calls).toHaveLength(1);
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

test.each([
  ...lunaApiKeyRoutes.map((route) => {
    return route.type;
  }),
  "custom-openai-responses",
] as const)(
  "stage 1 %s keeps API-key quota unknown despite an exhausted company wallet",
  async (type) => {
    const storage = createStorageFixture();
    const source =
      type === "custom-openai-responses"
        ? await gatewaySource(storage)
        : await apiKeySource(storage, "quota-owned-key", type);
    await seedSource(storage, source);
    await seedOrgMetadata({ orgId: storage.org_id, tier: "pro", credits: 0 });
    await seedMemoryQuotaCase(
      { orgId: storage.org_id, userId: storage.user_id },
      nowDate(),
      "pool-zero",
    );
    let metadata = 0;
    server.use(
      http.get("https://chatgpt.com/backend-api/wham/usage", () => {
        metadata++;
        return HttpResponse.json({ rate_limit: { allowed: false } });
      }),
    );
    const provider = installSourceProvider();
    await expect(runScoped(storage)).resolves.toMatchObject({ succeeded: 1 });
    expect(provider.calls).toHaveLength(1);
    expect(metadata).toBe(0);
    await expect(inspectUsage(storage)).resolves.toStrictEqual([]);
  },
);
