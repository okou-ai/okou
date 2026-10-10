import {
  mockGoogleText,
  VERTEX_TEXT_URL,
  vertexTextRequest,
} from "./helpers/google-text";
import { expectThreadModelTokens } from "./helpers/public-thread-usage";
import { chatThreadActivitySummaryContract } from "@okouai/api-contracts/contracts/chat-thread-activity-summary";
import { chatThreadActivitySummaryRoutes } from "../chat-threads-activity-summary";
import { createHash, randomUUID } from "node:crypto";
import { PI_MEMORY_ROOT } from "@okouai/api-contracts/contracts/runners";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { MemoryPiSession } from "@okouai/pi-agent-runtime/node";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { env, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import type { ApiTestUser } from "./helpers/api-bdd";
import { expectCanonicalStorageManifest } from "./helpers/api-bdd-runs";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { commitMemoryVersion } from "./helpers/memory";
import {
  createChatEventsFixture,
  createPiUsagePricingResolution,
  requireOrgId,
  claimEnvironment,
  eventBackedContents,
} from "./helpers/chat-events-fixture";

const context = testContext();
const {
  api,
  chat,
  webhooks,
  entitledChatActor,
  configureSubscriptionPiModel,
  configureBuiltInPiModelOnOpenRouter,
  sendChatRunAfterPick,
  claimChatRun,
  waitForRunStatus,
  cancelChatRun,
  sessionHeaders,
  mockPiCheckpointObjectStore,
  mockPiResourceArchiveDownloads,
  piSandboxBaseSession,
} = createChatEventsFixture(context);

async function expectPiActivitySummary(
  actor: ApiTestUser,
  run: { readonly threadId: string; readonly runId: string },
): Promise<void> {
  // Guest tool events are captured as activity while the run is still active.
  await flushWaitUntilForTest();
  mockGoogleText();
  let activityInput = "";
  server.use(
    http.post(VERTEX_TEXT_URL, async ({ request }) => {
      const body = vertexTextRequest(await request.json(), request.url);
      activityInput = body.messages
        .map((message) => {
          return message.content;
        })
        .join("\n");
      return HttpResponse.json({
        candidates: [
          {
            finishReason: "STOP",
            content: {
              parts: [
                {
                  text: "Checking the CLI and preparing the note",
                },
              ],
            },
          },
        ],
      });
    }),
  );
  const activity = await accept(
    setupApp({ context, routes: chatThreadActivitySummaryRoutes })(
      chatThreadActivitySummaryContract,
    ).summarize({
      headers: sessionHeaders(actor),
      params: { id: run.threadId },
      body: { runId: run.runId },
    }),
    [200],
  );
  expect(activity.body).toMatchObject({
    status: "available",
    messages: [
      {
        id: "Checking the CLI and preparing the note",
        text: "Checking the CLI and preparing the note",
      },
    ],
  });
  expect(activityInput).toContain("okou --help");
  expect(activityInput).toContain("add_ad_hoc_note");
  mockOptionalEnv("GCP_LLM_PROJECT_ID", undefined);
}

function boundedPiCheckpointHistory(jsonl: string): {
  readonly original: string;
  readonly bounded: string;
} {
  // Keep the exact native pre-compact path and settled leaf while removing
  // one old parent. The API accepts only the smaller candidate as H2.
  const nativeLines = jsonl.trimEnd().split("\n");
  const headerLine = nativeLines[0];
  if (!headerLine) {
    throw new Error("Expected a native Pi session header");
  }
  const piEntry = z
    .object({
      type: z.string(),
      id: z.string(),
      parentId: z.string().nullable(),
    })
    .passthrough();
  const firstKept = piEntry.parse(JSON.parse(nativeLines[1] ?? "null"));
  const finalAssistant = piEntry.parse(
    JSON.parse(nativeLines.at(-1) ?? "null"),
  );
  if (
    firstKept.parentId !== null ||
    finalAssistant.type !== "message" ||
    !finalAssistant.parentId
  ) {
    throw new Error("Expected a root and a settled native Pi leaf");
  }
  const oldId = randomUUID();
  const compactId = randomUUID();
  const compactLine = JSON.stringify({
    type: "compaction",
    id: compactId,
    parentId: finalAssistant.parentId,
    timestamp: "2026-09-27T00:00:00Z",
    summary: "prior work summarized by Pi",
    firstKeptEntryId: firstKept.id,
    tokensBefore: 90_000,
  });
  const settledLine = JSON.stringify({
    ...finalAssistant,
    parentId: compactId,
  });
  const middleLines = nativeLines.slice(2, -1);
  const oldLine = JSON.stringify({
    type: "message",
    id: oldId,
    parentId: null,
    timestamp: "2026-09-27T00:00:00Z",
    message: { role: "user", content: "older work ".repeat(8192) },
  });
  return {
    original: [
      headerLine,
      oldLine,
      JSON.stringify({ ...firstKept, parentId: oldId }),
      ...middleLines,
      compactLine,
      settledLine,
      "",
    ].join("\n"),
    bounded: [
      headerLine,
      JSON.stringify(firstKept),
      ...middleLines,
      compactLine,
      settledLine,
      "",
    ].join("\n"),
  };
}

describe("CHAT-02: model-first routing", () => {
  async function piActivityScenario(): Promise<void> {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const orgId = requireOrgId(actor);
    const model = "gpt-6-luna";
    await configureSubscriptionPiModel(actor, {}, model);
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      {
        [FeatureSwitchKey.PiMemory]: true,
      },
    );
    mockPiResourceArchiveDownloads();
    const okouCliCommand = `npx --yes --package="\${CLI_PKG_URL}" okou --help`;
    const adHocNoteFilename = "2026-09-05T16-15-00-sandbox-checkpoint.md";
    const adHocNote =
      "# Sandbox checkpoint\n\nPersist this staged sandbox note.\n";
    const historyObjects = mockPiCheckpointObjectStore();
    const prompt = "use the Okou CLI in the Sandbox";
    const run = await sendChatRunAfterPick(actor, {
      agentId,
      prompt,
      model,
    });
    const claimed = await claimChatRun(runnerGroup, run.runId);
    expect(claimed.claim.cliAgentType).toBe("pi");
    expect(claimed.claim.piSessionId).toBe(run.threadId);
    // The first turn has no stored history, so the Sandbox starts fresh.
    expect(claimed.claim.resumeSession).toBeNull();
    const h2Session = MemoryPiSession.fromJsonl(
      piSandboxBaseSession(claimed.claim, historyObjects).toString("utf8"),
    );
    expect(claimed.claim.piModelConfig).toMatchObject({
      provider: "openai-codex",
      model: "gpt-6-luna",
    });
    expect(claimed.claim.piModelConfig).not.toHaveProperty("api");
    expect(claimed.claim.piLaunchConfig).toMatchObject({ schemaVersion: 2 });
    const lunaEnvironment = claimEnvironment(claimed.claim);
    expect(lunaEnvironment.OKOU_TOKEN).toBeTruthy();
    expect(lunaEnvironment.CLI_PKG_URL).toBeTruthy();
    const lunaInstructions = claimed.claim.appendSystemPrompt;
    if (!lunaInstructions) {
      throw new Error("Expected Luna Web instructions");
    }
    expect(lunaInstructions).toContain("You are currently running inside: Web");
    expect(lunaInstructions).toContain("okou web download-file -h");
    expect(lunaInstructions).toContain("Run commands with: `okou <command>`");
    expect(lunaInstructions).not.toMatch(/auto.?memory/iu);
    const lunaStorageManifest = expectCanonicalStorageManifest(
      claimed.claim.storageManifest,
    );
    if (!lunaStorageManifest) {
      throw new Error("Expected Luna storage manifest");
    }
    const lunaMounts = lunaStorageManifest.storageMounts;
    const lunaMemoryMount = lunaMounts.find((mount) => {
      return mount.name === "memory" && mount.mountPath === PI_MEMORY_ROOT;
    });
    if (!lunaMemoryMount) {
      throw new Error("Expected the Pi memory mount");
    }
    expect(claimed.claim.prompt).toBe(prompt);
    await webhooks.requestAgentEvents(
      {
        runId: run.runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 1,
            message: {
              content: [{ type: "text", text: "before parallel tools" }],
            },
          },
          {
            type: "assistant",
            sequenceNumber: 2,
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "call_pi_read",
                  name: "bash",
                  input: {
                    command: okouCliCommand,
                  },
                },
              ],
            },
          },
          {
            type: "assistant",
            sequenceNumber: 3,
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "call_pi_write",
                  name: "add_ad_hoc_note",
                  input: {
                    filename: adHocNoteFilename,
                    note: adHocNote,
                  },
                },
              ],
            },
          },
          {
            type: "assistant",
            sequenceNumber: 4,
            message: {
              content: [{ type: "text", text: "after parallel tools" }],
            },
          },
        ],
      },
      claimed.sandboxHeaders,
      [200],
    );
    await flushWaitUntilForTest();
    expect(
      eventBackedContents(
        (await chat.listThreadEvents(actor, run.threadId)).events,
        run.runId,
      ).map((message) => {
        return {
          content: message.content,
          sequenceNumber: message.sequenceNumber,
        };
      }),
    ).toStrictEqual([
      { content: "before parallel tools", sequenceNumber: 1 },
      { content: "after parallel tools", sequenceNumber: 4 },
    ]);
    await expectPiActivitySummary(actor, run);

    h2Session.appendMessage({
      role: "user",
      content: prompt,
      timestamp: 1,
    });
    h2Session.appendMessage({
      role: "assistant",
      content: [
        { type: "text", text: "before parallel tools" },
        {
          type: "toolCall",
          id: "call_pi_read",
          name: "bash",
          arguments: { command: okouCliCommand },
        },
        {
          type: "toolCall",
          id: "call_pi_write",
          name: "add_ad_hoc_note",
          arguments: { filename: adHocNoteFilename, note: adHocNote },
        },
        { type: "text", text: "after parallel tools" },
      ],
      api: "openai-responses",
      provider: "openai-codex",
      model: "gpt-6-luna",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 2,
    });
    h2Session.appendMessage({
      role: "toolResult",
      toolCallId: "call_pi_read",
      toolName: "bash",
      content: [{ type: "text", text: "Okou CLI help output" }],
      details: {},
      isError: false,
      timestamp: 3,
    });
    h2Session.appendMessage({
      role: "toolResult",
      toolCallId: "call_pi_write",
      toolName: "add_ad_hoc_note",
      content: [
        {
          type: "text",
          text: `{"status":"staged","path":"extensions/ad_hoc/notes/${adHocNoteFilename}"}`,
        },
      ],
      details: {},
      isError: false,
      timestamp: 4,
    });
    h2Session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Sandbox H2 complete" }],
      api: "openai-responses",
      provider: "openai-codex",
      model: "gpt-6-luna",
      usage: {
        input: 5,
        output: 3,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 8,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 5,
    });
    // Exercise the API H2 endpoint with a compacted native candidate; the
    // larger original remains test-owned and is never persisted as H2.
    const { original: originalH2, bounded: h2 } = boundedPiCheckpointHistory(
      h2Session.toJsonl(),
    );
    expect(Buffer.byteLength(originalH2)).toBeGreaterThan(
      Buffer.byteLength(h2),
    );
    const originalNative = MemoryPiSession.fromJsonl(originalH2);
    const boundedNative = MemoryPiSession.fromJsonl(h2);
    expect(boundedNative.buildSessionContext()).toStrictEqual(
      originalNative.buildSessionContext(),
    );
    expect(boundedNative.isSettledCheckpoint()).toBeTruthy();
    expect(boundedNative.getSessionId()).toBe(run.threadId);
    const h2Hash = createHash("sha256").update(h2).digest("hex");
    const preparedH2 = await webhooks.requestAgentSessionHistoryPrepare(
      {
        runId: run.runId,
        hash: h2Hash,
        rawSize: Buffer.byteLength(h2),
        encodedSize: Buffer.byteLength(h2),
        encoding: "identity",
      },
      claimed.sandboxHeaders,
      [200],
    );
    expect(preparedH2.body).toMatchObject({
      existing: false,
      encoding: "identity",
    });
    historyObjects.set(
      `${env("R2_USER_STORAGES_BUCKET_NAME")}/blobs/${h2Hash}.blob`,
      Buffer.from(h2, "utf8"),
    );
    const checkpointedMemory = await commitMemoryVersion(
      context,
      {
        runId: run.runId,
        sandboxHeaders: claimed.sandboxHeaders,
        storageManifest: claimed.claim.storageManifest,
      },
      [
        {
          path: `extensions/ad_hoc/notes/${adHocNoteFilename}`,
          content: adHocNote,
        },
      ],
    );
    expect(checkpointedMemory.storageId).toBe(lunaMemoryMount.storageId);
    const memoryArtifactSnapshots = [
      {
        name: lunaMemoryMount.name,
        version: checkpointedMemory.versionId,
        mountPath: lunaMemoryMount.mountPath,
        ...(lunaMemoryMount.missingRootPolicy === undefined
          ? {}
          : {
              missingRootPolicy: lunaMemoryMount.missingRootPolicy,
            }),
      },
    ];
    const combinedH2 = await webhooks.requestAgentComplete(
      {
        runId: run.runId,
        exitCode: 0,
        completion: {
          cliAgentType: "pi",
          cliAgentSessionId: run.threadId,
          cliAgentSessionHistoryHash: h2Hash,
          artifactSnapshots: memoryArtifactSnapshots,
        },
      },
      claimed.sandboxHeaders,
      [200],
      undefined,
    );
    expect(combinedH2.body).toStrictEqual({
      success: true,
      status: "completed",
    });
    await waitForRunStatus(actor, run.runId, "completed");
    await flushWaitUntilForTest();
    await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
      result: {
        artifact: { memory: checkpointedMemory.versionId },
      },
    });
    const committedH2 = await webhooks.requestAgentRunOutputs(
      {
        runId: run.runId,
        cliAgentType: "pi",
        cliAgentSessionId: run.threadId,
        cliAgentSessionHistoryHash: h2Hash,
        artifactSnapshots: memoryArtifactSnapshots,
      },
      claimed.sandboxHeaders,
      [200],
    );
    expect(committedH2.body).toStrictEqual({
      success: true,
      status: "completed",
    });
    const committedResult = (await api.readRun(actor, run.runId)).result;
    const idempotentH2 = await webhooks.requestAgentRunOutputs(
      {
        runId: run.runId,
        cliAgentType: "pi",
        cliAgentSessionId: run.threadId,
        cliAgentSessionHistoryHash: h2Hash,
        artifactSnapshots: memoryArtifactSnapshots,
      },
      claimed.sandboxHeaders,
      [200],
    );
    expect(idempotentH2.body).toStrictEqual(committedH2.body);
    expect((await api.readRun(actor, run.runId)).result).toStrictEqual(
      committedResult,
    );

    h2Session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "late replacement H2" }],
      api: "openai-responses",
      provider: "openai-codex",
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
      timestamp: 4,
    });
    const replacementH2 = h2Session.toJsonl();
    expect(
      MemoryPiSession.fromJsonl(replacementH2).isSettledCheckpoint(),
    ).toBeTruthy();
    const replacementH2Hash = createHash("sha256")
      .update(replacementH2)
      .digest("hex");
    await webhooks.requestAgentSessionHistoryPrepare(
      {
        runId: run.runId,
        hash: replacementH2Hash,
        rawSize: Buffer.byteLength(replacementH2),
        encodedSize: Buffer.byteLength(replacementH2),
        encoding: "identity",
      },
      claimed.sandboxHeaders,
      [200],
    );
    historyObjects.set(
      `${env("R2_USER_STORAGES_BUCKET_NAME")}/blobs/${replacementH2Hash}.blob`,
      Buffer.from(replacementH2, "utf8"),
    );
    const replacementCheckpoint = await webhooks.requestAgentRunOutputs(
      {
        runId: run.runId,
        cliAgentType: "pi",
        cliAgentSessionId: run.threadId,
        cliAgentSessionHistoryHash: replacementH2Hash,
      },
      claimed.sandboxHeaders,
      [400],
    );
    expect(JSON.stringify(replacementCheckpoint.body)).toContain(
      "[RUN_OUTPUT_ALREADY_COMMITTED]",
    );

    const failedRun = await sendChatRunAfterPick(actor, {
      agentId,
      threadId: run.threadId,
      prompt: "reject a non-native Sandbox H2",
    });
    const failedClaim = await claimChatRun(runnerGroup, failedRun.runId);
    const invalidH2 = Buffer.from(`${h2}{malformed\n`, "utf8");
    const invalidH2Hash = createHash("sha256").update(invalidH2).digest("hex");
    await webhooks.requestAgentSessionHistoryPrepare(
      {
        runId: failedRun.runId,
        hash: invalidH2Hash,
        rawSize: invalidH2.length,
        encodedSize: invalidH2.length,
        encoding: "identity",
      },
      failedClaim.sandboxHeaders,
      [200],
    );
    historyObjects.set(
      `${env("R2_USER_STORAGES_BUCKET_NAME")}/blobs/${invalidH2Hash}.blob`,
      invalidH2,
    );
    const invalidCheckpoint = await webhooks.requestAgentComplete(
      {
        runId: failedRun.runId,
        exitCode: 1,
        error: "reject invalid native checkpoint",
        completion: {
          cliAgentType: "pi",
          cliAgentSessionId: run.threadId,
          cliAgentSessionHistoryHash: invalidH2Hash,
        },
      },
      failedClaim.sandboxHeaders,
      [400],
    );
    expect(JSON.stringify(invalidCheckpoint.body)).toContain(
      "[PI_H2_JSONL_INVALID]",
    );
    await webhooks.requestAgentComplete(
      {
        runId: failedRun.runId,
        exitCode: 1,
        error: "[PI_H2_JSONL_INVALID] rejected native checkpoint",
      },
      failedClaim.sandboxHeaders,
      [200],
    );
    await waitForRunStatus(actor, failedRun.runId, "failed");
    await flushWaitUntilForTest();
    const lateFailedH2 = await webhooks.requestAgentComplete(
      {
        runId: failedRun.runId,
        exitCode: 1,
        completion: {
          cliAgentType: "pi",
          cliAgentSessionId: run.threadId,
          cliAgentSessionHistoryHash: h2Hash,
        },
      },
      failedClaim.sandboxHeaders,
      [400],
    );
    expect(JSON.stringify(lateFailedH2.body)).toContain("[PI_H2_RUN_TERMINAL]");
    const spoofedFailedH2 = await webhooks.requestAgentRunOutputs(
      {
        runId: failedRun.runId,
        cliAgentType: "claude-code",
        cliAgentSessionId: run.threadId,
        cliAgentSessionHistoryHash: h2Hash,
      },
      failedClaim.sandboxHeaders,
      [400],
    );
    expect(JSON.stringify(spoofedFailedH2.body)).toContain(
      "[PI_H2_TYPE_MISMATCH]",
    );
    const cancelledRun = await sendChatRunAfterPick(actor, {
      agentId,
      threadId: run.threadId,
      model,
      prompt: "reject H2 after an explicit Pi run is cancelled",
    });
    const cancelledClaim = await claimChatRun(runnerGroup, cancelledRun.runId);
    await cancelChatRun(
      actor,
      cancelledRun.runId,
      cancelledClaim.sandboxHeaders,
    );
    const lateCancelledH2 = await webhooks.requestAgentComplete(
      {
        runId: cancelledRun.runId,
        exitCode: 1,
        completion: {
          cliAgentType: "pi",
          cliAgentSessionId: run.threadId,
          cliAgentSessionHistoryHash: h2Hash,
        },
      },
      cancelledClaim.sandboxHeaders,
      [400],
    );
    expect(JSON.stringify(lateCancelledH2.body)).toContain(
      "[PI_H2_RUN_TERMINAL]",
    );

    const retry = await sendChatRunAfterPick(actor, {
      agentId,
      threadId: run.threadId,
      prompt: "resume only the last completed Pi checkpoint",
    });
    const retryClaim = await claimChatRun(runnerGroup, retry.runId);
    expect(retryClaim.claim.resumeSession).toMatchObject({
      sessionId: run.threadId,
      historyRef: { kind: "blob", hash: h2Hash },
    });
    const retryFailure = await webhooks.requestAgentComplete(
      {
        runId: retry.runId,
        exitCode: 1,
        error: "guest reported Pi failure without a new checkpoint",
      },
      retryClaim.sandboxHeaders,
      [200],
    );
    expect(retryFailure.body).toStrictEqual({
      success: true,
      status: "failed",
    });
    await waitForRunStatus(actor, retry.runId, "failed");
    const retryLateFailedH2 = await webhooks.requestAgentRunOutputs(
      {
        runId: retry.runId,
        cliAgentType: "pi",
        cliAgentSessionId: run.threadId,
        cliAgentSessionHistoryHash: h2Hash,
      },
      retryClaim.sandboxHeaders,
      [400],
    );
    expect(JSON.stringify(retryLateFailedH2.body)).toContain(
      "[PI_H2_RUN_TERMINAL]",
    );

    const reportedFailureRun = await sendChatRunAfterPick(actor, {
      agentId,
      threadId: run.threadId,
      prompt: "retry one atomically reported Pi failure",
    });
    const reportedFailureClaim = await claimChatRun(
      runnerGroup,
      reportedFailureRun.runId,
    );
    const reportedFailureBody = {
      runId: reportedFailureRun.runId,
      exitCode: 1,
      error: "guest reported Pi failure",
      completion: {
        cliAgentType: "pi",
        cliAgentSessionId: run.threadId,
        cliAgentSessionHistoryHash: h2Hash,
      },
    } as const;
    const reportedFailure = await webhooks.requestAgentComplete(
      reportedFailureBody,
      reportedFailureClaim.sandboxHeaders,
      [200],
    );
    expect(reportedFailure.body).toStrictEqual({
      success: true,
      status: "failed",
    });
    await waitForRunStatus(actor, reportedFailureRun.runId, "failed");
    await flushWaitUntilForTest();
    const repeatedReportedFailure = await webhooks.requestAgentComplete(
      reportedFailureBody,
      reportedFailureClaim.sandboxHeaders,
      [200],
    );
    expect(repeatedReportedFailure.body).toStrictEqual(reportedFailure.body);
    const repeatedCombinedH2 = await webhooks.requestAgentComplete(
      {
        runId: run.runId,
        exitCode: 0,
        completion: {
          cliAgentType: "pi",
          cliAgentSessionId: run.threadId,
          cliAgentSessionHistoryHash: h2Hash,
          artifactSnapshots: memoryArtifactSnapshots,
        },
      },
      claimed.sandboxHeaders,
      [200],
    );
    expect(repeatedCombinedH2.body).toStrictEqual(combinedH2.body);
    const probe = await sendChatRunAfterPick(actor, {
      agentId,
      threadId: run.threadId,
      prompt: "verify the canonical completed checkpoint after rejected writes",
    });
    const probeClaim = await claimChatRun(runnerGroup, probe.runId);
    expect(probeClaim.claim.resumeSession).toMatchObject({
      sessionId: run.threadId,
      historyRef: { kind: "blob", hash: h2Hash },
    });
    await cancelChatRun(actor, probe.runId, probeClaim.sandboxHeaders);

    // Switching the thread to the Claude Code route must not resume the Pi
    // checkpoint; the org keeps the Pi route as its default.

    await api.updateUserModelPreference(actor, model);
    const explicitResume = await api.createThreadRun(actor, {
      agentId,
      threadId: run.threadId,
      prompt: "keep an incompatible run off the Pi checkpoint",
      model: "claude-fable-5-1",
    });
    const explicitResumeClaim = await api.claimRunnerJob(explicitResume.runId);
    expect(explicitResumeClaim.cliAgentType).toBe("claude-code");
    expect(explicitResumeClaim.resumeSession).toBeNull();
    await cancelChatRun(actor, explicitResume.runId, {
      authorization: `Bearer ${explicitResumeClaim.sandboxToken}`,
    });
  }

  it(
    "launches personal Codex in the Sandbox, captures guest tool activity, and checkpoints Pi memory notes",
    piActivityScenario,
    150_000,
  );

  // Preserved from the original combined scenario. Its managed key/pricing
  // factory remains unprocessed by #37440; it is not a public memory writer.
  it("deduplicates built-in model usage across repeated H2 completion", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const usagePricingResolution =
      await createPiUsagePricingResolution("okou-1.0");
    const model = await configureBuiltInPiModelOnOpenRouter(actor, "okou-1.0");
    mockPiResourceArchiveDownloads();
    const historyObjects = mockPiCheckpointObjectStore();
    const prompt = "retain the built-in model usage receipt";
    const run = await sendChatRunAfterPick(
      actor,
      { agentId, prompt, model },
      usagePricingResolution,
    );
    const claimed = await claimChatRun(runnerGroup, run.runId);
    expect(claimed.claim.piModelConfig).toMatchObject({
      provider: "openrouter",
      model: "@preset/okou-1-0",
    });
    const usageEvent = {
      idempotencyKey: randomUUID(),
      kind: "model" as const,
      provider: "okou-1.0",
      category: "tokens.output",
      quantity: 2,
    };
    const receipts = await Promise.all([
      webhooks.requestAgentUsageEvent(
        { runId: run.runId, events: [usageEvent] },
        claimed.sandboxHeaders,
        [200],
        usagePricingResolution,
      ),
      webhooks.requestAgentUsageEvent(
        { runId: run.runId, events: [usageEvent] },
        claimed.sandboxHeaders,
        [200],
        usagePricingResolution,
      ),
    ]);
    expect(
      receipts.map((receipt) => {
        return receipt.body;
      }),
    ).toStrictEqual([{ success: true }, { success: true }]);

    const session = MemoryPiSession.fromJsonl(
      piSandboxBaseSession(claimed.claim, historyObjects).toString("utf8"),
    );
    session.appendMessage({ role: "user", content: prompt, timestamp: 1 });
    session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "built-in usage recorded" }],
      api: "openai-responses",
      provider: "openrouter",
      model: "@preset/okou-1-0",
      usage: {
        input: 0,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    });
    const h2 = Buffer.from(session.toJsonl(), "utf8");
    const hash = createHash("sha256").update(h2).digest("hex");
    await webhooks.requestAgentSessionHistoryPrepare(
      {
        runId: run.runId,
        hash,
        rawSize: h2.length,
        encodedSize: h2.length,
        encoding: "identity",
      },
      claimed.sandboxHeaders,
      [200],
    );
    historyObjects.set(
      `${env("R2_USER_STORAGES_BUCKET_NAME")}/blobs/${hash}.blob`,
      h2,
    );
    await webhooks.requestAgentEvents(
      {
        runId: run.runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 1,
            message: {
              content: [{ type: "text", text: "built-in usage recorded" }],
            },
          },
          {
            type: "result",
            sequenceNumber: 2,
            result: "built-in usage recorded",
          },
        ],
      },
      claimed.sandboxHeaders,
      [200],
    );
    const completion = {
      runId: run.runId,
      exitCode: 0,
      lastEventSequence: 2,
      completion: {
        cliAgentType: "pi",
        cliAgentSessionId: run.threadId,
        cliAgentSessionHistoryHash: hash,
      },
    } as const;
    const first = await webhooks.requestAgentComplete(
      completion,
      claimed.sandboxHeaders,
      [200],
      undefined,
      usagePricingResolution,
    );
    expect(first.body).toStrictEqual({ success: true, status: "completed" });
    await flushWaitUntilForTest();
    await expectThreadModelTokens(context, actor, run.threadId, 2);
    const repeated = await webhooks.requestAgentComplete(
      completion,
      claimed.sandboxHeaders,
      [200],
      undefined,
      usagePricingResolution,
    );
    expect(repeated.body).toStrictEqual(first.body);
    await flushWaitUntilForTest();
    await expectThreadModelTokens(context, actor, run.threadId, 2);
  });
});
