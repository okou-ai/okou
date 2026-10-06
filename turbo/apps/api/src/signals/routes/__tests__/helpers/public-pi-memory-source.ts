import { createPhase2Provider } from "../../../../test-fixtures/pi-memory-phase2-credential";
import { seedBuiltInModelKey } from "./runtime-state";
import { createMiscRoutesApi } from "./api-bdd-misc";
import {
  makeCodexAuthJson,
  makeCodexJwt,
  createAuthDeviceApiActions,
  mockCodexDeviceAuthProvider,
} from "./api-bdd-auth-device";
import { createAuthDeviceSupportApi } from "./api-bdd-auth-device-support";
import { personalModelProviderAccountsByIdContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { meModelProviderAccountRoutes } from "../../me-model-provider-accounts";
import { createRouteMocks } from "./route-test";
import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { storageTextFile } from "./api-bdd-storage-files";
import { memoryFilesArchive } from "./public-runner-memory";
import { randomUUID } from "node:crypto";
import { cronExtractPiMemoryStage1Contract } from "@okouai/api-contracts/contracts/cron";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect } from "vitest";
import { http, HttpResponse } from "msw";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../../lib/env";
import { mockNow, now, withNowScopeForTest } from "../../../../lib/time";
import { server } from "../../../../mocks/server";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { cronExtractPiMemoryStage1RoutesForTest } from "../../cron-extract-pi-memory-stage1";
import { createPublicFirewallFixture } from "./public-firewall-fixture";
import {
  createChatEventsFixture,
  configureNativeCliArtifact,
} from "./chat-events-fixture";
import { expectCanonicalStorageManifest } from "./api-bdd-runs";
import { updateFeatureSwitchesForUser } from "./feature-switches";
import { completePublicPiHistory } from "./public-pi-history";

/** A completed native source, followed by an independent real next-day admission. */
export function createPublicPiMemorySource(
  context: TestContext,
  options: {
    readonly cashCredits?: 100_000;
    readonly sourceProvider?:
      | "built-in"
      | "openai-api-key"
      | "custom-openai-responses";
    readonly beforeMemoryPublication?: (agentId: string) => Promise<void>;
    readonly sources?: readonly string[];
    readonly memoryFiles?: (
      sources: readonly {
        runId: string;
        threadId: string;
        hash: string;
        completedAt: string;
      }[],
    ) => readonly { path: string; content: string }[];
    readonly memoryFile?: { readonly path: string; readonly content: string };
  } = {},
) {
  const fixture = createPublicFirewallFixture(context);
  fixture.registerOwnedUserDeletion();
  const chat = createChatEventsFixture(context);
  // This route helper configures its own external object store. Initialize it
  // before publishing the real checkpoint transport used by later credentials.
  const misc = createMiscRoutesApi(context);
  const account = `public-memory-${randomUUID()}`;
  let memoryStorageId: string | undefined;
  let sourceMemoryVersionId: string | undefined;
  async function configureSource(subscriptionId: string) {
    if (!fixture.actor.orgId) {
      throw new Error("Expected source organization");
    }
    let sourceModel: "gpt-6-luna" | "gpt-5.6-luna" | "deepseek-v4.1-flash" =
      "gpt-6-luna";
    let sourceProvider:
      | Awaited<ReturnType<typeof createPhase2Provider>>
      | undefined;
    if (options.sourceProvider) {
      // The common consent owner remains real, but must not influence the
      // original built-in/API-key source route in these worker scenarios.
      await disconnect(subscriptionId);
      sourceModel =
        options.sourceProvider === "built-in"
          ? "deepseek-v4.1-flash"
          : "gpt-5.6-luna";
      if (options.sourceProvider === "built-in") {
        await seedBuiltInModelKey(
          context,
          sourceModel,
          fixture.registerCleanup,
        );
      } else {
        sourceProvider = await createPhase2Provider(
          context,
          { orgId: fixture.actor.orgId, userId: fixture.actor.userId },
          options.sourceProvider,
          "org",
          { registerCleanup: fixture.registerCleanup, miscApi: misc },
        );
      }
      await chat.api.updateOrgModelPolicies(fixture.actor, [
        {
          model: sourceModel,
          preferred: true,
          defaultProviderType: options.sourceProvider,
          credentialScope: "org",
          modelProviderId:
            options.sourceProvider === "custom-openai-responses"
              ? null
              : (sourceProvider?.binding.modelProviderId ?? null),
          ...(options.sourceProvider === "custom-openai-responses"
            ? {
                modelProviderSurfaceId: sourceProvider?.binding.modelProviderId,
              }
            : {}),
        },
      ]);
    }
    return { sourceModel, sourceProvider };
  }
  function sourceIdentity(model: string) {
    return {
      providerType: options.sourceProvider ?? "codex-oauth-token",
      model,
      credentialScope: options.sourceProvider ? "org" : "member",
    };
  }
  async function prepare(at: Date) {
    // Callers schedule the first work one day ahead. A new Thread's activity
    // uses the database clock, so creating it under a past app clock cannot
    // make it satisfy the worker's six-hour idle boundary.
    const sourceTime = at.getTime() - 24 * 3_600_000;
    mockNow(sourceTime);
    chat.chatCallbacks.acceptChatObjectStorage();
    chat.chatCallbacks.disableVapid();
    chat.api.acceptStorageDownloads();
    chat.api.acceptTelemetryIngest();
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    configureNativeCliArtifact();
    const runnerGroup = chat.api.configureRunnerGroup();
    await fixture.fund(fixture.actor, options.cashCredits);
    if (!fixture.actor.orgId) {
      throw new Error("Expected an owned organization");
    }
    await updateFeatureSwitchesForUser(
      context,
      { ...fixture.actor, orgId: fixture.actor.orgId },
      {
        [FeatureSwitchKey.PiMemory]: true,
      },
    );
    // Device consent is committed against the database wall clock. Authenticate
    // in that clock domain, then restore the historical source clock unchanged.
    const subscription = await withNowScopeForTest(async () => {
      return await chat.configureSubscriptionPiModel(fixture.actor, {
        accountId: account,
        refreshToken: `refresh-${account}`,
        accessTokenExpiresAt:
          Math.floor(Math.max(now(), at.getTime()) / 1000) + 72 * 3600,
      });
    });
    const { sourceModel, sourceProvider } = await configureSource(
      subscription.accountSourceId,
    );
    const agent = await chat.bdd.createAgent(fixture.actor, {
      displayName: "Public Memory source",
      visibility: "private",
    });
    fixture.registerAgent(agent.agentId);
    chat.mockPiCheckpointObjectStore();
    const sources: {
      runId: string;
      threadId: string;
      hash: string;
      objectKey: string;
      completedAt: string;
    }[] = [];
    let publishedMemory: { versionId: string; archiveKey: string } | undefined;
    for (const content of options.sources ?? [
      "A completed source for lease and quota behavior",
    ]) {
      const source = await chat.sendChatRun(fixture.actor, {
        agentId: agent.agentId,
        prompt: "Remember this source",
        model: sourceModel,
      });
      fixture.registerRun(source.runId);
      const claimed = await chat.claimChatRun(runnerGroup, source.runId);
      fixture.registerClaim(source.runId, claimed.claim.sandboxToken);
      expect(claimed.claim.cliAgentType).toBe("pi");
      expect(claimed.claim.piSessionId).toBe(source.threadId);
      const memory = expectCanonicalStorageManifest(
        claimed.claim.storageManifest,
      )?.storageMounts.find((mount) => {
        return mount.name === "memory" && mount.storageId;
      });
      if (!memory) {
        throw new Error("Expected the real source Memory owner");
      }
      memoryStorageId = memory.storageId;
      sourceMemoryVersionId = memory.versionId;
      const history = await completePublicPiHistory(
        context,
        source,
        claimed.sandboxHeaders,
        content,
      );
      const completed = await chat.api.readRun(fixture.actor, source.runId);
      expect(completed.status).toBe("completed");
      expect(completed.source).toMatchObject(sourceIdentity(sourceModel));
      if (!completed.completedAt) {
        throw new Error("Expected source completion time");
      }
      sources.push({
        ...source,
        ...history,
        completedAt: completed.completedAt,
      });
    }
    if (!memoryStorageId) {
      throw new Error("Expected at least one real source");
    }
    mockNow(at);
    const trigger = await chat.sendChatRun(fixture.actor, {
      agentId: agent.agentId,
      prompt: "Request the next Memory day",
      model: sourceModel,
    });
    fixture.registerRun(trigger.runId);
    let triggerToken: string | undefined;
    const memoryFiles =
      options.memoryFiles?.(sources) ??
      (options.memoryFile ? [options.memoryFile] : []);
    if (memoryFiles.length > 0) {
      // Publish only after this existing trigger has prepared its empty mount.
      // Otherwise its admission caches the new archive URL before Phase2 can
      // exercise the original external presign interruption boundary.
      const claimed = await chat.claimChatRun(runnerGroup, trigger.runId);
      triggerToken = claimed.claim.sandboxToken;
      fixture.registerClaim(trigger.runId, triggerToken);
      const memory = expectCanonicalStorageManifest(
        claimed.claim.storageManifest,
      )?.storageMounts.find((mount) => {
        return mount.name === "memory" && mount.storageId;
      });
      if (!memory) {
        throw new Error("Expected the existing trigger's Memory mount");
      }
      expect(memory.storageId).toBe(memoryStorageId);
      expect(memory.empty).toBeTruthy();
      await options.beforeMemoryPublication?.(agent.agentId);
      const files = memoryFiles.map((file) => {
        return storageTextFile(file.path, file.content);
      });
      const archive = memoryFilesArchive(memoryFiles);
      const objects = new Map<string, Buffer>();
      const transport = context.mocks.s3.send.getMockImplementation();
      if (!transport) {
        throw new Error("Expected the source object transport");
      }
      context.mocks.s3.send.mockImplementation((command: unknown) => {
        if (
          (command instanceof GetObjectCommand ||
            command instanceof HeadObjectCommand) &&
          command.input.Key &&
          objects.has(command.input.Key)
        ) {
          const bytes = objects.get(command.input.Key);
          if (!bytes) {
            throw new Error("Expected owned Memory bytes");
          }
          return Promise.resolve({
            ContentLength: bytes.length,
            Body: {
              async *[Symbol.asyncIterator]() {
                yield bytes;
              },
            },
          });
        }
        return transport(command);
      });
      const prepared = await chat.webhooks.requestAgentStoragePrepare(
        { runId: trigger.runId, storageId: memory.storageId, files },
        claimed.sandboxHeaders,
        [200],
      );
      if (prepared.status !== 200 || !prepared.body.uploads) {
        throw new Error("Expected Memory upload targets");
      }
      objects.set(prepared.body.uploads.archive.key, archive);
      objects.set(
        prepared.body.uploads.manifest.key,
        Buffer.from(
          JSON.stringify({
            version: 1,
            files,
            createdAt: new Date(0).toISOString(),
          }),
        ),
      );
      await chat.webhooks.requestAgentStorageCommit(
        {
          runId: trigger.runId,
          storageId: memory.storageId,
          versionId: prepared.body.versionId,
          files,
        },
        claimed.sandboxHeaders,
        [200],
      );
      publishedMemory = {
        versionId: prepared.body.versionId,
        archiveKey: prepared.body.uploads.archive.key,
      };
    }
    await chat.api.requestCancelRun(fixture.actor, trigger.runId, [200]);
    if (triggerToken) {
      await chat.webhooks.requestAgentComplete(
        {
          runId: trigger.runId,
          exitCode: 1,
          error: "Owned Memory writer cancelled",
        },
        { authorization: `Bearer ${triggerToken}` },
        [200],
      );
    }
    await flushWaitUntilForTest();
    return {
      memoryStorageId,
      sourceAgentId: agent.agentId,
      sourceMemoryVersionId,
      sources,
      triggerRunId: trigger.runId,
      subscription,
      sourceProvider,
      publishedMemory,
      orgId: fixture.actor.orgId,
      userId: fixture.actor.userId,
    };
  }
  async function extract() {
    if (!memoryStorageId) {
      throw new Error("Expected the source Memory mount");
    }
    mockEnv("PI_MEMORY_BACKGROUND_WORKERS_ENABLED", "true");
    const secret = "test-public-memory-source";
    mockEnv("CRON_SECRET", secret);
    const response = await accept(
      setupApp({
        context,
        routes: cronExtractPiMemoryStage1RoutesForTest({
          memoryStorageIds: [memoryStorageId],
        }),
      })(cronExtractPiMemoryStage1Contract).extract({
        headers: { authorization: `Bearer ${secret}` },
      }),
      [200],
    );
    return response.body;
  }
  function installExtractionProvider(
    output:
      | string
      | readonly { rawMemory: string; rolloutSummary: string }[] = "raw memory",
  ) {
    let index = 0;
    server.use(
      http.post(
        options.sourceProvider === "built-in"
          ? "https://openrouter.ai/api/v1/responses"
          : options.sourceProvider === "openai-api-key"
            ? "https://api.openai.com/v1/responses"
            : options.sourceProvider === "custom-openai-responses"
              ? "https://phase2-gateway.example/v1/responses"
              : /https:\/\/chatgpt\.com\/.*\/responses/u,
        async ({ request }) => {
          await request.arrayBuffer();
          const selected =
            typeof output === "string"
              ? { rawMemory: output, rolloutSummary: "rollout summary" }
              : output[index++];
          if (!selected) {
            throw new Error("Unexpected source extraction request");
          }
          const text = JSON.stringify({
            raw_memory: selected.rawMemory,
            rollout_summary: selected.rolloutSummary,
            rollout_slug: "source",
          });
          // The Codex reader cancels after the terminal event. Close the source
          // before cancellation can wait on an unconsumed response clone.
          return new HttpResponse(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(extractionSse(text)),
                );
                controller.close();
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      ),
    );
  }
  async function configureOrgApiKey(secret: string) {
    fixture.registerCleanup(async () => {
      await misc.deleteOrgModelProvider(
        fixture.actor,
        "openai-api-key",
        [204, 404],
      );
    });
    await misc.upsertOrgModelProvider(
      fixture.actor,
      { type: "openai-api-key", secret },
      [200, 201],
    );
  }
  async function disconnect(accountId: string) {
    createRouteMocks(context).clerk.session(
      fixture.actor.userId,
      fixture.actor.orgId,
      fixture.actor.orgRole,
    );
    await accept(
      setupApp({ context, routes: meModelProviderAccountRoutes })(
        personalModelProviderAccountsByIdContract,
      ).delete({
        headers: { authorization: "Bearer clerk-session" },
        params: { id: accountId },
      }),
      [204],
    );
  }
  async function expireCredential(accountId: string) {
    const accessToken = makeCodexJwt({
      exp: Math.floor(now() / 1000) - 60,
      identity: account,
    });
    const result = await misc.upsertPersonalModelProvider(
      fixture.actor,
      {
        type: "codex-oauth-token",
        authMethod: "auth_json",
        secrets: {
          CODEX_AUTH_JSON: makeCodexAuthJson({
            accessToken,
            accountId: account,
            refreshToken: `refresh-${account}`,
          }),
        },
      },
      [200],
    );
    if (result.status !== 200) {
      throw new Error("Expected credential replacement");
    }
    expect(result.body.provider.id).toBe(accountId);
  }
  async function activateAccount(identity: string) {
    return await withNowScopeForTest(async () => {
      const oauth = mockCodexDeviceAuthProvider({
        tokenScope: "personal",
        accountId: identity,
        accessTokenExpiresAt: Math.floor(now() / 1000) + 72 * 3600,
      });
      const auth = createAuthDeviceApiActions(context);
      const started = await auth.requestCodexStart(
        fixture.actor,
        "personal",
        [200],
        { mode: "add" },
      );
      if (started.status !== 200) {
        throw new Error("Expected device auth start");
      }
      const result = await auth.requestCodexComplete(
        fixture.actor,
        started.body.sessionToken,
        [200],
      );
      if (!("status" in result.body) || result.body.status !== "complete") {
        throw new Error("Expected device auth completion");
      }
      await createAuthDeviceSupportApi(
        context,
      ).activatePersonalModelProviderAccount(
        fixture.actor,
        result.body.provider.id,
      );
      return { oauth, accountSourceId: result.body.provider.id, identity };
    });
  }
  return {
    ...fixture,
    misc,
    prepare,
    extract,
    installExtractionProvider,
    account,
    disconnect,
    configureOrgApiKey,
    expireCredential,
    activateAccount,
  };
}

function extractionSse(
  text: string,
  sequence = 1,
  usage = {
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
