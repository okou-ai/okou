import { createHash, randomUUID } from "node:crypto";
import { getProviderRuntimeModel } from "@okouai/api-contracts/contracts/model-providers";
import { gzipSync, zstdCompressSync } from "node:zlib";
import { isChatRunTerminalEventType } from "@okouai/api-contracts/contracts/chat-events";
import {
  PI_API_FIRST_TURN_SESSION_MAX_BYTES,
  PI_SANDBOX_INSTALLED_CLI_MIN_VERSION,
  RESUME_SESSION_HISTORY_MAX_BYTES,
  piApiFirstTurnManifestSchema,
} from "@okouai/api-contracts/contracts/runners";
import {
  PI_AGENT_RUNTIME_VERSION,
  PI_SESSION_CONSTRUCTION_DIGEST,
} from "@okouai/pi-agent-runtime";
import { MemoryPiSession } from "@okouai/pi-agent-runtime/node";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { env, mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import {
  readRunUsageEventsFixture,
  replacePiSessionHistoryInlineFixture,
  replacePiSessionHistoryJsonlFixture,
} from "../../../test-fixtures/chat-events";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { readThreadSessionConversation } from "./helpers/runtime-state";
import {
  createChatEventsFixture,
  claimEnvironment,
  modelProviderSecretPlaceholder,
  totalChargedCredits,
  createGptUsagePricingResolution,
  createPiUsagePricingResolution,
  eventBackedContents,
  type PiCheckpointS3Command,
  piS3ObjectKey,
  PI_RESOURCE_ARCHIVE_DOWNLOAD_URL,
} from "./helpers/chat-events-fixture";

const context = testContext();
const {
  api,
  chat,
  webhooks,
  entitledChatActor,
  configureBuiltInPiModel,
  configureBuiltInPiModelOnOpenRouter,
  sendChatRun,
  sendWaitingChatInput,
  claimChatRun,
  waitForRunStatus,
  completeChatRunOk,
  failChatRun,
  cancelChatRun,
  mockPiCheckpointObjectStore,
  mockPiResourceArchiveDownloads,
  expectPiSandboxHandoff,
  publishPendingPiInstructions,
  completeSandboxFirstPiRun,
  queueCapabilityProvenPiRun,
} = createChatEventsFixture(context);

describe("CHAT-02: model-first provider policies", () => {
  it.each([
    { encoding: "identity", large: false },
    { encoding: "identity", large: true },
    { encoding: "gzip", large: true },
    { encoding: "zstd", large: true },
  ] as const)(
    "references Pi $encoding history (large: $large) without API history or resource IO",
    async ({ encoding, large }) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      await publishPendingPiInstructions(actor, agentId);
      const checkpointObjects = mockPiCheckpointObjectStore();
      let resourceDownloads = 0;
      server.use(
        http.get(PI_RESOURCE_ARCHIVE_DOWNLOAD_URL, () => {
          resourceDownloads += 1;
          return HttpResponse.json(
            { error: "API resources unavailable" },
            { status: 503 },
          );
        }),
      );
      const queued = await queueCapabilityProvenPiRun({
        actor,
        agentId,
        runnerGroup,
        prompt: "/skill:long-session finish in sandbox",
      });
      const run = await queued.launch();
      await flushWaitUntilForTest();
      const claimed = await claimChatRun(runnerGroup, run.runId);
      const session = MemoryPiSession.create({
        cwd: "/home/user/workspace",
        id: run.threadId,
      });
      session.appendMessage({
        role: "user",
        content: "preserve the complete native history",
        timestamp: 1,
      });
      session.appendMessage({
        role: "assistant",
        content: [
          {
            type: "text",
            text: "x".repeat(large ? PI_API_FIRST_TURN_SESSION_MAX_BYTES : 64),
          },
        ],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.6-terra",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      });
      const raw = Buffer.from(session.toJsonl());
      const encoded =
        encoding === "gzip"
          ? gzipSync(raw)
          : encoding === "zstd"
            ? zstdCompressSync(raw)
            : raw;
      const hash = createHash("sha256").update(raw).digest("hex");
      if (large) {
        expect(raw.length).toBeGreaterThan(PI_API_FIRST_TURN_SESSION_MAX_BYTES);
      } else {
        expect(raw.length).toBeLessThan(PI_API_FIRST_TURN_SESSION_MAX_BYTES);
      }
      const invalidHash = createHash("sha256")
        .update(randomUUID())
        .digest("hex");
      await webhooks.requestAgentCheckpointPrepareHistory(
        {
          runId: run.runId,
          hash: invalidHash,
          rawSize: encoding === "identity" ? raw.length : 1,
          encodedSize: encoded.length,
          encoding,
        },
        claimed.sandboxHeaders,
        [200],
      );
      const invalidSuffix =
        encoding === "identity"
          ? "blob"
          : encoding === "gzip"
            ? "blob.gz"
            : "blob.zst";
      checkpointObjects.set(
        `${env("R2_USER_STORAGES_BUCKET_NAME")}/blobs/${invalidHash}.${invalidSuffix}`,
        encoded,
      );
      const invalidCheckpoint = await webhooks.requestAgentComplete(
        {
          runId: run.runId,
          exitCode: 0,
          checkpoint: {
            cliAgentType: "pi",
            cliAgentSessionId: run.threadId,
            cliAgentSessionHistoryHash: invalidHash,
          },
        },
        claimed.sandboxHeaders,
        [400],
        undefined,
        queued.usagePricingResolution,
      );
      expect(JSON.stringify(invalidCheckpoint.body)).toContain(
        encoding === "identity"
          ? "[PI_H2_HASH_MISMATCH]"
          : "[PI_H2_DECOMPRESSION_FAILED]",
      );
      await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
        status: "running",
      });
      await webhooks.requestAgentCheckpointPrepareHistory(
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
      const suffix =
        encoding === "identity"
          ? "blob"
          : encoding === "gzip"
            ? "blob.gz"
            : "blob.zst";
      const blobKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/blobs/${hash}.${suffix}`;
      checkpointObjects.set(blobKey, encoded);
      const completed = await webhooks.requestAgentComplete(
        {
          runId: run.runId,
          exitCode: 0,
          checkpoint: {
            cliAgentType: "pi",
            cliAgentSessionId: run.threadId,
            cliAgentSessionHistoryHash: hash,
          },
        },
        claimed.sandboxHeaders,
        [200],
        undefined,
        queued.usagePricingResolution,
      );
      expect(completed.body).toStrictEqual({
        success: true,
        status: "completed",
      });
      await flushWaitUntilForTest();
      await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
        status: "completed",
      });
      const callsBeforeResume = context.mocks.s3.send.mock.calls.length;
      const resumed = await sendChatRun(
        actor,
        {
          agentId,
          threadId: run.threadId,
          prompt: "continue the long session",
          model: "gpt-5.6-terra",
        },
        queued.usagePricingResolution,
      );
      await flushWaitUntilForTest();
      const { manifest } = expectPiSandboxHandoff(
        resumed.runId,
        checkpointObjects,
      );
      expect(manifest).toMatchObject({
        schemaVersion: 4,
        mode: "sandbox-first",
        outcome: "ownership-transfer",
        baseSession: { sessionId: run.threadId, sha256: hash },
        session: { sessionId: run.threadId, sha256: hash, rawSize: raw.length },
        history: {
          encoding,
          encodedSize: encoded.length,
          url: expect.any(String),
        },
        sandboxEventSequenceStart: 1,
        apiUsage: {
          schemaVersion: 1,
          state: "no-inference",
          sampledAt: expect.any(Number),
        },
      });
      if (manifest.schemaVersion !== 4) {
        throw new Error("Expected a referenced sandbox checkpoint");
      }
      expect(new URL(manifest.history.url).searchParams.get("object")).toBe(
        blobKey,
      );
      expect(resourceDownloads).toBe(0);
      expect(
        context.mocks.s3.send.mock.calls
          .slice(callsBeforeResume)
          .some(([command]) => {
            const candidate = command as PiCheckpointS3Command;
            return (
              candidate.constructor?.name === "GetObjectCommand" &&
              piS3ObjectKey(candidate) === blobKey
            );
          }),
      ).toBeFalsy();
      expect(
        checkpointObjects.has(
          `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${resumed.runId}/session.jsonl`,
        ),
      ).toBeFalsy();
      const resumedClaim = await claimChatRun(runnerGroup, resumed.runId);
      expect(resumedClaim.claim.resumeSession).toMatchObject({
        sessionId: run.threadId,
        historyRef: { hash, encoding, rawSize: raw.length },
      });
      await webhooks.requestAgentCheckpointPrepareHistory(
        {
          runId: resumed.runId,
          hash: "f".repeat(64),
          rawSize: RESUME_SESSION_HISTORY_MAX_BYTES + 1,
          encodedSize: 1,
          encoding,
        },
        resumedClaim.sandboxHeaders,
        [400],
      );
      await cancelChatRun(actor, resumed.runId, resumedClaim.sandboxHeaders);
    },
    30_000,
  );

  it.each([
    "/skill:handoff-skill first  argument\nsecond line",
    " \n\t/skill:handoff-skill first  argument\nsecond line",
    "/unknown-command first  argument\nsecond line",
    "/home/user/workspace/report.txt first  argument\nsecond line",
  ] as const)(
    "hands native input %j to Sandbox with exact fresh and resumed H0",
    async (prompt) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      await publishPendingPiInstructions(actor, agentId);
      const checkpointObjects = mockPiCheckpointObjectStore();
      let resourceDownloads = 0;
      server.use(
        http.get(PI_RESOURCE_ARCHIVE_DOWNLOAD_URL, () => {
          resourceDownloads += 1;
          return HttpResponse.json(
            { error: "API resources unavailable" },
            { status: 503 },
          );
        }),
      );
      const queued = await queueCapabilityProvenPiRun({
        actor,
        agentId,
        runnerGroup,
        prompt,
      });
      let run = await queued.launch();
      let expectedH0: Buffer | undefined;
      const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
      for (const turn of [1, 2]) {
        const originalPrompt = turn === 1 ? prompt : `${prompt}\nresume once`;
        if (turn === 2) {
          run = await sendChatRun(
            actor,
            {
              agentId,
              threadId: run.threadId,
              prompt: originalPrompt,
              model: "gpt-5.6-terra",
            },
            queued.usagePricingResolution,
          );
        }
        await flushWaitUntilForTest();
        const manifestKey = `${bucket}/pi-api-first-turn/${run.runId}/manifest.json`;
        const sessionKey = `${bucket}/pi-api-first-turn/${run.runId}/session.jsonl`;
        const manifestBytes = checkpointObjects.get(manifestKey);
        if (!manifestBytes) {
          throw new Error("Expected native-input Sandbox manifest");
        }
        const manifest = piApiFirstTurnManifestSchema.parse(
          JSON.parse(manifestBytes.toString("utf8")),
        );
        let h0: Buffer;
        if (turn === 1) {
          const published = checkpointObjects.get(sessionKey);
          if (!published) {
            throw new Error("Expected fresh sandbox-first session object");
          }
          h0 = published;
          expect(manifest).toMatchObject({
            schemaVersion: 3,
            outcome: "ownership-transfer",
            mode: "sandbox-first",
            baseSession: { sessionId: run.threadId, sha256: null },
            session: {
              sessionId: run.threadId,
              sha256: createHash("sha256").update(h0).digest("hex"),
              rawSize: h0.length,
            },
            sandboxEventSequenceStart: 1,
          });
        } else {
          if (!expectedH0) {
            throw new Error("Expected settled first-turn checkpoint");
          }
          const hash = createHash("sha256").update(expectedH0).digest("hex");
          const blobKey = `${bucket}/blobs/${hash}.blob`;
          expect(manifest).toMatchObject({
            schemaVersion: 4,
            outcome: "ownership-transfer",
            mode: "sandbox-first",
            baseSession: { sessionId: run.threadId, sha256: hash },
            session: {
              sessionId: run.threadId,
              sha256: hash,
              rawSize: expectedH0.length,
            },
            history: {
              encoding: "identity",
              encodedSize: expectedH0.length,
              url: expect.any(String),
            },
            sandboxEventSequenceStart: 1,
          });
          if (manifest.schemaVersion !== 4) {
            throw new Error("Expected referenced resume history");
          }
          expect(new URL(manifest.history.url).searchParams.get("object")).toBe(
            blobKey,
          );
          expect(checkpointObjects.has(sessionKey)).toBeFalsy();
          const referenced = checkpointObjects.get(blobKey);
          if (!referenced) {
            throw new Error("Expected referenced Sandbox checkpoint bytes");
          }
          h0 = referenced;
          expect(h0).toStrictEqual(expectedH0);
        }
        const session = MemoryPiSession.fromJsonl(h0.toString("utf8"));
        expect(session.getSessionId()).toBe(run.threadId);
        expect(session.buildSessionContext().messages).toHaveLength(
          (turn - 1) * 2,
        );
        const writes = context.mocks.s3.send.mock.calls.flatMap(([command]) => {
          const candidate = command as PiCheckpointS3Command;
          const key = piS3ObjectKey(candidate);
          return candidate.constructor?.name === "PutObjectCommand" &&
            (key === sessionKey || key === manifestKey)
            ? [key]
            : [];
        });
        expect(writes).toStrictEqual(
          turn === 1 ? [sessionKey, manifestKey] : [manifestKey],
        );
        expect(resourceDownloads).toBe(0);
        // Public usage summaries omit pending usage, so inspect this run's
        // uniquely owned ledger to prove the handoff itself bills nothing.
        await expect(
          readRunUsageEventsFixture(run.runId),
        ).resolves.toStrictEqual([]);
        const claim = await claimChatRun(runnerGroup, run.runId);
        expect(claim.claim).toMatchObject({
          cliAgentType: "pi",
          piSessionId: run.threadId,
          prompt: originalPrompt,
          piLaunchConfig: {
            apiFirstTurn: {
              sandboxEventSequenceStart: 1,
              requiredPiAgentRuntimeVersion: PI_AGENT_RUNTIME_VERSION,
              minCliVersion: PI_SANDBOX_INSTALLED_CLI_MIN_VERSION,
              requiredPiSessionConstructionDigest:
                PI_SESSION_CONSTRUCTION_DIGEST,
            },
          },
        });

        const sandboxUsage = {
          idempotencyKey: randomUUID(),
          kind: "model" as const,
          provider: "gpt-5.6-terra",
          category: "tokens.output",
          quantity: 2,
        };
        for (const _receipt of [1, 2]) {
          await webhooks.requestAgentUsageEvent(
            { runId: run.runId, events: [sandboxUsage] },
            claim.sandboxHeaders,
            [200],
            queued.usagePricingResolution,
          );
        }

        const answer = `native Sandbox answer ${turn}`;
        // This exercises the external Sandbox checkpoint/completion boundary.
        // pi-agent-loop.test.ts separately runs the real official RPC/AgentSession
        // with a mounted skill and checks its actual expanded provider input.
        await completeSandboxFirstPiRun({
          actor,
          answer,
          checkpointObjects,
          claim,
          prompt: originalPrompt,
          run,
          usagePricingResolution: queued.usagePricingResolution,
        });
        const events = (await chat.listThreadEvents(actor, run.threadId))
          .events;
        expect(
          events
            .filter((event) => {
              return (
                event.runId === run.runId &&
                isChatRunTerminalEventType(event.eventType)
              );
            })
            .map((event) => {
              return event.eventType;
            }),
        ).toStrictEqual(["run.completed"]);
        expect(
          eventBackedContents(events, run.runId).filter((message) => {
            return message.content === answer;
          }),
        ).toHaveLength(1);
        await expect(
          readRunUsageEventsFixture(run.runId),
        ).resolves.toStrictEqual([
          expect.objectContaining({
            provider: "gpt-5.6-terra",
            category: "tokens.output",
            quantity: 2,
            status: "processed",
            billingError: null,
          }),
        ]);
        await expect(
          readThreadSessionConversation(context, run.threadId),
        ).resolves.toMatchObject({ conversation_run_id: run.runId });
        const blob = [...checkpointObjects.entries()]
          .filter(([key]) => {
            return key.startsWith(`${bucket}/blobs/`);
          })
          .at(-1);
        if (!blob) {
          throw new Error("Expected the Sandbox's settled checkpoint");
        }
        expectedH0 = blob[1];
        const settled = MemoryPiSession.fromJsonl(expectedH0.toString("utf8"));
        expect(settled.getSessionId()).toBe(run.threadId);
        expect(settled.isSettledCheckpoint()).toBeTruthy();
        expect(settled.buildSessionContext().messages).toHaveLength(turn * 2);
      }
    },
    90_000,
  );

  it("preserves inline OpenRouter resume bytes in a v3 sandbox handoff", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    if (!actor.orgId) {
      throw new Error("Expected entitled chat actor to have an org");
    }
    const usagePricingResolution = await createGptUsagePricingResolution();
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
    const runnerIdentity = {
      runnerId: randomUUID(),
      heartbeatGeneration: 1,
    };
    await api.requestHeartbeatRunner(true, [200], {
      runnerId: runnerIdentity.runnerId,
      group: runnerGroup,
    });
    const { providerId } = await api.ensureOrgModelProvider(actor);
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-fable-5-1",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);
    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "hold capacity for the resume transfer",
      model: "claude-fable-5-1",
    });
    await flushWaitUntilForTest();
    const anchorState = await api.readRun(actor, anchor.runId);
    if (anchorState.status !== "pending") {
      throw new Error(
        `Expected pending resume anchor: ${JSON.stringify(anchorState)}`,
      );
    }
    const anchorClaim = await api.claimRunnerJob(anchor.runId, {
      runnerIdentity,
    });
    const anchorSandboxHeaders = {
      authorization: `Bearer ${anchorClaim.sandboxToken}`,
    };
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "2");

    const withOpenRouterRoute = await configureBuiltInPiModelOnOpenRouter(
      actor,
      "gpt-5.6-terra",
    );

    const checkpointObjects = mockPiCheckpointObjectStore();
    const firstPrompt = "create a settled Pi checkpoint";
    const first = await withOpenRouterRoute(async () => {
      return await sendChatRun(
        actor,
        {
          agentId,
          prompt: firstPrompt,
          model: "gpt-5.6-terra",
          runOptions: { codexServiceTier: "fast" },
        },
        usagePricingResolution,
      );
    });
    const firstClaim = await api.claimRunnerJob(first.runId, {
      runnerIdentity,
    });
    expect(firstClaim).toMatchObject({
      cliAgentType: "pi",
      piSessionId: first.threadId,
      piModelConfig: {
        provider: "openrouter",
        serviceTier: "priority",
      },
    });
    await completeSandboxFirstPiRun({
      actor,
      answer: "seed the compaction checkpoint",
      checkpointObjects,
      claim: {
        claim: firstClaim,
        sandboxHeaders: {
          authorization: `Bearer ${firstClaim.sandboxToken}`,
        },
      },
      prompt: firstPrompt,
      run: first,
      usagePricingResolution,
    });

    const blobPrefix = `${env("R2_USER_STORAGES_BUCKET_NAME")}/blobs/`;
    const persistedBlobs = [...checkpointObjects.entries()].filter(([key]) => {
      return key.startsWith(blobPrefix) && key.endsWith(".blob");
    });
    expect(persistedBlobs).toHaveLength(1);
    const persistedBlob = persistedBlobs[0];
    if (!persistedBlob) {
      throw new Error("Expected the first Pi run to persist native H1");
    }
    const [h0ObjectKey, firstSessionBytes] = persistedBlob;
    const h0Hash = h0ObjectKey.slice(blobPrefix.length, -".blob".length);
    const resumedH0 = firstSessionBytes.toString("utf8");
    // Current checkpoint APIs persist blobs only; this test-owned historical
    // inline snapshot cannot be constructed through a production endpoint.
    await replacePiSessionHistoryInlineFixture({
      runId: first.runId,
      jsonl: resumedH0,
    });

    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
    const prompt = "preserve this original prompt for official compaction";
    // At capacity the resume prompt waits without a run; the anchor's
    // completion picks the thread and launches it on the OpenRouter route.
    const waitingSecond = await withOpenRouterRoute(async () => {
      return await sendWaitingChatInput(
        actor,
        {
          agentId,
          threadId: first.threadId,
          prompt,
          model: "gpt-5.6-terra",
          runOptions: { codexServiceTier: "fast" },
        },
        usagePricingResolution,
      );
    });
    await withOpenRouterRoute(async () => {
      await completeChatRunOk(anchor.runId, anchorSandboxHeaders, {
        usagePricingResolution,
      });
    });
    const second = await waitingSecond.launchedRun();

    const manifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${second.runId}/manifest.json`;
    const manifestBytes = checkpointObjects.get(manifestKey);
    if (!manifestBytes) {
      throw new Error("Expected resume ownership-transfer manifest");
    }
    const manifest = piApiFirstTurnManifestSchema.parse(
      JSON.parse(manifestBytes.toString("utf8")),
    );
    expect(manifest).toMatchObject({
      schemaVersion: 3,
      outcome: "ownership-transfer",
      mode: "sandbox-first",
      baseSession: { sessionId: first.threadId, sha256: h0Hash },
      session: {
        sessionId: first.threadId,
        sha256: h0Hash,
        rawSize: Buffer.byteLength(resumedH0),
      },
      sandboxEventSequenceStart: 1,
    });
    const publishedH0 = checkpointObjects.get(
      `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${second.runId}/session.jsonl`,
    );
    expect(publishedH0).toStrictEqual(firstSessionBytes);
    expect(manifest.schemaVersion).toBe(3);
    const claim = await api.claimRunnerJob(second.runId, { runnerIdentity });
    const sandboxHeaders = {
      authorization: `Bearer ${claim.sandboxToken}`,
    };
    expect(claim).toMatchObject({
      cliAgentType: "pi",
      piSessionId: first.threadId,
      prompt,
      piModelConfig: {
        provider: "openrouter",
        serviceTier: "priority",
      },
    });
    expect(resumedH0).not.toContain("serviceTier");
    await cancelChatRun(actor, second.runId, sandboxHeaders);
  }, 90_000);

  it.each(["malformed", "mismatched", "cyclic"] as const)(
    "transfers $damage stored Pi history by reference without API parsing",
    async (damage) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      if (!actor.orgId) {
        throw new Error("Expected entitled chat actor to have an org");
      }
      await configureBuiltInPiModel(actor, "deepseek-v4-flash");

      const checkpointObjects = mockPiCheckpointObjectStore();
      const firstPrompt = "create canonical Pi H0";
      const first = await sendChatRun(actor, {
        agentId,
        prompt: firstPrompt,
        model: "deepseek-v4-flash",
      });
      const firstClaim = await claimChatRun(runnerGroup, first.runId);
      // The Sandbox reports no usage for this turn, so any resolution works.
      await completeSandboxFirstPiRun({
        actor,
        answer: "canonical H0 answer",
        checkpointObjects,
        claim: firstClaim,
        prompt: firstPrompt,
        responsesModel: {
          provider: "deepseek",
          model: getProviderRuntimeModel("built-in", "deepseek-v4-flash"),
        },
        run: first,
        usagePricingResolution: await createGptUsagePricingResolution(),
      });
      const firstSessionBytes = checkpointObjects.get(
        [...checkpointObjects.keys()].find((key) => {
          return key.includes("/blobs/");
        }) ?? "missing-canonical-pi-blob",
      );
      if (!firstSessionBytes) {
        throw new Error("Expected the first Pi run to persist native H1");
      }
      const original = firstSessionBytes.toString("utf8");
      const damagedH0 =
        damage === "malformed"
          ? `${original}{malformed\n`
          : damage === "mismatched"
            ? original.replace(first.threadId, randomUUID())
            : `${original}${JSON.stringify({ type: "model_change", id: "cycle", parentId: "cycle", timestamp: "2026-09-05T00:00:00.000Z", provider: "openai", modelId: "gpt-5.6-terra" })}\n`;
      // A public caller cannot write this historical corruption. Only the
      // stored object fixture sets it; publication is verified through the API.
      const hash = await replacePiSessionHistoryJsonlFixture({
        runId: first.runId,
        jsonl: damagedH0,
      });
      const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
      const blobKey = `${bucket}/blobs/${hash}.blob`;
      checkpointObjects.set(blobKey, Buffer.from(damagedH0, "utf8"));

      const second = await sendChatRun(actor, {
        agentId,
        threadId: first.threadId,
        prompt: "continue in Sandbox",
      });
      await flushWaitUntilForTest();
      const manifestKey = `${bucket}/pi-api-first-turn/${second.runId}/manifest.json`;
      const manifest = piApiFirstTurnManifestSchema.parse(
        JSON.parse(
          checkpointObjects.get(manifestKey)?.toString("utf8") ?? "{}",
        ),
      );
      expect(manifest).toMatchObject({
        schemaVersion: 4,
        mode: "sandbox-first",
        baseSession: { sessionId: first.threadId, sha256: hash },
        session: {
          sessionId: first.threadId,
          sha256: hash,
          rawSize: Buffer.byteLength(damagedH0),
        },
      });
      if (manifest.schemaVersion !== 4) {
        throw new Error("Expected a referenced Sandbox checkpoint");
      }
      expect(new URL(manifest.history.url).searchParams.get("object")).toBe(
        blobKey,
      );
      const claim = await claimChatRun(runnerGroup, second.runId);
      await cancelChatRun(actor, second.runId, claim.sandboxHeaders);
    },
    90_000,
  );

  it.each([
    "deepseek-v4-flash",
    "deepseek-v4.1-flash",
    "gpt-5.6-terra",
  ] as const)(
    "claims %s with Sandbox credentials and bills duplicate Sandbox usage once",
    async (selectedModel) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const isDeepSeek =
        selectedModel === "deepseek-v4-flash" ||
        selectedModel === "deepseek-v4.1-flash";
      const usagePricingResolution =
        await createPiUsagePricingResolution(selectedModel);
      await configureBuiltInPiModel(actor, selectedModel);

      const run = await sendChatRun(
        actor,
        {
          agentId,
          prompt: "hand a built-in Pi turn to Sandbox",
          model: selectedModel,
        },
        usagePricingResolution,
      );
      await flushWaitUntilForTest();

      const claimed = await claimChatRun(runnerGroup, run.runId);
      expect(claimed.claim.piModelConfig).toMatchObject({
        provider: isDeepSeek ? "deepseek" : "openai",
        model: getProviderRuntimeModel("built-in", selectedModel),
      });
      expect(claimed.claim.piModelConfig).not.toHaveProperty("api");
      expect(claimed.claim.piModelConfig).not.toHaveProperty("serviceTier");
      expect(claimEnvironment(claimed.claim).OPENAI_API_KEY).toBe(
        modelProviderSecretPlaceholder(
          isDeepSeek ? "deepseek" : "openai-api-key",
          isDeepSeek ? "DEEPSEEK_API_KEY" : "OPENAI_API_KEY",
        ),
      );
      const sandboxUsageEvent = {
        idempotencyKey: randomUUID(),
        kind: "model" as const,
        provider: selectedModel,
        category: "tokens.output",
        quantity: 2,
      };
      const sandboxUsageReceipts = await Promise.all([
        webhooks.requestAgentUsageEvent(
          { runId: run.runId, events: [sandboxUsageEvent] },
          claimed.sandboxHeaders,
          [200],
          usagePricingResolution,
        ),
        webhooks.requestAgentUsageEvent(
          { runId: run.runId, events: [sandboxUsageEvent] },
          claimed.sandboxHeaders,
          [200],
          usagePricingResolution,
        ),
      ]);
      expect(
        sandboxUsageReceipts.map((receipt) => {
          return receipt.body;
        }),
      ).toStrictEqual([{ success: true }, { success: true }]);
      await api.requestCancelRun(
        actor,
        run.runId,
        [200],
        usagePricingResolution,
      );
      await waitForRunStatus(actor, run.runId, "cancelled");
      await failChatRun(run.runId, claimed.sandboxHeaders, "Run cancelled");
      await flushWaitUntilForTest();
      // The API runs no inference for Pi, so the only billed row is the
      // Sandbox's idempotently reported usage.
      const usage = await readRunUsageEventsFixture(run.runId);
      expect(usage).toStrictEqual([
        expect.objectContaining({
          provider: selectedModel,
          category: "tokens.output",
          quantity: 2,
          status: "processed",
          billingError: null,
        }),
      ]);
      expect(totalChargedCredits(usage)).toBeGreaterThan(0);
    },
    90_000,
  );

  it("fails the run without a runner job when its launch handoff cannot be published", async () => {
    const { actor, agentId } = await entitledChatActor();
    await configureBuiltInPiModel(actor, "gpt-5.6-terra");
    mockPiResourceArchiveDownloads();
    const checkpointObjects = mockPiCheckpointObjectStore();
    const store = context.mocks.s3.send.getMockImplementation();
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      const candidate = command as PiCheckpointS3Command;
      const objectKey = piS3ObjectKey(candidate) ?? "";
      if (
        candidate.constructor?.name === "PutObjectCommand" &&
        objectKey.includes("/pi-api-first-turn/") &&
        objectKey.endsWith("/session.jsonl")
      ) {
        return Promise.reject(new Error("object store unavailable"));
      }
      return store?.(command) ?? Promise.resolve({});
    });

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "start a Pi thread whose handoff cannot be stored",
      model: "gpt-5.6-terra",
    });
    await flushWaitUntilForTest();

    await waitForRunStatus(actor, run.runId, "failed");
    const claim = await api.requestClaimRunnerJob(true, run.runId, [404]);
    expect(claim.status).toBe(404);
    expect(
      [...checkpointObjects.keys()].filter((key) => {
        return key.includes(`/pi-api-first-turn/${run.runId}/`);
      }),
    ).toStrictEqual([]);
  });
});
