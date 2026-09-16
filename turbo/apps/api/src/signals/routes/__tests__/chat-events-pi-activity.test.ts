import { sessionOutputDeltaSchema } from "@okouai/api-contracts/contracts/realtime";
import { chatThreadActivitySummaryContract } from "@okouai/api-contracts/contracts/chat-thread-activity-summary";
import { chatThreadActivitySummaryRoutes } from "../chat-threads-activity-summary";
import { createHash, randomUUID } from "node:crypto";
import {
  PI_MEMORY_ROOT,
  piApiFirstTurnManifestSchema,
} from "@okouai/api-contracts/contracts/runners";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { MemoryPiSession } from "@okouai/pi-agent-runtime/node";
import { http, HttpResponse } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { env, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import {
  holdAgentRunRowLockFixture,
  holdThreadSessionConversationClearFixture,
  readRunUsageEventsFixture,
  timeoutRunWithoutCallbacksFixture,
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
import { runInIsolatedProcess } from "../../../../../../scripts/run-isolated-test.mjs";
import {
  createChatEventsFixture,
  openRouterBodySchema,
  requireOrgId,
  createGptUsagePricingResolution,
  claimEnvironment,
  eventBackedContents,
} from "./helpers/chat-events-fixture";
import {
  piResponsesContentSse,
  piResponsesToolSse,
} from "./helpers/pi-responses";

const context = testContext();
const {
  api,
  chat,
  webhooks,
  entitledChatActor,
  configureBuiltInPiModelOnOpenRouter,
  sendChatRun,
  claimChatRun,
  waitForThreadMessages,
  waitForRunStatus,
  cancelChatRun,
  sessionHeaders,
  mockPiCheckpointObjectStore,
  mockPiResourceArchiveDownloads,
} = createChatEventsFixture(context);

async function expectPiActivitySummaryBeforeGuestReplay(
  actor: ApiTestUser,
  run: { readonly threadId: string; readonly runId: string },
  activityEnabled: boolean,
): Promise<void> {
  const orgId = requireOrgId(actor);
  // The API-first projection must capture tools before any guest replay/result.
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
  if (!activityEnabled) {
    await accept(
      setupApp({ context, routes: chatThreadActivitySummaryRoutes })(
        chatThreadActivitySummaryContract,
      ).summarize({
        headers: sessionHeaders(actor),
        params: { id: run.threadId },
        body: { runId: run.runId },
      }),
      [403],
    );
    expect(activityInput).toBe("");
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      { [FeatureSwitchKey.ThreadActivitySummary]: true },
    );
  }
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
  if (activityEnabled) {
    expect(activityInput).toContain("okou --help");
    expect(activityInput).toContain("add_ad_hoc_note");
  }
  expect(activityInput).not.toContain(
    "API-first reasoning preserved for Sandbox resume",
  );
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
}

describe("CHAT-02: model-first provider policies", () => {
  async function piActivityScenario(enabled: boolean): Promise<void> {
    if (await runInIsolatedProcess(import.meta.url)) {
      return;
    }
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
        [FeatureSwitchKey.PiLoop]: true,
        [FeatureSwitchKey.PiMemory]: true,
        [FeatureSwitchKey.ThreadActivitySummary]: enabled,
        [FeatureSwitchKey.CodexFastMode]: true,
      },
    );
    mockPiResourceArchiveDownloads();
    const okouCliCommand = `npx --yes --package="\${CLI_PKG_URL}" okou --help`;
    const adHocNoteFilename = "2026-09-05T16-15-00-api-first-checkpoint.md";
    const adHocNote =
      "# API-first checkpoint\n\nPersist this staged sandbox note.\n";
    let modelCalls = 0;
    const terraModelRequests: unknown[] = [];
    server.use(
      http.post(
        "https://openrouter.ai/api/v1/responses",
        async ({ request }) => {
          modelCalls += 1;
          terraModelRequests.push(await request.json());
          return new HttpResponse(
            modelCalls === 1
              ? piResponsesContentSse({
                  blocks: [
                    { type: "text", text: "before parallel tools" },
                    {
                      type: "toolCall",
                      callId: "call_pi_read",
                      name: "bash",
                      arguments: {
                        command: okouCliCommand,
                      },
                    },
                    {
                      type: "toolCall",
                      callId: "call_pi_write",
                      name: "add_ad_hoc_note",
                      arguments: {
                        filename: adHocNoteFilename,
                        note: adHocNote,
                      },
                    },
                    { type: "text", text: "after parallel tools" },
                  ],
                  sequence: modelCalls,
                  includeReasoning: true,
                  observedServiceTier: "priority",
                })
              : piResponsesToolSse({
                  callId: "call_pi_read",
                  name: "bash",
                  arguments: {
                    command: okouCliCommand,
                  },
                  sequence: modelCalls,
                  observedServiceTier: "priority",
                }),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      ),
    );
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
    await expect
      .poll(() => {
        return checkpointObjects.has(manifestKey);
      })
      .toBe(true);
    expect(modelCalls).toBe(1);
    const terraTools = z
      .object({
        tools: z.array(z.object({ name: z.string() }).passthrough()),
        service_tier: z.literal("priority"),
      })
      .passthrough()
      .parse(terraModelRequests[0])
      .tools.map((tool) => {
        return tool.name;
      });
    expect(terraTools).toStrictEqual(
      expect.arrayContaining([
        "read",
        "write",
        "edit",
        "bash",
        "add_ad_hoc_note",
      ]),
    );
    const manifestBytes = checkpointObjects.get(manifestKey);
    if (!manifestBytes) {
      throw new Error("Expected pending-tool ownership-transfer manifest");
    }
    const manifest = piApiFirstTurnManifestSchema.parse(
      JSON.parse(manifestBytes.toString("utf8")),
    );
    expect(manifest).toMatchObject({
      schemaVersion: 3,
      outcome: "ownership-transfer",
      mode: "pending-tool-continuation",
      baseSession: { sessionId: run.threadId, sha256: null },
      session: {
        sessionId: run.threadId,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        rawSize: expect.any(Number),
      },
      sandboxEventSequenceStart: 4,
    });
    const projected = await waitForThreadMessages(
      actor,
      run.threadId,
      (messages) => {
        return eventBackedContents(messages, run.runId).length === 2;
      },
    );
    expect(
      eventBackedContents(projected.events, run.runId).map((message) => {
        return {
          content: message.content,
          sequenceNumber: message.sequenceNumber,
        };
      }),
    ).toStrictEqual([
      { content: "before parallel tools", sequenceNumber: 0 },
      { content: "after parallel tools", sequenceNumber: 3 },
    ]);
    await expect
      .poll(() => {
        return context.mocks.ably.publish.mock.calls.filter(([topic]) => {
          return topic === run.runId;
        }).length;
      })
      .toBe(2);
    const streamed = context.mocks.ably.publish.mock.calls
      .filter(([topic]) => {
        return topic === run.runId;
      })
      .map(([_topic, payload]) => {
        return sessionOutputDeltaSchema.parse(payload);
      });
    expect(
      streamed.map((chunk) => {
        return chunk.delta;
      }),
    ).toStrictEqual(["before parallel tools", "after parallel tools"]);
    expect(
      streamed.every((chunk) => {
        return chunk.chunkIndex === 0;
      }),
    ).toBeTruthy();
    expect(projected.events).toStrictEqual(
      expect.arrayContaining(
        streamed.map((chunk) => {
          return expect.objectContaining({
            id: chunk.eventId,
            eventType: "output.message",
            runId: run.runId,
            runEventId: chunk.runEventId,
            content: chunk.delta,
          });
        }),
      ),
    );
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
    const h1Bytes = checkpointObjects.get(
      `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/session.jsonl`,
    );
    if (!h1Bytes) {
      throw new Error("Expected pending-tool ownership-transfer session");
    }
    const h1 = h1Bytes.toString("utf8");
    expect(h1).toContain('"type":"thinking_level_change"');
    expect(h1).toContain('"thinkingLevel":"max"');
    expect(h1).not.toContain("serviceTier");
    const h2Session = MemoryPiSession.fromJsonl(h1);
    const h1Assistant = [...h2Session.buildSessionContext().messages]
      .reverse()
      .find((message) => {
        return message.role === "assistant";
      });
    const h1Thinking =
      h1Assistant?.role === "assistant"
        ? h1Assistant.content.find((content) => {
            return content.type === "thinking";
          })
        : undefined;
    expect(h1Thinking?.type).toBe("thinking");
    expect(
      h1Thinking?.type === "thinking"
        ? JSON.parse(h1Thinking.thinkingSignature ?? "{}")
        : {},
    ).toMatchObject({
      type: "reasoning",
      content: [
        {
          type: "reasoning_text",
          text: "API-first reasoning preserved for Sandbox resume",
        },
      ],
    });
    expect(
      h1Assistant?.role === "assistant"
        ? h1Assistant.content
            .filter((content) => {
              return content.type !== "thinking";
            })
            .map((content) => {
              return content.type === "text"
                ? { type: content.type, text: content.text }
                : {
                    type: content.type,
                    id: content.id,
                    name: content.name,
                  };
            })
        : [],
    ).toStrictEqual([
      { type: "text", text: "before parallel tools" },
      {
        type: "toolCall",
        id: "call_pi_read|fc_pi_content_1_1",
        name: "bash",
      },
      {
        type: "toolCall",
        id: "call_pi_write|fc_pi_content_1_2",
        name: "add_ad_hoc_note",
      },
      { type: "text", text: "after parallel tools" },
    ]);
    await expectPiActivitySummaryBeforeGuestReplay(actor, run, enabled);

    await webhooks.requestAgentEvents(
      {
        runId: run.runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 0,
            message: {
              content: [{ type: "text", text: "before parallel tools" }],
            },
          },
          {
            type: "assistant",
            sequenceNumber: 1,
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "call_pi_read|fc_pi_content_1_1",
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
            sequenceNumber: 2,
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "call_pi_write|fc_pi_content_1_2",
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
            sequenceNumber: 3,
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
      { content: "before parallel tools", sequenceNumber: 0 },
      { content: "after parallel tools", sequenceNumber: 3 },
    ]);
    h2Session.appendMessage({
      role: "toolResult",
      toolCallId: "call_pi_read|fc_pi_content_1_1",
      toolName: "bash",
      content: [{ type: "text", text: "Okou CLI help output" }],
      details: {},
      isError: false,
      timestamp: 2,
    });
    h2Session.appendMessage({
      role: "toolResult",
      toolCallId: "call_pi_write|fc_pi_content_1_2",
      toolName: "add_ad_hoc_note",
      content: [
        {
          type: "text",
          text: `{"status":"staged","path":"extensions/ad_hoc/notes/${adHocNoteFilename}"}`,
        },
      ],
      details: {},
      isError: false,
      timestamp: 3,
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
      timestamp: 4,
    });
    const h2 = h2Session.toJsonl();
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
    const combinedUsage = await readRunUsageEventsFixture(run.runId);
    expect(
      combinedUsage.filter((row) => {
        return row.category === "tokens.input.fast" && row.quantity === 5;
      }),
    ).toHaveLength(1);
    expect(
      combinedUsage.filter((row) => {
        return row.category === "tokens.output.fast" && row.quantity === 3;
      }),
    ).toHaveLength(1);
    expect(
      combinedUsage.filter((row) => {
        return row.category === "tokens.output.fast" && row.quantity === 2;
      }),
    ).toHaveLength(1);
    expect(combinedUsage).toHaveLength(3);
    expect(
      combinedUsage.every((row) => {
        return (
          row.provider === "gpt-5.6-terra" &&
          row.status === "processed" &&
          row.billingError === null &&
          row.category.endsWith(".fast")
        );
      }),
    ).toBeTruthy();
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
    expect(modelCalls).toBe(1);
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
    expect(modelCalls).toBe(1);

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
    const cyclicH2 = Buffer.from(
      `${h2}${JSON.stringify({ type: "model_change", id: "cycle", parentId: "cycle", timestamp: "2026-09-05T00:00:00.000Z", provider: "openai", modelId: "gpt-5.6-terra" })}\n`,
      "utf8",
    );
    const cyclicH2Hash = createHash("sha256").update(cyclicH2).digest("hex");
    await webhooks.requestAgentCheckpointPrepareHistory(
      {
        runId: failedHandoff.runId,
        hash: cyclicH2Hash,
        rawSize: cyclicH2.length,
        encodedSize: cyclicH2.length,
        encoding: "identity",
      },
      failedClaim.sandboxHeaders,
      [200],
    );
    checkpointObjects.set(
      `${env("R2_USER_STORAGES_BUCKET_NAME")}/blobs/${cyclicH2Hash}.blob`,
      cyclicH2,
    );
    const cyclicCheckpoint = await webhooks.requestAgentComplete(
      {
        runId: failedHandoff.runId,
        exitCode: 1,
        error: "reject cyclic native checkpoint",
        checkpoint: {
          cliAgentType: "pi",
          cliAgentSessionId: run.threadId,
          cliAgentSessionHistoryHash: cyclicH2Hash,
        },
      },
      failedClaim.sandboxHeaders,
      [400],
    );
    expect(JSON.stringify(cyclicCheckpoint.body)).toContain(
      "[PI_H2_JSONL_INVALID]",
    );
    await expect(
      readThreadSessionConversation(context, run.threadId),
    ).resolves.toStrictEqual(canonicalConversation);
    expect(modelCalls).toBe(2);
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
    expect(modelCalls).toBe(2);
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
    expect(modelCalls).toBe(2);

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
    expect(modelCalls).toBe(2);
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
    expect(modelCalls).toBe(3);

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
    expect(modelCalls).toBe(4);

    const retry = await withOpenRouterRoute(async () => {
      return await sendChatRun(actor, {
        agentId,
        threadId: run.threadId,
        prompt: "resume only the last completed Pi checkpoint",
      });
    });
    const retryManifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${retry.runId}/manifest.json`;
    await expect
      .poll(() => {
        return checkpointObjects.has(retryManifestKey);
      })
      .toBe(true);
    const retryManifest = JSON.parse(
      checkpointObjects.get(retryManifestKey)?.toString("utf8") ?? "{}",
    ) as {
      readonly baseSession?: {
        readonly sessionId?: unknown;
        readonly sha256?: unknown;
      };
    };
    expect(retryManifest.baseSession).toStrictEqual({
      sessionId: run.threadId,
      sha256: h2Hash,
    });
    expect(modelCalls).toBe(5);
    const timedOutClaim = await claimChatRun(runnerGroup, retry.runId);
    await timeoutRunWithoutCallbacksFixture({ runId: retry.runId });
    await waitForRunStatus(actor, retry.runId, "timeout");
    const lateTimedOutH2 = await webhooks.requestAgentCheckpoint(
      {
        runId: retry.runId,
        cliAgentType: "pi",
        cliAgentSessionId: run.threadId,
        cliAgentSessionHistoryHash: h2Hash,
      },
      timedOutClaim.sandboxHeaders,
      [400],
    );
    expect(JSON.stringify(lateTimedOutH2.body)).toContain(
      "[PI_H2_RUN_TERMINAL]",
    );
    const timedOutCompletion = await webhooks.requestAgentComplete(
      { runId: retry.runId, exitCode: 0 },
      timedOutClaim.sandboxHeaders,
      [200],
    );
    expect(timedOutCompletion.body).toStrictEqual({
      success: true,
      status: "failed",
    });
    await waitForRunStatus(actor, retry.runId, "timeout");
    await expect(
      readThreadSessionConversation(context, run.threadId),
    ).resolves.toStrictEqual(canonicalConversation);
    expect(modelCalls).toBe(5);

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
    expect(modelCalls).toBe(6);

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

  it.each([false, true])(
    "publishes OpenRouter Responses blocks, hands tools to H2, and checkpoints Pi memory notes (activity: %s)",
    piActivityScenario,
    150_000,
  );
});
