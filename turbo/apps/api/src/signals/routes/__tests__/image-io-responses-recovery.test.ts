import { builtInGenerationResponseSchema } from "@okouai/api-contracts/contracts/built-in-generation";
import { onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { createAppWithRoutes } from "../../../app-factory-core";
import { mockEnv } from "../../../lib/env";
import { builtInGenerationRoutes } from "../built-in-generation";
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
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

describe("durable image settlement recovery", () => {
  it("resumes an interrupted debit through a fresh owner request without charging twice", async () => {
    const fixture = await createClaimedImageRun(
      context,
      "gpt-image-2.5-flare",
      0,
    );
    await fixture.run(async () => {
      // The fixture snapshots external implementations when run starts:
      // install provider/env mocks before the first awaited request.
      mockEnv("OPENAI_API_KEY", "test-openai-key");
      context.mocks.ably.createTokenRequest.mockResolvedValue(tokenRequest);
      context.mocks.ably.publish.mockResolvedValue(undefined);
      context.mocks.s3.send.mockResolvedValue({});
      const provider = mockOpenAiImageResponses();
      const app = createImageIoTestApp(context);
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
      // delivery boundary for the following settlement interruption.
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
  });
});
