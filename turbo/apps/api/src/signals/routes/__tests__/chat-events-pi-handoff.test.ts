import { createHash, randomUUID } from "node:crypto";
import { gzipSync, zstdCompressSync } from "node:zlib";
import { isChatRunTerminalEventType } from "@okouai/api-contracts/contracts/chat-events";
import {
  PI_SANDBOX_INSTALLED_CLI_MIN_VERSION,
  RESUME_SESSION_HISTORY_MAX_BYTES,
} from "@okouai/api-contracts/contracts/runners";
import {
  PI_AGENT_RUNTIME_VERSION,
  PI_SESSION_CONSTRUCTION_DIGEST,
} from "@okouai/pi-agent-runtime";
import { MemoryPiSession } from "@okouai/pi-agent-runtime/node";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { env } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { readPrimaryBuiltInRouteFixture } from "../../../test-fixtures/model-route-capabilities";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { readCompletedRunSessionId } from "./helpers/public-run-session";
import {
  expectThreadModelTokens,
  readThreadModelUsage,
} from "./helpers/public-thread-usage";
import {
  createChatEventsFixture,
  claimEnvironment,
  modelProviderSecretPlaceholder,
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
  sendChatRun,
  claimChatRun,
  waitForRunStatus,
  failChatRun,
  cancelChatRun,
  mockPiCheckpointObjectStore,
  piSandboxBaseSession,
  publishPendingPiInstructions,
  completeSandboxFirstPiRun,
  queueCapabilityProvenPiRun,
} = createChatEventsFixture(context);

describe("CHAT-02: model-first provider policies", () => {
  it.each(["identity", "gzip", "zstd"] as const)(
    "references Pi %s resume history without API history or resource IO",
    async (encoding) => {
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
            text: "x".repeat(64),
          },
        ],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-6-luna",
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
          model: "gpt-6-luna",
        },
        queued.usagePricingResolution,
      );
      await flushWaitUntilForTest();
      const resumedClaim = await claimChatRun(runnerGroup, resumed.runId);
      const resumeSession = resumedClaim.claim.resumeSession;
      expect(resumeSession).toMatchObject({
        sessionId: run.threadId,
        historyRef: {
          kind: "blob",
          hash,
          encoding,
          rawSize: raw.length,
          encodedSize: encoded.length,
          url: expect.any(String),
        },
      });
      if (!resumeSession || !("historyRef" in resumeSession)) {
        throw new Error("Expected a referenced resume history");
      }
      expect(
        new URL(resumeSession.historyRef.url).searchParams.get("object"),
      ).toBe(blobKey);
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
    "claims native input %j with exact fresh and resumed Sandbox H0",
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
      let applicationSession: string | undefined;
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
              model: "gpt-6-luna",
            },
            queued.usagePricingResolution,
          );
        }
        await flushWaitUntilForTest();
        expect(resourceDownloads).toBe(0);
        const claim = await claimChatRun(runnerGroup, run.runId);
        expect(claim.claim).toMatchObject({
          cliAgentType: "pi",
          piSessionId: run.threadId,
          prompt: originalPrompt,
          piInstalledCliRequirement: {
            requiredPiAgentRuntimeVersion: PI_AGENT_RUNTIME_VERSION,
            minCliVersion: PI_SANDBOX_INSTALLED_CLI_MIN_VERSION,
            requiredPiSessionConstructionDigest: PI_SESSION_CONSTRUCTION_DIGEST,
          },
        });
        expect(claim.claim.piLaunchConfig).toMatchObject({ schemaVersion: 2 });
        if (turn === 1) {
          expect(claim.claim.resumeSession).toBeNull();
        } else {
          if (!expectedH0) {
            throw new Error("Expected settled first-turn checkpoint");
          }
          const hash = createHash("sha256").update(expectedH0).digest("hex");
          const resumeSession = claim.claim.resumeSession;
          expect(resumeSession).toMatchObject({
            sessionId: run.threadId,
            historyRef: {
              kind: "blob",
              hash,
              encoding: "identity",
              rawSize: expectedH0.length,
              encodedSize: expectedH0.length,
              url: expect.any(String),
            },
          });
          if (!resumeSession || !("historyRef" in resumeSession)) {
            throw new Error("Expected referenced resume history");
          }
          expect(
            new URL(resumeSession.historyRef.url).searchParams.get("object"),
          ).toBe(`${bucket}/blobs/${hash}.blob`);
        }
        const h0 = piSandboxBaseSession(claim.claim, checkpointObjects);
        if (turn === 2) {
          expect(h0).toStrictEqual(expectedH0);
        }
        const session = MemoryPiSession.fromJsonl(h0.toString("utf8"));
        expect(session.getSessionId()).toBe(run.threadId);
        expect(session.buildSessionContext().messages).toHaveLength(
          (turn - 1) * 2,
        );

        const sandboxUsage = {
          idempotencyKey: randomUUID(),
          kind: "model" as const,
          provider: "gpt-6-luna",
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
        await expectThreadModelTokens(context, actor, run.threadId, turn * 2);
        const completedSession = await readCompletedRunSessionId(
          context,
          actor,
          run.runId,
        );
        if (applicationSession === undefined) {
          applicationSession = completedSession;
        }
        expect(completedSession).toBe(applicationSession);
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

  it.each(["deepseek-v4-flash", "deepseek-v4.1-flash", "gpt-6-luna"] as const)(
    "claims %s with Sandbox credentials and bills duplicate Sandbox usage once",
    async (selectedModel) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const isDeepSeek =
        selectedModel === "deepseek-v4-flash" ||
        selectedModel === "deepseek-v4.1-flash";
      const usagePricingResolution =
        await createPiUsagePricingResolution(selectedModel);
      await configureBuiltInPiModel(actor, selectedModel);
      const { upstreamModel } =
        await readPrimaryBuiltInRouteFixture(selectedModel);

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
        provider: isDeepSeek ? "openrouter" : "openai",
        model: upstreamModel,
      });
      expect(claimed.claim.piModelConfig).not.toHaveProperty("api");
      expect(claimed.claim.piModelConfig).not.toHaveProperty("serviceTier");
      expect(claimEnvironment(claimed.claim).OPENAI_API_KEY).toBe(
        modelProviderSecretPlaceholder(
          isDeepSeek ? "openrouter-codex" : "openai-api-key",
          isDeepSeek ? "OPENROUTER_API_KEY" : "OPENAI_API_KEY",
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
      // Only the guest's two reported output tokens are publicly charged.
      const usage = await readThreadModelUsage(context, actor, run.threadId);
      expect(usage.tokens).toBe(2);
      expect(usage.credits).toBeGreaterThan(0);
    },
    90_000,
  );
});
