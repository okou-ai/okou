import { publicChatActor } from "./helpers/public-chat-actor";
import { randomUUID } from "node:crypto";
import { isChatRunTerminalEventType } from "@okouai/api-contracts/contracts/chat-events";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
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
  eventBackedContents,
  PI_RESOURCE_ARCHIVE_DOWNLOAD_URL,
} from "./helpers/chat-events-fixture";
const context = testContext();
const {
  api,
  chat,
  webhooks,
  configureSubscriptionPiModel,
  waitForRunStatus,
  failChatRun,
  mockPiObjectStore,
  completeSandboxFirstPiRun,
  completeChatRunOk,
} = createChatEventsFixture(context);

describe("CHAT-02: model-first routing", () => {
  it.each([
    "/skill:handoff-skill first  argument\nsecond line",
    " \n\t/skill:handoff-skill first  argument\nsecond line",
    "/unknown-command first  argument\nsecond line",
    "/home/user/workspace/report.txt first  argument\nsecond line",
  ] as const)(
    "passes native input %j unchanged across queued and continued rounds",
    async (prompt) => {
      const {
        actor,
        agentId,
        runnerGroup,
        run: own,
        sendChatRun,
        sendWaitingChatInput,
        claimChatRun,
      } = await publicChatActor(context, {
        optionalEnvironmentNames: ["CONCURRENT_RUN_LIMIT_CAP"],
      });
      await own(async () => {
        mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
        const historyObjects = mockPiObjectStore();
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
        const anchor = await sendChatRun(actor, {
          agentId,
          prompt: "hold capacity for the personal Pi input",
          model: "claude-fable-5-1",
        });
        const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);
        await configureSubscriptionPiModel(actor, {}, "gpt-6-luna");
        const waiting = await sendWaitingChatInput(actor, {
          agentId,
          prompt,
          model: "gpt-6-luna",
        });
        await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders);
        let run = await waiting.launchedRun();
        let previousRunId: string | undefined;
        for (const turn of [1, 2]) {
          const originalPrompt = turn === 1 ? prompt : `${prompt}\nresume once`;
          if (turn === 2) {
            run = await sendChatRun(actor, {
              agentId,
              threadId: run.threadId,
              prompt: originalPrompt,
              model: "gpt-6-luna",
            });
          }
          const claim = await claimChatRun(runnerGroup, run.runId);
          expect(claim.claim).toMatchObject({
            cliAgentType: "pi",
            piSessionId: run.threadId,
            prompt: originalPrompt,
          });

          expect(claim.claim.nativeContinuation).toMatchObject({
            sessionId: turn === 1 ? null : run.threadId,
            generationRunId: previousRunId ?? null,
          });
          if (turn === 1) {
            expect(claim.claim.nativeContinuation?.recoveryPrompt).toBeNull();
          } else {
            expect(claim.claim.nativeContinuation?.recoveryPrompt).toContain(
              "okou chat messages --output-dir threads",
            );
          }
          expect(claim.claim.appendSystemPrompt).not.toContain(
            "native Sandbox answer 1",
          );
          const usage = {
            idempotencyKey: randomUUID(),
            kind: "model" as const,
            provider: "gpt-6-luna",
            category: "tokens.output",
            quantity: 2,
          };
          for (const _receipt of [1, 2]) {
            await webhooks.requestAgentUsageEvent(
              { runId: run.runId, events: [usage] },
              claim.sandboxHeaders,
              [200],
            );
          }
          const answer = `native Sandbox answer ${turn}`;
          await completeSandboxFirstPiRun({
            actor,
            answer,
            historyObjects,
            claim,
            prompt: originalPrompt,
            run,
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
          await expectThreadModelTokens(context, actor, run.threadId, 0);
          await expect(
            readCompletedRunSessionId(context, actor, run.runId),
          ).resolves.toBe(run.threadId);
          previousRunId = run.runId;
        }
        expect(resourceDownloads).toBe(0);
        expect(
          [...historyObjects.keys()].filter((key) => {
            return key.includes("/blobs/");
          }),
        ).toHaveLength(0);
      });
    },
  );
  it.each(["gpt-6-luna"] as const)(
    "claims %s with Sandbox credentials without charging duplicate personal usage",
    async (selectedModel) => {
      const {
        run: own,
        actor,
        agentId,
        runnerGroup,
        claimChatRun,
        sendChatRun,
      } = await publicChatActor(context);
      await own(async () => {
        await configureSubscriptionPiModel(actor, {}, selectedModel);

        const run = await sendChatRun(actor, {
          agentId,
          prompt: "hand a personal Pi turn to Sandbox",
          model: selectedModel,
        });
        await flushWaitUntilForTest();

        const claimed = await claimChatRun(runnerGroup, run.runId);
        expect(claimed.claim.piModelConfig).toMatchObject({
          provider: "openai-codex",
          model: selectedModel,
        });
        expect(claimed.claim.piModelConfig).not.toHaveProperty("serviceTier");
        const credentials = claimEnvironment(claimed.claim);
        expect(credentials.CHATGPT_ACCESS_TOKEN).toBe(
          modelProviderSecretPlaceholder(
            "codex-oauth-token",
            "CHATGPT_ACCESS_TOKEN",
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
          own(async () => {
            return await webhooks.requestAgentUsageEvent(
              { runId: run.runId, events: [sandboxUsageEvent] },
              claimed.sandboxHeaders,
              [200],
            );
          }),
          own(async () => {
            return await webhooks.requestAgentUsageEvent(
              { runId: run.runId, events: [sandboxUsageEvent] },
              claimed.sandboxHeaders,
              [200],
            );
          }),
        ]);
        expect(
          sandboxUsageReceipts.map((receipt) => {
            return receipt.body;
          }),
        ).toStrictEqual([{ success: true }, { success: true }]);
        await own(async () => {
          return await api.requestCancelRun(actor, run.runId, [200]);
        });
        await waitForRunStatus(actor, run.runId, "cancelled");
        await own(async () => {
          return await failChatRun(
            run.runId,
            claimed.sandboxHeaders,
            "Run cancelled",
          );
        });
        await flushWaitUntilForTest();
        const usage = await readThreadModelUsage(context, actor, run.threadId);
        expect(usage.tokens).toBe(0);
        expect(usage.credits).toBe(0);
      });
    },
    90_000,
  );
});
