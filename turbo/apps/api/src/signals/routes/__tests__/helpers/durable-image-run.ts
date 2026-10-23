import { builtInGenerationResponseSchema } from "@okouai/api-contracts/contracts/built-in-generation";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { mockEnv } from "../../../../lib/env";
import { userModelPreferenceRoutes } from "../../user-model-preference";
import { cronReconcileImageGenerationsRoutes } from "../../cron-reconcile-image-generations";
import { createPublicImageMember } from "./public-image-member";
import { createImageIoTestApp, tokenRequest } from "./public-image-run";
import { createRouteMocks } from "./route-test";

const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const cronHeaders = Object.freeze({
  authorization: "Bearer image-reconciliation-secret",
});

export async function createDurableImageFixture(context: TestContext) {
  mockEnv("CRON_SECRET", "image-reconciliation-secret");
  mockEnv("OPENAI_API_KEY", "test-openai-key");
  context.mocks.ably.createTokenRequest.mockResolvedValue(tokenRequest);
  context.mocks.ably.publish.mockResolvedValue(undefined);
  context.mocks.s3.send.mockResolvedValue({});
  // Recovery and compaction scenarios scan global queues, not just this actor.
  await setupApp({
    context,
    routes: cronReconcileImageGenerationsRoutes,
    isolatePg: true,
  });
  const actor = await createPublicImageMember(context, {
    credits: 10_000,
  });
  await actor.run(async () => {
    createRouteMocks(context).clerk.session(actor.userId, actor.orgId);
    await accept(
      setupApp({ context, routes: userModelPreferenceRoutes })(
        userModelPreferenceContract,
      ).update({
        headers,
        body: {
          selectedModel: null,
          serviceTier: null,
          selectedImageModel: "gpt-image-2.5-flare",
        },
      }),
      [200],
    );
  });
  context.mocks.s3.send.mockClear();
  actor.captureExternalState();
  const app = createImageIoTestApp(context, actor);
  return {
    actor,
    app,
    async generate(body: Record<string, unknown> = {}) {
      return await app.request("/api/image-io/generate", {
        method: "POST",
        headers,
        body: JSON.stringify({
          prompt: "A private product illustration",
          size: "1024x1024",
          quality: "medium",
          outputFormat: "png",
          ...body,
        }),
      });
    },
    async status(generationId: string) {
      const response = await app.request(
        `/api/built-in-generations/${generationId}`,
        { headers },
      );
      expect(response.status).toBe(200);
      return builtInGenerationResponseSchema.parse(await response.json());
    },
    async refresh(generationId: string) {
      const response = await app.request(
        `/api/built-in-generations/${generationId}/reconcile`,
        { method: "POST", headers, body: JSON.stringify({}) },
      );
      expect(response.status).toBe(200);
      return builtInGenerationResponseSchema.parse(await response.json());
    },
    async reconcile() {
      const response = await app.request(
        "/api/cron/reconcile-image-generations",
        { headers: cronHeaders },
      );
      expect(response.status).toBe(200);
    },
  };
}
