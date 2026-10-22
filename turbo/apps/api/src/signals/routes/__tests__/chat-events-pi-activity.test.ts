import {
  mockGoogleText,
  VERTEX_TEXT_URL,
  vertexTextRequest,
} from "./helpers/google-text";
import { chatThreadActivitySummaryContract } from "@okouai/api-contracts/contracts/chat-thread-activity-summary";
import { chatThreadActivitySummaryRoutes } from "../chat-threads-activity-summary";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import type { ApiTestUser } from "./helpers/api-bdd";
import { chatEventDisplayText } from "./helpers/chat-event";
import {
  createChatEventsFixture,
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
  sendChatRunAfterPick,
  claimChatRun,
  waitForRunStatus,
  cancelChatRun,
  sessionHeaders,
  mockPiResourceArchiveDownloads,
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
  expect(activityInput).toContain("README.md");
  mockOptionalEnv("GCP_LLM_PROJECT_ID", undefined);
}

describe("CHAT-02: model-first routing", () => {
  async function piActivityScenario(): Promise<void> {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const model = "gpt-6-luna";
    await configureSubscriptionPiModel(actor, {}, model);
    mockPiResourceArchiveDownloads();
    const okouCliCommand = "okou --help";
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

    expect(claimed.claim.nativeContinuation).toStrictEqual({
      sessionId: null,
      generationRunId: null,
      recoveryPrompt: null,
    });
    expect(claimed.claim.piModelConfig).toMatchObject({
      provider: "openai-codex",
      model: "gpt-6-luna",
    });
    expect(claimed.claim.piLaunchConfig).toMatchObject({ schemaVersion: 2 });
    const lunaEnvironment = claimEnvironment(claimed.claim);
    expect(lunaEnvironment.OKOU_TOKEN).toBeTruthy();
    const lunaInstructions = claimed.claim.appendSystemPrompt;
    if (!lunaInstructions) {
      throw new Error("Expected Luna Web instructions");
    }
    expect(lunaInstructions).toContain("You are currently running inside: Web");
    expect(lunaInstructions).toContain("okou web download-file -h");
    expect(lunaInstructions).toContain("Run commands with: `okou <command>`");
    expect(claimed.claim.prompt).toBe(prompt);
    await webhooks.requestAgentEvents(
      {
        runId: run.runId,
        events: [
          {
            type: "system",
            subtype: "init",
            session_id: run.threadId,
            sequenceNumber: 0,
          },
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
                  name: "read",
                  input: {
                    path: "README.md",
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

    const storageOutputs: [] = [];
    const combinedCompletion = await webhooks.requestAgentComplete(
      {
        runId: run.runId,
        exitCode: 0,
        completion: {
          cliAgentType: "pi",
          cliAgentSessionId: run.threadId,
          cliAgentSessionHistoryDisposition: "native_only",
          storageOutputs: storageOutputs,
        },
      },
      claimed.sandboxHeaders,
      [200],
      undefined,
    );
    expect(combinedCompletion.body).toStrictEqual({
      success: true,
      status: "completed",
    });
    await waitForRunStatus(actor, run.runId, "completed");
    await flushWaitUntilForTest();
    await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
      result: {
        storageOutputs: storageOutputs,
      },
    });
    const committedOutputs = await webhooks.requestAgentRunOutputs(
      {
        runId: run.runId,
        cliAgentType: "pi",
        cliAgentSessionId: run.threadId,
        cliAgentSessionHistoryDisposition: "native_only",
        storageOutputs: storageOutputs,
      },
      claimed.sandboxHeaders,
      [200],
    );
    expect(committedOutputs.body).toStrictEqual({
      success: true,
      status: "completed",
    });
    const committedResult = (await api.readRun(actor, run.runId)).result;
    const idempotentOutputs = await webhooks.requestAgentRunOutputs(
      {
        runId: run.runId,
        cliAgentType: "pi",
        cliAgentSessionId: run.threadId,
        cliAgentSessionHistoryDisposition: "native_only",
        storageOutputs: storageOutputs,
      },
      claimed.sandboxHeaders,
      [200],
    );
    expect(idempotentOutputs.body).toStrictEqual(committedOutputs.body);
    expect((await api.readRun(actor, run.runId)).result).toStrictEqual(
      committedResult,
    );

    const replacementOutputs = await webhooks.requestAgentRunOutputs(
      {
        runId: run.runId,
        cliAgentType: "pi",
        cliAgentSessionId: "different-native-identity",
        cliAgentSessionHistoryDisposition: "native_only",
      },
      claimed.sandboxHeaders,
      [400],
    );
    expect(JSON.stringify(replacementOutputs.body)).toContain(
      "Native Run output does not match its captured Framework identity",
    );
    expect((await api.readRun(actor, run.runId)).result).toStrictEqual(
      committedResult,
    );

    // Native Runs retain their captured Framework.
    const failedRun = await sendChatRunAfterPick(actor, {
      agentId,
      threadId: run.threadId,
      prompt: "reject a changed native Framework",
    });
    const failedClaim = await claimChatRun(runnerGroup, failedRun.runId);
    await webhooks.requestAgentRunOutputs(
      {
        runId: failedRun.runId,
        cliAgentType: "claude-code",
        cliAgentSessionId: run.threadId,
        cliAgentSessionHistoryDisposition: "native_only",
      },
      failedClaim.sandboxHeaders,
      [400],
    );
    await webhooks.requestAgentComplete(
      {
        runId: failedRun.runId,
        exitCode: 1,
        error: "failed before native initialization",
      },
      failedClaim.sandboxHeaders,
      [200],
    );
    await flushWaitUntilForTest();
    const cancelledRun = await sendChatRunAfterPick(actor, {
      agentId,
      threadId: run.threadId,
      model,
      prompt: "cancel before native initialization",
    });
    const cancelledClaim = await claimChatRun(runnerGroup, cancelledRun.runId);
    await cancelChatRun(
      actor,
      cancelledRun.runId,
      cancelledClaim.sandboxHeaders,
    );
    const retry = await sendChatRunAfterPick(actor, {
      agentId,
      threadId: run.threadId,
      prompt: "recover Chat history after uninitialized turns",
    });
    const retryClaim = await claimChatRun(runnerGroup, retry.runId);
    expect(retryClaim.claim.piSessionId).toBe(run.threadId);
    expect(retryClaim.claim.nativeContinuation).toStrictEqual({
      sessionId: null,
      generationRunId: null,
      recoveryPrompt: expect.stringContaining(
        "okou chat messages --output-dir threads",
      ),
    });
    const recoveryHistory = (
      await chat.listThreadEvents(actor, run.threadId)
    ).events
      .map(chatEventDisplayText)
      .join("\n");
    expect(recoveryHistory).toContain(prompt);
    expect(recoveryHistory).toContain("reject a changed native Framework");
    expect(recoveryHistory).toContain("cancel before native initialization");
    await webhooks.requestAgentComplete(
      {
        runId: retry.runId,
        exitCode: 1,
        error: "failure without native initialization",
      },
      retryClaim.sandboxHeaders,
      [200],
    );
    await flushWaitUntilForTest();

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
        cliAgentSessionHistoryDisposition: "native_only",
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
    const repeatedCombinedCompletion = await webhooks.requestAgentComplete(
      {
        runId: run.runId,
        exitCode: 0,
        completion: {
          cliAgentType: "pi",
          cliAgentSessionId: run.threadId,
          cliAgentSessionHistoryDisposition: "native_only",
          storageOutputs: storageOutputs,
        },
      },
      claimed.sandboxHeaders,
      [200],
    );
    expect(repeatedCombinedCompletion.body).toStrictEqual(
      combinedCompletion.body,
    );
    const probe = await sendChatRunAfterPick(actor, {
      agentId,
      threadId: run.threadId,
      prompt: "verify the current native generation after rejected writes",
    });
    const probeClaim = await claimChatRun(runnerGroup, probe.runId);
    expect(probeClaim.claim.nativeContinuation).toMatchObject({
      sessionId: run.threadId,
      generationRunId: reportedFailureRun.runId,
    });
    await cancelChatRun(actor, probe.runId, probeClaim.sandboxHeaders);

    // Switching the thread to the Claude Code route must not resume the Pi
    // history; the org keeps the Pi route as its default.

    await api.updateUserModelPreference(actor, model);
    const explicitResume = await api.createThreadRun(actor, {
      agentId,
      threadId: run.threadId,
      prompt: "keep an incompatible run off the Pi history",
      model: "claude-fable-5-1",
    });
    const explicitResumeClaim = await api.claimRunnerJob(explicitResume.runId);
    expect(explicitResumeClaim.cliAgentType).toBe("claude-code");

    expect(explicitResumeClaim.nativeContinuation).toMatchObject({
      sessionId: null,
      generationRunId: null,
    });
    expect(explicitResumeClaim.nativeContinuation?.recoveryPrompt).toContain(
      "okou chat messages --output-dir threads",
    );
    await cancelChatRun(actor, explicitResume.runId, {
      authorization: `Bearer ${explicitResumeClaim.sandboxToken}`,
    });
  }

  it(
    "launches personal Codex in the Sandbox and captures guest tool activity",
    piActivityScenario,
    150_000,
  );
});
