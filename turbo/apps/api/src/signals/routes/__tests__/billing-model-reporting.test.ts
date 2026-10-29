import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { usageRecordContract } from "@okouai/api-contracts/contracts/usage-record";
import { usageMembersContract } from "@okouai/api-contracts/contracts/usage";
import { chatThreadUsageContract } from "@okouai/api-contracts/contracts/chat-threads";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { usageRecordRoutes } from "../usage-record";
import { usageMembersRoutes } from "../usage-members";
import { chatThreadRoutes } from "../chat-threads";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { publicChatActor } from "./helpers/public-chat-actor";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const fixture = createChatEventsFixture(context);

describe("Billing model reporting", () => {
  it("settles the first Runner usage batch once when completion and duplicate reports overlap", async () => {
    const at = Date.UTC(2026, 2, 1, 12, 15);
    mockNow(at);
    const {
      actor,
      agentId,
      runnerGroup,
      run: own,
      sendChatRun,
      claimChatRun,
    } = await publicChatActor(context, { clockTime: at });
    await own(async () => {
      const run = await sendChatRun(actor, {
        agentId,
        prompt: "Publish first usage while completing",
        model: "auto",
      });
      const claim = await claimChatRun(runnerGroup, run.runId);
      await fixture.webhooks.requestAgentEvents(
        {
          runId: run.runId,
          events: [
            {
              type: "assistant",
              sequenceNumber: 1,
              message: { content: [{ type: "text", text: "Completed" }] },
            },
            { type: "result", sequenceNumber: 2, result: "Completed" },
          ],
        },
        claim.sandboxHeaders,
        [200],
      );
      const usage = {
        runId: run.runId,
        events: [1000, 2000, 7000].map((quantity) => {
          return {
            idempotencyKey: randomUUID(),
            kind: "model" as const,
            provider: "gpt-6-astra",
            category: "tokens.output",
            quantity,
          };
        }),
      };
      const completedAt = at + 60_000;
      mockNow(completedAt);
      const outcomes = await Promise.allSettled([
        fixture.webhooks.requestAgentComplete(
          {
            runId: run.runId,
            exitCode: 0,
            lastEventSequence: 2,
            completion: {
              cliAgentType: "pi",
              cliAgentSessionId: run.threadId,
              cliAgentSessionHistoryDisposition: "native_only",
            },
          },
          claim.sandboxHeaders,
          [200],
        ),
        fixture.webhooks.requestAgentUsageEvent(
          usage,
          claim.sandboxHeaders,
          [200],
        ),
        fixture.webhooks.requestAgentUsageEvent(
          usage,
          claim.sandboxHeaders,
          [200],
        ),
      ]);
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") {
          throw outcome.reason;
        }
      }
      await flushWaitUntilForTest();
      await fixture.waitForRunStatus(actor, run.runId, "completed");
      createRouteMocks(context).clerk.session(
        actor.userId,
        actor.orgId,
        actor.orgRole,
      );
      const chatUsage = () => {
        return accept(
          setupApp({ context, routes: chatThreadRoutes })(
            chatThreadUsageContract,
          ).read({
            headers: { authorization: "Bearer clerk-session" },
            params: { id: run.threadId },
            body: { runIds: [run.runId] },
          }),
          [200],
        );
      };
      const report = (await chatUsage()).body;
      expect(report.runs).toStrictEqual([
        {
          runId: run.runId,
          usage: {
            version: 1,
            totalCredits: 10,
            settledAt: new Date(completedAt).toISOString(),
            breakdown: [
              {
                kind: "model",
                credits: 10,
                providers: [{ provider: "@preset/okou-1-0", credits: 10 }],
              },
            ],
          },
        },
      ]);
      await fixture.webhooks.requestAgentUsageEvent(
        usage,
        claim.sandboxHeaders,
        [200],
      );
      await flushWaitUntilForTest();
      expect((await chatUsage()).body).toStrictEqual(report);
    });
  });

  it.each(["failed", "cancelled"] as const)(
    "returns settled usage and the captured completion time after a %s Run",
    async (status) => {
      const at = Date.UTC(2026, 2, 1, 12, 15);
      mockNow(at);
      const {
        actor,
        agentId,
        runnerGroup,
        run: own,
        sendChatRun,
        claimChatRun,
      } = await publicChatActor(context, { clockTime: at });
      await own(async () => {
        const run = await sendChatRun(actor, {
          agentId,
          prompt: "Report usage before unsuccessful completion",
          model: "auto",
        });
        const claim = await claimChatRun(runnerGroup, run.runId);
        const chatUsage = () => {
          createRouteMocks(context).clerk.session(
            actor.userId,
            actor.orgId,
            actor.orgRole,
          );
          return accept(
            setupApp({ context, routes: chatThreadRoutes })(
              chatThreadUsageContract,
            ).read({
              headers: { authorization: "Bearer clerk-session" },
              params: { id: run.threadId },
              body: { runIds: [run.runId] },
            }),
            [200],
          );
        };
        await fixture.webhooks.requestAgentUsageEvent(
          {
            runId: run.runId,
            events: [
              {
                idempotencyKey: randomUUID(),
                kind: "model",
                provider: "gpt-6-astra",
                category: "tokens.output",
                quantity: 10_000,
              },
            ],
          },
          claim.sandboxHeaders,
          [200],
        );
        await flushWaitUntilForTest();
        expect((await chatUsage()).body.runs).toStrictEqual([]);

        const completedAt = at + 60_000;
        mockNow(completedAt);
        if (status === "failed") {
          await fixture.failChatRun(
            run.runId,
            claim.sandboxHeaders,
            "Expected unsuccessful completion",
          );
        } else {
          await fixture.cancelChatRun(actor, run.runId, claim.sandboxHeaders);
        }
        await fixture.waitForRunStatus(actor, run.runId, status);
        expect((await chatUsage()).body.runs).toStrictEqual([
          {
            runId: run.runId,
            usage: {
              version: 1,
              totalCredits: 10,
              settledAt: new Date(completedAt).toISOString(),
              breakdown: [
                {
                  kind: "model",
                  credits: 10,
                  providers: [{ provider: "@preset/okou-1-0", credits: 10 }],
                },
              ],
            },
          },
        ]);
      });
    },
  );

  it("retains captured providers and settled totals after Thread deletion and Run deletion", async () => {
    const at = Date.UTC(2026, 2, 1, 12, 15);
    mockNow(at);
    const {
      actor,
      agentId,
      runnerGroup,
      run: own,
      sendChatRun,
      claimChatRun,
    } = await publicChatActor(context, { clockTime: at });
    fixture.mockPiResourceArchiveDownloads();
    const historyObjects = fixture.mockPiObjectStore();
    await own(async () => {
      const run = await sendChatRun(actor, {
        agentId,
        prompt: "Report captured usage",
        model: "auto",
      });
      await flushWaitUntilForTest();
      const claim = await claimChatRun(runnerGroup, run.runId);
      expect(claim.claim.modelUsageProvider).toBe("@preset/okou-1-0");
      const chatUsage = () => {
        createRouteMocks(context).clerk.session(
          actor.userId,
          actor.orgId,
          actor.orgRole,
        );
        return accept(
          setupApp({ context, routes: chatThreadRoutes })(
            chatThreadUsageContract,
          ).read({
            headers: { authorization: "Bearer clerk-session" },
            params: { id: run.threadId },
            body: { runIds: [run.runId] },
          }),
          [200],
        );
      };
      await fixture.webhooks.requestAgentUsageEvent(
        {
          runId: run.runId,
          events: [
            {
              idempotencyKey: randomUUID(),
              kind: "model",
              provider: "gpt-6-astra",
              category: "tokens.output",
              quantity: 10_000,
            },
            {
              idempotencyKey: randomUUID(),
              kind: "image",
              provider: "gpt-image-1",
              category: "output_image.low.standard",
              quantity: 2,
            },
          ],
        },
        claim.sandboxHeaders,
        [200],
      );
      await flushWaitUntilForTest();
      expect((await chatUsage()).body.runs).toStrictEqual([]);
      const completedAt = at + 60_000;
      mockNow(completedAt);
      await fixture.completeSandboxFirstPiRun({
        actor,
        run,
        claim,
        historyObjects,
        prompt: "Report captured usage",
        answer: "Usage captured",
        responsesModel: { provider: "openrouter", model: "@preset/okou-1-0" },
      });
      await flushWaitUntilForTest();

      const report = async () => {
        createRouteMocks(context).clerk.session(
          actor.userId,
          actor.orgId,
          actor.orgRole,
        );
        const headers = { authorization: "Bearer clerk-session" };
        const record = await accept(
          setupApp({ context, routes: usageRecordRoutes })(
            usageRecordContract,
          ).get({ headers, query: { range: "7d", tz: "UTC" } }),
          [200],
        );
        const members = await accept(
          setupApp({ context, routes: usageMembersRoutes })(
            usageMembersContract,
          ).get({ headers, query: { range: "7d", tz: "UTC" } }),
          [200],
        );
        return { record: record.body, members: members.body };
      };
      const raw = await report();
      const expectedBreakdown = [
        {
          kind: "model",
          credits: 10,
          providers: [
            {
              provider: "@preset/okou-1-0",
              credits: 10,
              usageKinds: [{ kind: "model", credits: 10 }],
            },
          ],
        },
        {
          kind: "image",
          credits: 22,
          providers: [
            {
              provider: "gpt-image-1",
              credits: 22,
              usageKinds: [{ kind: "image", credits: 22 }],
            },
          ],
        },
      ];
      expect(raw.record.totalCredits, JSON.stringify(raw)).toBe(32);
      expect(raw.record.rows[0]).toMatchObject({
        threadId: run.threadId,
        tokens: 10_000,
        credits: 32,
        breakdown: expectedBreakdown,
      });
      expect(raw.members.members[0]).toMatchObject({
        creditsCharged: 32,
        outputTokens: 10_000,
        breakdown: expectedBreakdown,
      });
      const rawChatUsage = await chatUsage();
      expect(rawChatUsage.body.runs).toStrictEqual([
        {
          runId: run.runId,
          usage: {
            version: 1,
            totalCredits: 32,
            settledAt: new Date(completedAt).toISOString(),
            breakdown: [
              {
                kind: "image",
                credits: 22,
                providers: [{ provider: "gpt-image-1", credits: 22 }],
              },
              {
                kind: "model",
                credits: 10,
                providers: [{ provider: "@preset/okou-1-0", credits: 10 }],
              },
            ],
          },
        },
      ]);
      const messages = await createChatFilesBddApi(context).listThreadEvents(
        actor,
        run.threadId,
      );
      expect(messages.events).toContainEqual(
        expect.objectContaining({
          eventType: "usage.recorded",
          runId: run.runId,
          usage: rawChatUsage.body.runs[0]?.usage,
        }),
      );

      await createChatFilesBddApi(context).deleteThread(actor, run.threadId);
      const withoutThread = await report();
      expect(withoutThread.record).toStrictEqual({
        ...raw.record,
        rows: raw.record.rows.map((row) => {
          return { ...row, threadId: null, title: "Unavailable thread" };
        }),
      });
      expect(withoutThread.members).toStrictEqual(raw.members);

      await createBddApi(context).deleteAgent(actor, agentId);
      await createRunsApi(context).requestReadRun(actor, run.runId, [404]);
      const deleted = await report();
      expect(deleted).toStrictEqual(withoutThread);
    });
  });
});
