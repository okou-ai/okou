import { Buffer } from "node:buffer";
import { builtInGenerationResponseSchema } from "@okouai/api-contracts/contracts/built-in-generation";
import { http, HttpResponse } from "msw";
import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import {
  createClaimedImageRun,
  createImageIoTestApp,
  orgCredits,
  postFalWebhookEnvelope,
  readAcceptedGenerationId,
  readGenerationResult,
  readWebhookUrl,
  tokenRequest,
} from "./helpers/public-image-run";

const context = testContext();
const API_ORIGIN = "https://api.okou.test";
const FAL_GPT_IMAGE_1_URL =
  "https://queue.fal.run/fal-ai/gpt-image-1/text-to-image";
const FAL_GPT_MEDIA_URL = "https://fal.media/files/test/gpt-image-1.webp";
const IMAGE_BYTES = Buffer.from("fake image bytes");

function falQueueHandle(requestId: string): Record<string, string> {
  return {
    request_id: requestId,
    status_url: `https://queue.fal.run/test/requests/${requestId}/status`,
    response_url: `https://queue.fal.run/test/requests/${requestId}/response`,
  };
}

test.each(["completed", "failed"] as const)(
  "keeps the lifetime limit after the fiftieth image is %s",
  async (outcome) => {
    mockEnv("OKOU_API_BACKEND_URL", API_ORIGIN);
    mockEnv("OKOU_WEB_URL", "https://www.okou.test");
    context.mocks.ably.createTokenRequest.mockResolvedValue(tokenRequest);
    context.mocks.ably.publish.mockResolvedValue(undefined);
    const fixture = await createClaimedImageRun(context, "gpt-image-1", 0);
    context.mocks.s3.send.mockReset();
    context.mocks.s3.send.mockResolvedValue({});
    await fixture.run(async () => {
      const requestUrls: string[] = [];
      const requestUrlsByGenerationId = new Map<string, string>();
      server.use(
        http.post(FAL_GPT_IMAGE_1_URL, ({ request }) => {
          requestUrls.push(request.url);
          const callback = new URL(readWebhookUrl(request.url));
          const generationId = callback.pathname.split("/").at(-1);
          if (!generationId) {
            throw new Error(
              "Expected the provider's genuine generation callback URL",
            );
          }
          requestUrlsByGenerationId.set(generationId, request.url);
          return HttpResponse.json(
            falQueueHandle(`lifetime-${requestUrls.length}`),
          );
        }),
        http.get(FAL_GPT_MEDIA_URL, () => {
          return new HttpResponse(IMAGE_BYTES, {
            headers: { "Content-Type": "image/webp" },
          });
        }),
      );
      const app = createImageIoTestApp(context);
      const path = "/api/image-io/generate";
      const request = {
        method: "POST",
        headers: { authorization: `Bearer ${fixture.token}` },
        body: JSON.stringify({
          prompt: "a small robot painting a sunflower",
          size: "1024x1024",
          quality: "auto",
          background: "opaque",
          outputFormat: "webp",
        }),
      };
      const completionPayload = {
        images: [
          {
            url: FAL_GPT_MEDIA_URL,
            width: 1024,
            height: 1024,
            content_type: "image/webp",
          },
        ],
        prompt: "A small robot paints a sunflower.",
      };
      // The Pro fixture already verifies its sufficient starting balance.
      const generationIds = new Set<string>();
      // Lifetime admission counts every submitted generation. Use genuine
      // provider input rejections for the first 49 slots, then check both terminal
      // outcomes at the actual 50th boundary. Full image processing and callback
      // replay are covered by the dedicated generation scenarios.
      async function settleGeneration(status: "completed" | "failed") {
        const response = await app.request(path, request);
        expect(response.status).toBe(202);
        const generationId = readAcceptedGenerationId(
          await response.json(),
          "image",
          fixture.userId,
        );
        expect(generationIds.has(generationId)).toBeFalsy();
        generationIds.add(generationId);
        const failure = {
          status: "ERROR",
          error: "Unexpected status code: 422",
          payload: {
            detail: [
              {
                type: "content_policy_violation",
                loc: ["body", "prompt"],
                msg: "The content could not be processed because it contained material flagged by a content checker.",
              },
            ],
          },
        };
        await postFalWebhookEnvelope(
          app,
          requestUrlsByGenerationId.get(generationId) ?? null,
          status === "completed"
            ? { status: "COMPLETED", payload: completionPayload }
            : failure,
        );
        return generationId;
      }
      const results = await Promise.allSettled(
        Array.from({ length: 3 }, async (_, stream) => {
          for (let index = stream; index < 49; index += 3) {
            await settleGeneration("failed");
          }
        }),
      );
      for (const result of results) {
        if (result.status === "rejected") {
          throw result.reason;
        }
      }
      const finalId = await settleGeneration(outcome);
      const chargedCredits = outcome === "completed" ? 42 : 0;
      await flushWaitUntilForTest();
      // Clients receive these same public result snapshots through realtime.
      // Validate all fifty terminal outcomes and their charge behavior.
      const terminalIds = new Set<string>();
      for (const [eventName, payload] of context.mocks.ably.publish.mock
        .calls) {
        if (
          typeof eventName !== "string" ||
          !eventName.startsWith("built-in-generation:")
        ) {
          continue;
        }
        const generationId = eventName.slice("built-in-generation:".length);
        if (!generationIds.has(generationId)) {
          continue;
        }
        const completed = builtInGenerationResponseSchema.parse(payload);
        const expectedStatus = generationId === finalId ? outcome : "failed";
        expect(completed).toMatchObject({
          generationId,
          type: "image",
          status: expectedStatus,
        });
        if (expectedStatus === "completed") {
          expect(readGenerationResult(completed)).toMatchObject({
            creditsCharged: 42,
          });
        } else {
          expect(completed.error).toMatchObject({
            code: "GENERATION_INPUT_SAFETY_REJECTED",
          });
        }
        expect(terminalIds.has(generationId)).toBeFalsy();
        terminalIds.add(generationId);
      }
      expect(terminalIds).toStrictEqual(generationIds);
      const completed = await app.request(
        `/api/built-in-generations/${finalId}`,
        { headers: request.headers },
      );
      expect(completed.status).toBe(200);
      const finalResult = builtInGenerationResponseSchema.parse(
        await completed.json(),
      );
      expect(finalResult).toMatchObject({
        generationId: finalId,
        status: outcome,
      });
      if (outcome === "completed") {
        expect(readGenerationResult(finalResult)).toMatchObject({
          creditsCharged: 42,
        });
      } else {
        expect(finalResult.error).toMatchObject({
          code: "GENERATION_INPUT_SAFETY_REJECTED",
        });
      }
      expect(generationIds.size).toBe(50);
      expect(requestUrls).toHaveLength(50);
      await expect(orgCredits(context, fixture)).resolves.toBe(
        fixture.initialCredits - chargedCredits,
      );

      const limited = await fixture.request(app, path, request);
      expect(limited.status).toBe(429);
      await expect(limited.json()).resolves.toMatchObject({
        error: { code: "BUILT_IN_RUN_USAGE_LIMIT" },
      });
      expect(requestUrls).toHaveLength(50);
      await expect(orgCredits(context, fixture)).resolves.toBe(
        fixture.initialCredits - chargedCredits,
      );
    });
  },
);
