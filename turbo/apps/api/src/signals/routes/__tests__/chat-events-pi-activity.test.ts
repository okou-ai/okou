import { chatThreadActivitySummaryContract } from "@okouai/api-contracts/contracts/chat-thread-activity-summary";
import { chatThreadActivitySummaryRoutes } from "../chat-threads-activity-summary";
import { createHash, randomUUID } from "node:crypto";
import { PI_MEMORY_ROOT } from "@okouai/api-contracts/contracts/runners";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { MemoryPiSession } from "@okouai/pi-agent-runtime/node";
import { http, HttpResponse } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { env, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import {
  holdAgentRunRowLockFixture,
  holdThreadSessionConversationClearFixture,
  readRunUsageEventsFixture,
} from "../../../test-fixtures/chat-events";
import {
  readPiConversationIdentityFixture,
  readPiMemoryStage1CandidateFixture,
} from "../../../test-fixtures/pi-memory-stage1-candidates";
import { flushWaitUntilForTest } from "../../context/wait-until";
import type { ApiTestUser } from "./helpers/api-bdd";
import { expectCanonicalStorageManifest } from "./helpers/api-bdd-runs";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { commitMemoryVersion } from "./helpers/memory";
import { readThreadSessionConversation } from "./helpers/runtime-state";
import {
  createChatEventsFixture,
  openRouterBodySchema,
  requireOrgId,
  createGptUsagePricingResolution,
  claimEnvironment,
  eventBackedContents,
} from "./helpers/chat-events-fixture";

const context = testContext();
const {
  api,
  chat,
  webhooks,
  entitledChatActor,
  configureBuiltInPiModelOnOpenRouter,
  sendChatRun,
  claimChatRun,
  waitForRunStatus,
  cancelChatRun,
  sessionHeaders,
  mockPiCheckpointObjectStore,
  mockPiResourceArchiveDownloads,
  expectPiSandboxHandoff,
} = createChatEventsFixture(context);

async function expectPiActivitySummary(
  actor: ApiTestUser,
  run: { readonly threadId: string; readonly runId: string },
): Promise<void> {
  // Guest tool events are captured as activity while the run is still active.
  await flushWaitUntilForTest();
  mockOptionalEnv("OPENROUTER_API_KEY", "activity-summary-key");
  let activityInput = "";
  server.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      async ({ request }) => {
        const body = openRouterBodySchema.parse(await request.json());
        activityInput = body.messages
          .map((message) => {
            return message.content;
          })
          .join("\n");
        return HttpResponse.json({
          choices: [
            {
              finish_reason: "stop",
              message: { content: "Checking the CLI and preparing the note" },
            },
          ],
        });
      },
    ),
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
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
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

describe("CHAT-02: model-first provider policies", () => {
  async function piActivityScenario(): Promise<void> {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const orgId = requireOrgId(actor);
    const usagePricingResolution = await createGptUsagePricingResolution();
    const withOpenRouterRoute = await configureBuiltInPiModelOnOpenRouter(
      actor,
      "gpt-5.6-terra",
    );
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
    const checkpointObjects = mockPiCheckpointObjectStore();
    const prompt = "use the Okou CLI through the Sandbox handoff";
    const run = await withOpenRouterRoute(async () => {
      return await sendChatRun(
        actor,
        {
          agentId,
          prompt,
          model: "gpt-5.6-terra",
          runOptions: { codexServiceTier: "fast" },
        },
        usagePricingResolution,
      );
    });
    const manifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/manifest.json`;
    const handoff = expectPiSandboxHandoff(run.runId, checkpointObjects);
    expect(handoff.manifest).toMatchObject({
      schemaVersion: 3,
      baseSession: { sessionId: run.threadId, sha256: null },
      session: {
        sessionId: run.threadId,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        rawSize: expect.any(Number),
      },
      sandboxEventSequenceStart: 1,
    });
    if (!handoff.session) {
      throw new Error("Expected the sandbox-first H0 session");
    }
    const h2Session = MemoryPiSession.fromJsonl(
      handoff.session.toString("utf8"),
    );
    await flushWaitUntilForTest();
    const claimed = await claimChatRun(runnerGroup, run.runId);
    expect(claimed.claim.cliAgentType).toBe("pi");
    expect(claimed.claim.piSessionId).toBe(run.threadId);
    expect(claimed.claim.piModelConfig).toMatchObject({
      provider: "openrouter",
      serviceTier: "priority",
    });
    expect(claimed.claim.piModelConfig).not.toHaveProperty("api");
    expect(claimed.claim.piLaunchConfig).toMatchObject({
      schemaVersion: 2,
      apiFirstTurn: {
        schemaVersion: 1,
        baseSession: { sessionId: run.threadId, sha256: null },
        sandboxEventSequenceStart: 1,
      },
    });
    const terraEnvironment = claimEnvironment(claimed.claim);
    expect(terraEnvironment.OKOU_TOKEN).toBeTruthy();
    expect(terraEnvironment.CLI_PKG_URL).toBeTruthy();
    const terraInstructions = claimed.claim.appendSystemPrompt;
    if (!terraInstructions) {
      throw new Error("Expected Terra Web instructions");
    }
    expect(terraInstructions).toContain(
      "You are currently running inside: Web",
    );
    expect(terraInstructions).toContain("okou web download-file -h");
    expect(terraInstructions).toContain("Run commands with: `okou <command>`");
    expect(terraInstructions).not.toMatch(/auto.?memory/iu);
    const terraStorageManifest = expectCanonicalStorageManifest(
      claimed.claim.storageManifest,
    );
    if (!terraStorageManifest) {
      throw new Error("Expected Terra storage manifest");
    }
    const terraMounts = terraStorageManifest.storageMounts;
    const terraMemoryMount = terraMounts.find((mount) => {
      return mount.name === "memory" && mount.mountPath === PI_MEMORY_ROOT;
    });
    if (!terraMemoryMount) {
      throw new Error("Expected the Pi memory mount");
    }
    expect(claimed.claim.prompt).toBe(prompt);
    const sandboxUsageEvent = {
      idempotencyKey: randomUUID(),
      kind: "model" as const,
      provider: "gpt-5.6-terra",
      category: "tokens.output.fast",
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
      provider: "openrouter",
      model: "openai/gpt-5.6-terra",
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
      provider: "openrouter",
      model: "openai/gpt-5.6-terra",
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
    const preparedH2 = await webhooks.requestAgentCheckpointPrepareHistory(
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
    checkpointObjects.set(
      `${env("R2_USER_STORAGES_BUCKET_NAME")}/blobs/${h2Hash}.blob`,
      Buffer.from(h2, "utf8"),
    );
    const checkpointedMemory = await commitMemoryVersion(context, actor, [
      {
        path: `extensions/ad_hoc/notes/${adHocNoteFilename}`,
        content: adHocNote,
      },
    ]);
    expect(checkpointedMemory.storageId).toBe(terraMemoryMount.storageId);
    const memoryArtifactSnapshots = [
      {
        name: terraMemoryMount.name,
        version: checkpointedMemory.versionId,
        mountPath: terraMemoryMount.mountPath,
        ...(terraMemoryMount.missingRootPolicy === undefined
          ? {}
          : {
              missingRootPolicy: terraMemoryMount.missingRootPolicy,
            }),
      },
    ];
    const combinedH2 = await webhooks.requestAgentComplete(
      {
        runId: run.runId,
        exitCode: 0,
        checkpoint: {
          cliAgentType: "pi",
          cliAgentSessionId: run.threadId,
          cliAgentSessionHistoryHash: h2Hash,
          artifactSnapshots: memoryArtifactSnapshots,
        },
      },
      claimed.sandboxHeaders,
      [200],
      undefined,
      usagePricingResolution,
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
    // Pi usage is Sandbox-reported only; the duplicate receipt is idempotent.
    await expect(readRunUsageEventsFixture(run.runId)).resolves.toStrictEqual([
      expect.objectContaining({
        provider: "gpt-5.6-terra",
        category: "tokens.output.fast",
        quantity: 2,
        status: "processed",
        billingError: null,
      }),
    ]);
    const committedH2 = await webhooks.requestAgentCheckpoint(
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
    const committedH2Body = committedH2.body;
    if ("error" in committedH2Body) {
      throw new Error(
        `Expected H2 checkpoint success: ${committedH2Body.error.message}`,
      );
    }
    expect(checkpointObjects.has(manifestKey)).toBeFalsy();
    expect(
      checkpointObjects.has(
        `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/session.jsonl`,
      ),
    ).toBeFalsy();
    const canonicalConversation = await readThreadSessionConversation(
      context,
      run.threadId,
    );
    expect(canonicalConversation).toMatchObject({
      conversation_run_id: run.runId,
    });
    const sandboxConversation = await readPiConversationIdentityFixture(
      run.runId,
    );
    await expect(
      readPiMemoryStage1CandidateFixture({
        orgId,
        userId: actor.userId,
      }),
    ).resolves.toBeNull();
    expect(sandboxConversation).toMatchObject({
      piSessionId: run.threadId,
      sourceHistoryHash: h2Hash,
    });

    const idempotentH2 = await webhooks.requestAgentCheckpoint(
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
    expect(idempotentH2.body).toMatchObject({
      checkpointId: committedH2Body.checkpointId,
      conversationId: committedH2Body.conversationId,
    });

    h2Session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "late replacement H2" }],
      api: "openai-responses",
      provider: "openrouter",
      model: "openai/gpt-5.6-terra",
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
    await webhooks.requestAgentCheckpointPrepareHistory(
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
    checkpointObjects.set(
      `${env("R2_USER_STORAGES_BUCKET_NAME")}/blobs/${replacementH2Hash}.blob`,
      Buffer.from(replacementH2, "utf8"),
    );
    const replacementCheckpoint = await webhooks.requestAgentCheckpoint(
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
      "[PI_H2_ALREADY_COMMITTED]",
    );
    await expect(
      readThreadSessionConversation(context, run.threadId),
    ).resolves.toStrictEqual(canonicalConversation);

    const failedHandoff = await withOpenRouterRoute(async () => {
      return await sendChatRun(actor, {
        agentId,
        threadId: run.threadId,
        prompt: "reject a non-native Sandbox H2",
      });
    });
    const failedManifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${failedHandoff.runId}/manifest.json`;
    await expect
      .poll(() => {
        return checkpointObjects.has(failedManifestKey);
      })
      .toBe(true);
    const failedClaim = await claimChatRun(runnerGroup, failedHandoff.runId);
    const invalidH2 = Buffer.from(`${h2}{malformed\n`, "utf8");
    const invalidH2Hash = createHash("sha256").update(invalidH2).digest("hex");
    await webhooks.requestAgentCheckpointPrepareHistory(
      {
        runId: failedHandoff.runId,
        hash: invalidH2Hash,
        rawSize: invalidH2.length,
        encodedSize: invalidH2.length,
        encoding: "identity",
      },
      failedClaim.sandboxHeaders,
      [200],
    );
    checkpointObjects.set(
      `${env("R2_USER_STORAGES_BUCKET_NAME")}/blobs/${invalidH2Hash}.blob`,
      invalidH2,
    );
    const invalidCheckpoint = await webhooks.requestAgentComplete(
      {
        runId: failedHandoff.runId,
        exitCode: 1,
        error: "reject invalid native checkpoint",
        checkpoint: {
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
    await expect(
      readThreadSessionConversation(context, run.threadId),
    ).resolves.toStrictEqual(canonicalConversation);
    await webhooks.requestAgentComplete(
      {
        runId: failedHandoff.runId,
        exitCode: 1,
        error: "[PI_H2_JSONL_INVALID] rejected native checkpoint",
      },
      failedClaim.sandboxHeaders,
      [200],
    );
    await waitForRunStatus(actor, failedHandoff.runId, "failed");
    await flushWaitUntilForTest();
    expect(checkpointObjects.has(failedManifestKey)).toBeFalsy();
    const lateFailedH2 = await webhooks.requestAgentComplete(
      {
        runId: failedHandoff.runId,
        exitCode: 1,
        checkpoint: {
          cliAgentType: "pi",
          cliAgentSessionId: run.threadId,
          cliAgentSessionHistoryHash: h2Hash,
        },
      },
      failedClaim.sandboxHeaders,
      [400],
    );
    expect(JSON.stringify(lateFailedH2.body)).toContain("[PI_H2_RUN_TERMINAL]");
    const spoofedFailedH2 = await webhooks.requestAgentCheckpoint(
      {
        runId: failedHandoff.runId,
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
    await expect(
      readThreadSessionConversation(context, run.threadId),
    ).resolves.toStrictEqual(canonicalConversation);

    if (!canonicalConversation.agent_session_id) {
      throw new Error("Expected the completed Pi run to own an AgentSession");
    }
    const explicitResume = await api.createRun(actor, {
      agentId,
      sessionId: canonicalConversation.agent_session_id,
      prompt: "keep an incompatible direct run off the Pi checkpoint",
    });
    const explicitResumeClaim = await api.claimRunnerJob(explicitResume.runId);
    expect(explicitResumeClaim.cliAgentType).toBe("claude-code");
    expect(explicitResumeClaim.resumeSession).toBeNull();
    await api.requestCancelRun(actor, explicitResume.runId, [200]);
    await waitForRunStatus(actor, explicitResume.runId, "cancelled");

    const cancelledHandoff = await withOpenRouterRoute(async () => {
      return await sendChatRun(actor, {
        agentId,
        threadId: run.threadId,
        prompt: "reject H2 after an explicit Pi handoff is cancelled",
      });
    });
    const cancelledManifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${cancelledHandoff.runId}/manifest.json`;
    await expect
      .poll(() => {
        return checkpointObjects.has(cancelledManifestKey);
      })
      .toBe(true);
    const cancelledClaim = await claimChatRun(
      runnerGroup,
      cancelledHandoff.runId,
    );
    await cancelChatRun(
      actor,
      cancelledHandoff.runId,
      cancelledClaim.sandboxHeaders,
    );
    const lateCancelledH2 = await webhooks.requestAgentComplete(
      {
        runId: cancelledHandoff.runId,
        exitCode: 1,
        checkpoint: {
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
    await expect(
      readThreadSessionConversation(context, run.threadId),
    ).resolves.toStrictEqual(canonicalConversation);

    const racedHandoff = await withOpenRouterRoute(async () => {
      return await sendChatRun(actor, {
        agentId,
        threadId: run.threadId,
        prompt: "reject standalone H2 during an early successful completion",
      });
    });
    const racedManifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${racedHandoff.runId}/manifest.json`;
    await expect
      .poll(() => {
        return checkpointObjects.has(racedManifestKey);
      })
      .toBe(true);
    const racedClaim = await claimChatRun(runnerGroup, racedHandoff.runId);
    const lifecycleGate = await holdAgentRunRowLockFixture({
      runId: racedHandoff.runId,
      signal: context.signal,
    });
    const ownedRequests: Promise<unknown>[] = [];
    onTestFinished(async () => {
      lifecycleGate.release();
      await Promise.all(ownedRequests);
      await lifecycleGate.done;
    });
    const racedCompletion = webhooks.requestAgentComplete(
      { runId: racedHandoff.runId, exitCode: 0 },
      racedClaim.sandboxHeaders,
      [200],
    );
    ownedRequests.push(Promise.allSettled([racedCompletion]));
    await expect.poll(lifecycleGate.waiterCount).toBe(1);
    const racedCheckpoint = webhooks.requestAgentCheckpoint(
      {
        runId: racedHandoff.runId,
        cliAgentType: "pi",
        cliAgentSessionId: run.threadId,
        cliAgentSessionHistoryHash: h2Hash,
      },
      racedClaim.sandboxHeaders,
      [400],
    );
    ownedRequests.push(Promise.allSettled([racedCheckpoint]));
    const racedCheckpointResult = await racedCheckpoint;
    expect(JSON.stringify(racedCheckpointResult.body)).toContain(
      "[CHECKPOINT_RUN_NOT_SETTLED]",
    );
    lifecycleGate.release();
    const [, racedCompletionResult] = await Promise.all([
      lifecycleGate.done,
      racedCompletion,
    ] as const);
    expect(racedCompletionResult).toMatchObject({
      body: { success: true, status: "failed" },
    });
    await waitForRunStatus(actor, racedHandoff.runId, "failed");
    await flushWaitUntilForTest();
    await expect(
      readThreadSessionConversation(context, run.threadId),
    ).resolves.toStrictEqual(canonicalConversation);

    const retry = await withOpenRouterRoute(async () => {
      return await sendChatRun(actor, {
        agentId,
        threadId: run.threadId,
        prompt: "resume only the last completed Pi checkpoint",
      });
    });
    expect(
      expectPiSandboxHandoff(retry.runId, checkpointObjects).manifest
        .baseSession,
    ).toStrictEqual({
      sessionId: run.threadId,
      sha256: h2Hash,
    });
    const retryClaim = await claimChatRun(runnerGroup, retry.runId);
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
    const retryLateFailedH2 = await webhooks.requestAgentCheckpoint(
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
    await expect(
      readThreadSessionConversation(context, run.threadId),
    ).resolves.toStrictEqual(canonicalConversation);

    const reportedFailureHandoff = await withOpenRouterRoute(async () => {
      return await sendChatRun(actor, {
        agentId,
        threadId: run.threadId,
        prompt: "retry one atomically reported Pi failure",
      });
    });
    const reportedFailureManifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${reportedFailureHandoff.runId}/manifest.json`;
    await expect
      .poll(() => {
        return checkpointObjects.has(reportedFailureManifestKey);
      })
      .toBe(true);
    const reportedFailureClaim = await claimChatRun(
      runnerGroup,
      reportedFailureHandoff.runId,
    );
    const reportedFailureBody = {
      runId: reportedFailureHandoff.runId,
      exitCode: 1,
      error: "guest reported Pi failure",
      checkpoint: {
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
    await waitForRunStatus(actor, reportedFailureHandoff.runId, "failed");
    await flushWaitUntilForTest();
    const repeatedReportedFailure = await webhooks.requestAgentComplete(
      reportedFailureBody,
      reportedFailureClaim.sandboxHeaders,
      [200],
    );
    expect(repeatedReportedFailure.body).toStrictEqual(reportedFailure.body);
    await expect(
      readThreadSessionConversation(context, run.threadId),
    ).resolves.toStrictEqual(canonicalConversation);

    const conversationClear = await holdThreadSessionConversationClearFixture({
      threadId: run.threadId,
      signal: context.signal,
    });
    conversationClear.release();
    await conversationClear.done;
    const repeatedCombinedH2 = await webhooks.requestAgentComplete(
      {
        runId: run.runId,
        exitCode: 0,
        checkpoint: {
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
  }

  it(
    "launches OpenRouter Terra in the Sandbox, captures guest tool activity, and checkpoints Pi memory notes",
    piActivityScenario,
    150_000,
  );
});
