import { builtInGenerationResponseSchema } from "@okouai/api-contracts/contracts/built-in-generation";
import { cronCompactUsageEventsContract } from "@okouai/api-contracts/contracts/cron";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createAppWithRoutes } from "../../../app-factory-core";
import { mockEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { builtInGenerationRoutes } from "../built-in-generation";
import { cronCompactUsageEventsRoutes } from "../cron-compact-usage-events";
import { cronReconcileImageGenerationsRoutes } from "../cron-reconcile-image-generations";
import {
  deleteFeatureSwitchesForUser,
  updateFeatureSwitchesForUser,
} from "./helpers/feature-switches";
import {
  completedImageResponseWithUsage,
  mockOpenAiImageResponses,
} from "./helpers/openai-image-responses";
import {
  createClaimedImageRun,
  createImageIoTestApp,
  orgCredits,
  readAcceptedGenerationId,
  tokenRequest,
} from "./helpers/public-image-run";
import { createRouteMocks } from "./helpers/route-test";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { flushWaitUntilForTest } from "../../context/wait-until";

const context = testContext();
const DAY = 24 * 60 * 60 * 1000;
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const cronHeaders = Object.freeze({
  authorization: "Bearer image-reconciliation-secret",
});

async function compact() {
  return await accept(
    setupApp({ context, routes: cronCompactUsageEventsRoutes })(
      cronCompactUsageEventsContract,
    ).compact({ headers: cronHeaders }),
    [200],
  );
}

describe("durable image settlement retention", () => {
  it.each([0, 5])(
    "retains an interrupted image debit, then honors terminal grace (%i days since completion)",
    async (completedDaysAgo) => {
      const realNow = now();
      onTestFinished(clearMockNow);
      // This case owns the global queues scanned by the real cron endpoints.
      await setupApp({
        context,
        routes: cronReconcileImageGenerationsRoutes,
        isolatePg: true,
      });
      mockNow(realNow - 10 * DAY);
      const fixture = await createClaimedImageRun(
        context,
        "gpt-image-2.5-flare",
        0,
      );
      onTestFinished(async () => {
        await fixture.run(async () => {
          await deleteFeatureSwitchesForUser(context, fixture);
        });
      });
      await fixture.run(async () => {
        // The fixture snapshots external implementations when run starts:
        // install provider/env mocks before the first awaited request.
        mockEnv("CRON_SECRET", "image-reconciliation-secret");
        mockEnv("OPENAI_API_KEY", "test-openai-key");
        context.mocks.ably.createTokenRequest.mockResolvedValue(tokenRequest);
        context.mocks.ably.publish.mockResolvedValue(undefined);
        context.mocks.s3.send.mockResolvedValue({});
        const provider = mockOpenAiImageResponses();
        const app = createImageIoTestApp(context);
        await updateFeatureSwitchesForUser(context, fixture, {
          [FeatureSwitchKey.DurableOpenAiImageGeneration]: true,
        });
        expect(fixture.initialCredits).toBe(20_000);
        const generated = await app.request("/api/image-io/generate", {
          method: "POST",
          headers: { authorization: `Bearer ${fixture.token}` },
          body: JSON.stringify({
            prompt: "A private product illustration",
            size: "1024x1024",
            quality: "medium",
            outputFormat: "png",
          }),
        });
        expect(generated.status).toBe(202);
        const generationId = readAcceptedGenerationId(
          await generated.json(),
          "image",
          fixture.userId,
        );
        const path = `/api/built-in-generations/${generationId}`;
        const submission = provider.submission();
        provider.responses.set(
          submission.id,
          completedImageResponseWithUsage(submission),
        );
        createRouteMocks(context).clerk.session(fixture.userId, fixture.orgId);
        async function readStatus() {
          const response = await app.request(path, { headers });
          expect(response.status).toBe(200);
          return builtInGenerationResponseSchema.parse(await response.json());
        }
        async function refresh() {
          const ownerApp = createAppWithRoutes({
            signal: context.signal,
            routes: builtInGenerationRoutes,
          });
          const response = await ownerApp.request(`${path}/reconcile`, {
            method: "POST",
            headers,
            body: JSON.stringify({}),
          });
          expect(response.status).toBe(200);
          return builtInGenerationResponseSchema.parse(await response.json());
        }
        // Retrieval persists the image and settlement checkpoint; the next
        // request performs financial settlement against that same checkpoint.
        await expect(refresh()).resolves.toMatchObject({ status: "running" });
        await expect(orgCredits(context, fixture)).resolves.toBe(
          fixture.initialCredits,
        );

        // The original Run can end while its accepted durable image remains
        // pending. Its terminal usage notifications expose a real postcommit
        // delivery boundary, and let cleanup use the public terminal state.
        await createWebhookCallbackApi(context).requestAgentComplete(
          { runId: fixture.runId, exitCode: 0 },
          { authorization: `Bearer ${fixture.claim.sandboxToken}` },
          [200],
        );
        await flushWaitUntilForTest();
        const worker = new AbortController();
        onTestFinished(() => {
          worker.abort();
          context.mocks.ably.publish.mockResolvedValue(undefined);
        });
        context.mocks.ably.publish.mockImplementation((topic) => {
          if (
            typeof topic === "string" &&
            topic.startsWith("chatThreadMessageCreated:") &&
            !worker.signal.aborted
          ) {
            // Real worker lifecycle cancellation, synchronously at external
            // delivery after COMMIT, before orchestration usage is recorded.
            worker.abort();
          }
          return Promise.resolve(undefined);
        });
        const interruptedApp = createAppWithRoutes({
          signal: AbortSignal.any([context.signal, worker.signal]),
          routes: builtInGenerationRoutes,
        });
        const interrupted = await interruptedApp.request(`${path}/reconcile`, {
          method: "POST",
          headers,
          body: JSON.stringify({}),
        });
        expect(worker.signal.aborted).toBeTruthy();
        // app-factory-core handles AbortError as HTTP 500.
        expect(interrupted.status).toBe(500);
        context.mocks.ably.publish.mockResolvedValue(undefined);
        await expect(readStatus()).resolves.toMatchObject({
          status: "running",
        });
        await expect(orgCredits(context, fixture)).resolves.toBe(
          fixture.initialCredits - 7,
        );

        clearMockNow();
        // PostgreSQL's clock is never mocked: the debit really is old enough
        // to compact, but the still-running job must retain its raw identity.
        const interruptedCompaction = await compact();
        expect(interruptedCompaction.body.rawRowsDeleted).toBe(0);

        mockNow(realNow - completedDaysAgo * DAY);
        // Fresh owner app, not the aborted worker, resumes the original job.
        const completed = await refresh();
        expect(completed).toMatchObject({
          generationId,
          status: "completed",
          result: { creditsCharged: 9 },
        });
        await expect(orgCredits(context, fixture)).resolves.toBe(
          fixture.initialCredits - 9,
        );

        clearMockNow();
        const cleaned = await app.request(
          "/api/cron/reconcile-image-generations",
          { headers: cronHeaders },
        );
        expect(cleaned.status).toBe(200);
        expect(provider.deletions).toStrictEqual([submission.id]);
        const compacted = await compact();
        if (completedDaysAgo === 0) {
          // Even after provider cleanup, recent completion protects the old
          // image debit from a stale running invocation during terminal grace.
          expect(compacted.body.rawRowsDeleted).toBe(0);
        } else {
          expect(compacted.body.rawRowsDeleted).toBeGreaterThan(0);
        }
        await expect(refresh()).resolves.toMatchObject({
          generationId,
          status: "completed",
          result: completed.result,
        });
        await expect(orgCredits(context, fixture)).resolves.toBe(
          fixture.initialCredits - 9,
        );
        expect(provider.submissions).toHaveLength(1);
      });
    },
  );
});
