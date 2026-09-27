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
import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { testContext } from "../../../__tests__/test-context";
import { env, mockEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
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
  expectNoBuiltInModelUsage,
  claimEnvironment,
  modelProviderSecretPlaceholder,
  API_FIRST_TURN_OWNERSHIP_BUDGET_MS,
  API_FIRST_TURN_COORDINATION_BUDGET_MS,
  totalChargedCredits,
  createGptUsagePricingResolution,
  createPiApiFirstTurnUsagePricingResolution,
  eventBackedContents,
  type PiCheckpointS3Command,
  piS3ObjectKey,
  PI_RESOURCE_ARCHIVE_DOWNLOAD_URL,
  occurrences,
} from "./helpers/chat-events-fixture";
import {
  piResponsesTextSse,
  piResponsesContentSse,
  nativeCodexSseResponse,
} from "./helpers/pi-responses";

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
  waitForThreadMessages,
  waitForRunStatus,
  completeChatRunOk,
  failChatRun,
  cancelChatRun,
  mockPiCheckpointObjectStore,
  expectPiApiFirstTurnTerminalWithoutOutput,
  uploadedPiS3Object,
  publishPendingPiInstructions,
  mockPiResourceArchiveDownloads,
  completeSandboxFirstPiRun,
  queueCapabilityProvenPiRun,
} = createChatEventsFixture(context);

describe("CHAT-02: model-first provider policies", () => {
  it.each([
    { encoding: "identity", responseLost: false, large: false },
    { encoding: "identity", responseLost: false, large: true },
    { encoding: "gzip", responseLost: false, large: true },
    { encoding: "zstd", responseLost: false, large: true },
    { encoding: "identity", responseLost: true, large: true },
  ] as const)(
    "references Pi $encoding history (large: $large, publication response lost: $responseLost) without API history or resource IO",
    async ({ encoding, responseLost, large }) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      await publishPendingPiInstructions(actor, agentId);
      const checkpointObjects = mockPiCheckpointObjectStore();
      let modelCalls = 0;
      let resourceDownloads = 0;
      server.use(
        http.post("https://api.openai.com/v1/responses", () => {
          modelCalls += 1;
          return nativeCodexSseResponse(
            piResponsesTextSse("unexpected API answer", modelCalls),
          );
        }),
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
      if (responseLost) {
        const deadline = new AbortController();
        onTestFinished(() => {
          deadline.abort();
        });
        // An object-store response can be lost after the manifest is visible.
        // Expire the real attempt signal exactly at that external boundary.
        context.mocks.abortSignal.timeout.mockImplementation((milliseconds) => {
          return milliseconds > API_FIRST_TURN_OWNERSHIP_BUDGET_MS - 1000 &&
            milliseconds <= API_FIRST_TURN_OWNERSHIP_BUDGET_MS
            ? deadline.signal
            : undefined;
        });
        const send = context.mocks.s3.send.getMockImplementation();
        if (!send) {
          throw new Error("Expected the checkpoint object store");
        }
        context.mocks.s3.send.mockImplementation(async (command: unknown) => {
          const candidate = command as PiCheckpointS3Command;
          const stored = await send(command);
          if (
            candidate.constructor?.name === "PutObjectCommand" &&
            piS3ObjectKey(candidate)?.endsWith("/manifest.json")
          ) {
            expect(
              checkpointObjects.has(piS3ObjectKey(candidate) ?? ""),
            ).toBeTruthy();
            deadline.abort(
              new DOMException(
                "Manifest response lost at ownership deadline",
                "TimeoutError",
              ),
            );
            throw deadline.signal.reason;
          }
          return stored;
        });
      }
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
      const manifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${resumed.runId}/manifest.json`;
      // Terminal cleanup removes the failed run's object. The captured write
      // still proves that ownership publication happened before its response
      // was lost; the normal transfer retains its currently readable object.
      const publishedManifest = responseLost
        ? uploadedPiS3Object(manifestKey)
        : checkpointObjects.get(manifestKey);
      const manifest = piApiFirstTurnManifestSchema.parse(
        JSON.parse(publishedManifest?.toString("utf8") ?? "{}"),
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
      expect(modelCalls).toBe(0);
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
      if (responseLost) {
        await waitForRunStatus(actor, resumed.runId, "failed");
        await expectPiApiFirstTurnTerminalWithoutOutput(
          actor,
          resumed,
          "failed",
          "[PI_API_FIRST_TURN_DEADLINE_EXCEEDED] Pi API first-turn deadline elapsed",
        );
        expect(
          context.mocks.s3.send.mock.calls
            .slice(callsBeforeResume)
            .filter(([command]) => {
              const candidate = command as PiCheckpointS3Command;
              return (
                candidate.constructor?.name === "PutObjectCommand" &&
                piS3ObjectKey(candidate) === manifestKey
              );
            }),
        ).toHaveLength(1);
        await api.requestClaimRunnerJob(true, resumed.runId, [404]);
        return;
      }
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
      let modelCalls = 0;
      let resourceDownloads = 0;
      server.use(
        http.post("https://api.openai.com/v1/responses", () => {
          modelCalls += 1;
          return nativeCodexSseResponse(
            piResponsesTextSse("ordinary API answer", modelCalls),
          );
        }),
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
        expect(modelCalls).toBe(0);
        expect(resourceDownloads).toBe(0);
        // Public usage summaries omit pending usage, so inspect this run's
        // uniquely owned ledger to rule out duplicate API billing ownership.
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

      mockPiResourceArchiveDownloads();
      const ordinary = await sendChatRun(
        actor,
        {
          agentId,
          prompt: "ordinary prose with /skill:handoff-skill later in the text",
          model: "gpt-5.6-terra",
        },
        queued.usagePricingResolution,
      );
      await flushWaitUntilForTest();
      await waitForRunStatus(actor, ordinary.runId, "completed");
      expect(modelCalls).toBe(1);
    },
    90_000,
  );

  it.each(["readback mismatch", "coordination deadline"] as const)(
    "fails native-input publication safely on %s",
    async (failure) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const checkpointObjects = mockPiCheckpointObjectStore();
      let modelCalls = 0;
      server.use(
        http.post("https://api.openai.com/v1/responses", () => {
          modelCalls += 1;
          return nativeCodexSseResponse(
            piResponsesTextSse("unsafe API turn", modelCalls),
          );
        }),
      );
      const { launch } = await queueCapabilityProvenPiRun({
        actor,
        agentId,
        runnerGroup,
        prompt: "/skill:handoff-skill preserve  arguments",
      });
      // The run id exists only once the pick launches the waiting input, so
      // match this test's only API-first session object by its key shape.
      const firstTurnPrefix = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/`;
      const send = context.mocks.s3.send.getMockImplementation();
      if (!send) {
        throw new Error("Expected the checkpoint object-store boundary");
      }
      const apiStartedAt = now();
      mockNow(apiStartedAt);
      context.mocks.s3.send.mockImplementation((command: unknown) => {
        const candidate = command as PiCheckpointS3Command;
        const key = piS3ObjectKey(candidate);
        if (
          candidate.constructor?.name === "GetObjectCommand" &&
          key !== undefined &&
          key.startsWith(firstTurnPrefix) &&
          key.endsWith("/session.jsonl")
        ) {
          if (failure === "coordination deadline") {
            mockNow(apiStartedAt + API_FIRST_TURN_COORDINATION_BUDGET_MS);
          } else {
            const bytes = checkpointObjects.get(key);
            if (!bytes) {
              throw new Error("Expected uploaded H0 before readback");
            }
            const corrupted = Buffer.from(bytes);
            corrupted[0] = 0;
            checkpointObjects.set(key, corrupted);
          }
        }
        return send(command);
      });
      const run = await launch();
      const manifestKey = `${firstTurnPrefix}${run.runId}/manifest.json`;
      await waitForRunStatus(actor, run.runId, "failed");
      await flushWaitUntilForTest();
      expect(modelCalls).toBe(0);
      expect(uploadedPiS3Object(manifestKey)).toBeUndefined();
      await api.requestClaimRunnerJob(true, run.runId, [404]);
      expect((await api.readRun(actor, run.runId)).error).toContain(
        failure === "coordination deadline"
          ? "[PI_API_FIRST_TURN_DEADLINE_EXCEEDED]"
          : "[PI_API_SANDBOX_FALLBACK_FAILED]",
      );
      const events = (await chat.listThreadEvents(actor, run.threadId)).events;
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
      ).toStrictEqual(["run.failed"]);
      expect(eventBackedContents(events, run.runId)).toStrictEqual([]);
    },
    90_000,
  );

  it.each(["gpt-5.6-terra", "deepseek-v4.1-flash"] as const)(
    "hands a %s resource failure to Sandbox without replaying a later credential failure",
    async (selectedModel) => {
      const { actor, agentId, runnerGroup, providerId } =
        await entitledChatActor();
      await publishPendingPiInstructions(actor, agentId);
      if (!actor.orgId) {
        throw new Error("Expected entitled chat actor to have an org");
      }
      mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
      await api.heartbeatRunner(runnerGroup);
      // Keep the anchor claimable while the separate queued target proves Pi
      // API-first resource-failure handoff.
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
        prompt: "hold the thread while the future Pi launch is queued",
        model: "claude-fable-5-1",
      });
      await flushWaitUntilForTest();
      const anchorState = await api.readRun(actor, anchor.runId);
      if (anchorState.status !== "pending") {
        throw new Error(
          `Expected pending anchor before claim: ${JSON.stringify(anchorState)}`,
        );
      }
      const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);
      expect(anchorClaim.claim.cliAgentType).toBe("claude-code");

      await configureBuiltInPiModel(actor, selectedModel);

      mockPiResourceArchiveDownloads(true);
      let modelCalls = 0;
      server.use(
        http.post(
          selectedModel === "deepseek-v4.1-flash"
            ? "https://api.deepseek.com/responses"
            : "https://api.openai.com/v1/responses",
          () => {
            modelCalls += 1;
            return HttpResponse.json(
              {
                error: {
                  code: "invalid_api_key",
                  message: "credential rejected",
                },
              },
              { status: 401 },
            );
          },
        ),
      );
      const checkpointObjects = mockPiCheckpointObjectStore();
      const fallbackPrompt = "execute this fallback prompt exactly once";
      // At capacity the fallback prompt waits without a run; the anchor's
      // completion picks its thread and launches the Pi run.
      const waitingFallback = await sendWaitingChatInput(actor, {
        agentId,
        prompt: fallbackPrompt,
        model: selectedModel,
      });

      await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders);
      await flushWaitUntilForTest();
      const fallback = await waitingFallback.launchedRun();
      const fallbackManifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${fallback.runId}/manifest.json`;
      expect(checkpointObjects.get(fallbackManifestKey)).toBeInstanceOf(Buffer);
      expect(modelCalls).toBe(0);

      const fallbackManifest = piApiFirstTurnManifestSchema.parse(
        JSON.parse(
          checkpointObjects.get(fallbackManifestKey)?.toString("utf8") ?? "{}",
        ),
      );
      expect(fallbackManifest).toMatchObject({
        schemaVersion: 3,
        outcome: "ownership-transfer",
        mode: "sandbox-first",
        baseSession: { sessionId: fallback.threadId, sha256: null },
        session: {
          sessionId: fallback.threadId,
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          rawSize: expect.any(Number),
        },
        sandboxEventSequenceStart: 1,
      });
      const fallbackSessionKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${fallback.runId}/session.jsonl`;
      const fallbackH0 =
        checkpointObjects.get(fallbackSessionKey)?.toString("utf8") ?? "";
      expect(Buffer.byteLength(fallbackH0)).toBe(
        fallbackManifest.session.rawSize,
      );
      expect(createHash("sha256").update(fallbackH0).digest("hex")).toBe(
        fallbackManifest.session.sha256,
      );
      const sandboxSession = MemoryPiSession.fromJsonl(fallbackH0);
      expect(sandboxSession.getSessionId()).toBe(fallback.threadId);
      expect(sandboxSession.buildSessionContext().messages).toHaveLength(0);

      const fallbackClaim = await claimChatRun(runnerGroup, fallback.runId);
      expect(fallbackClaim.claim).toMatchObject({
        cliAgentType: "pi",
        piSessionId: fallback.threadId,
        prompt: fallbackPrompt,
        piLaunchConfig: {
          apiFirstTurn: {
            sandboxEventSequenceStart: 1,
          },
        },
      });
      const postProviderPrompt =
        "fail a credential rejection after one provider request";
      const waitingPostProvider = await sendWaitingChatInput(actor, {
        agentId,
        prompt: postProviderPrompt,
        model: selectedModel,
      });

      mockPiResourceArchiveDownloads();
      sandboxSession.appendMessage({
        role: "user",
        content: fallbackPrompt,
        timestamp: 1,
      });
      const fallbackAnswer = "Sandbox completed the fallback exactly once";
      sandboxSession.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: fallbackAnswer }],
        api: "openai-responses",
        provider:
          selectedModel === "deepseek-v4.1-flash" ? "deepseek" : "openai",
        model: getProviderRuntimeModel("built-in", selectedModel),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "stop",
        timestamp: 2,
      });
      const fallbackH2 = sandboxSession.toJsonl();
      expect(occurrences(fallbackH2, fallbackPrompt)).toBe(1);
      expect(
        MemoryPiSession.fromJsonl(fallbackH2).isSettledCheckpoint(),
      ).toBeTruthy();
      const fallbackH2Hash = createHash("sha256")
        .update(fallbackH2)
        .digest("hex");
      const preparedH2 = await webhooks.requestAgentCheckpointPrepareHistory(
        {
          runId: fallback.runId,
          hash: fallbackH2Hash,
          rawSize: Buffer.byteLength(fallbackH2),
          encodedSize: Buffer.byteLength(fallbackH2),
          encoding: "identity",
        },
        fallbackClaim.sandboxHeaders,
        [200],
      );
      expect(preparedH2.body).toMatchObject({
        existing: false,
        encoding: "identity",
      });
      checkpointObjects.set(
        `${env("R2_USER_STORAGES_BUCKET_NAME")}/blobs/${fallbackH2Hash}.blob`,
        Buffer.from(fallbackH2, "utf8"),
      );
      await webhooks.requestAgentEvents(
        {
          runId: fallback.runId,
          events: [
            {
              type: "assistant",
              sequenceNumber: 1,
              message: {
                content: [{ type: "text", text: fallbackAnswer }],
              },
            },
            {
              type: "result",
              sequenceNumber: 2,
              result: fallbackAnswer,
            },
          ],
        },
        fallbackClaim.sandboxHeaders,
        [200],
      );
      const completedFallback = await webhooks.requestAgentComplete(
        {
          runId: fallback.runId,
          exitCode: 0,
          lastEventSequence: 2,
          checkpoint: {
            cliAgentType: "pi",
            cliAgentSessionId: fallback.threadId,
            cliAgentSessionHistoryHash: fallbackH2Hash,
          },
        },
        fallbackClaim.sandboxHeaders,
        [200],
      );
      expect(completedFallback.body).toStrictEqual({
        success: true,
        status: "completed",
      });
      await waitForRunStatus(actor, fallback.runId, "completed", 5000);
      await flushWaitUntilForTest();
      const postProvider = await waitingPostProvider.launchedRun();
      await waitForRunStatus(actor, postProvider.runId, "failed", 5000);
      await flushWaitUntilForTest();

      expect(modelCalls).toBe(1);
      await expectNoBuiltInModelUsage(fallback.runId);
      await expectNoBuiltInModelUsage(postProvider.runId);
      expect((await api.readRun(actor, postProvider.runId)).error).toContain(
        "[PI_API_MODEL_FAILED]",
      );
      const postProviderManifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${postProvider.runId}/manifest.json`;
      expect(checkpointObjects.has(postProviderManifestKey)).toBeFalsy();
      const postProviderClaim = await api.requestClaimRunnerJob(
        true,
        postProvider.runId,
        [404],
      );
      expect(postProviderClaim.status).toBe(404);
      const finalThread = await waitForThreadMessages(
        actor,
        fallback.threadId,
        (messages) => {
          return eventBackedContents(messages, fallback.runId).some(
            (message) => {
              return message.content === fallbackAnswer;
            },
          );
        },
      );
      expect(
        eventBackedContents(finalThread.events, fallback.runId).filter(
          (message) => {
            return message.content === fallbackAnswer;
          },
        ),
      ).toHaveLength(1);
      await expect(
        readThreadSessionConversation(context, fallback.threadId),
      ).resolves.toMatchObject({ conversation_run_id: fallback.runId });
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

    mockPiResourceArchiveDownloads();
    let modelCalls = 0;
    const modelRequests: unknown[] = [];
    server.use(
      http.post(
        "https://openrouter.ai/api/v1/responses",
        async ({ request }) => {
          modelCalls += 1;
          modelRequests.push(await request.json());
          return new HttpResponse(
            piResponsesTextSse(
              "seed the compaction checkpoint",
              modelCalls,
              {
                input_tokens: 1_033_617,
                output_tokens: 0,
                total_tokens: 1_033_617,
              },
              "priority",
            ),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      ),
    );
    const checkpointObjects = mockPiCheckpointObjectStore();
    const first = await withOpenRouterRoute(async () => {
      return await sendChatRun(
        actor,
        {
          agentId,
          prompt: "create a settled Pi checkpoint",
          model: "gpt-5.6-terra",
          runOptions: { codexServiceTier: "fast" },
        },
        usagePricingResolution,
      );
    });
    await waitForRunStatus(actor, first.runId, "completed");
    await flushWaitUntilForTest();
    expect(modelCalls).toBe(1);
    expect(
      z
        .object({ service_tier: z.literal("priority") })
        .passthrough()
        .parse(modelRequests[0]).service_tier,
    ).toBe("priority");
    await expect(readRunUsageEventsFixture(first.runId)).resolves.toStrictEqual(
      [
        expect.objectContaining({
          provider: "gpt-5.6-terra",
          category: "tokens.input.long_context.fast",
          quantity: 1_033_617,
          status: "processed",
          billingError: null,
          creditsCharged: expect.any(Number),
        }),
      ],
    );

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
    await expect
      .poll(() => {
        return checkpointObjects.get(manifestKey);
      })
      .toBeInstanceOf(Buffer);
    expect(modelCalls).toBe(1);
    await expect(
      readRunUsageEventsFixture(second.runId),
    ).resolves.toStrictEqual([]);
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

      mockPiResourceArchiveDownloads();
      let modelCalls = 0;
      server.use(
        http.post("https://api.deepseek.com/responses", () => {
          modelCalls += 1;
          return new HttpResponse(
            piResponsesTextSse("canonical H0 answer", modelCalls),
            { headers: { "content-type": "text/event-stream" } },
          );
        }),
      );
      const checkpointObjects = mockPiCheckpointObjectStore();
      const first = await sendChatRun(actor, {
        agentId,
        prompt: "create canonical Pi H0",
        model: "deepseek-v4-flash",
      });
      await waitForRunStatus(actor, first.runId, "completed");
      await flushWaitUntilForTest();
      expect(modelCalls).toBe(1);
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
      expect(modelCalls).toBe(1);
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
    "keeps %s API-first and Sandbox usage as separate billable rows",
    async (selectedModel) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const isDeepSeek =
        selectedModel === "deepseek-v4-flash" ||
        selectedModel === "deepseek-v4.1-flash";
      const usagePricingResolution =
        await createPiApiFirstTurnUsagePricingResolution(selectedModel);
      await configureBuiltInPiModel(actor, selectedModel);

      mockPiResourceArchiveDownloads();
      const checkpointObjects = mockPiCheckpointObjectStore();
      let modelCalls = 0;
      server.use(
        http.post(
          isDeepSeek
            ? "https://api.deepseek.com/responses"
            : "https://api.openai.com/v1/responses",
          () => {
            modelCalls += 1;
            return new HttpResponse(
              piResponsesContentSse({
                blocks: [
                  {
                    type: "toolCall",
                    callId: "call_deepseek_sandbox",
                    name: "bash",
                    arguments: { command: "true" },
                  },
                ],
                sequence: modelCalls,
                usage: {
                  input_tokens: 10,
                  output_tokens: 3,
                  total_tokens: 13,
                  input_tokens_details: {
                    cached_tokens: 3,
                    cache_write_tokens: 2,
                  },
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            );
          },
        ),
      );

      const run = await sendChatRun(
        actor,
        {
          agentId,
          prompt: "hand a built-in DeepSeek tool response to Sandbox",
          model: selectedModel,
        },
        usagePricingResolution,
      );
      const manifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/manifest.json`;
      await expect
        .poll(() => {
          return checkpointObjects.has(manifestKey);
        })
        .toBe(true);
      await flushWaitUntilForTest();
      expect(modelCalls).toBe(1);

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
      const combinedUsage = await readRunUsageEventsFixture(run.runId);
      expect(
        combinedUsage.filter((row) => {
          return row.category === "tokens.output" && row.quantity === 3;
        }),
      ).toHaveLength(1);
      expect(
        combinedUsage.filter((row) => {
          return row.category === "tokens.output" && row.quantity === 2;
        }),
      ).toHaveLength(1);
      expect(combinedUsage).toHaveLength(5);
      expect(
        combinedUsage.every((row) => {
          return (
            row.provider === selectedModel &&
            row.status === "processed" &&
            row.billingError === null &&
            !row.category.includes(".fast") &&
            !row.category.includes(".long_context")
          );
        }),
      ).toBeTruthy();
      expect(totalChargedCredits(combinedUsage)).toBeGreaterThan(0);
    },
    90_000,
  );
});
