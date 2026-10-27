import { normalizeContext } from "@earendil-works/pi-ai";
import { retryAssistantCall } from "@earendil-works/pi-ai/utils/retry";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { piAgentStreamForConfig } from "./model";
import { resolvePiAgentModel } from "./model-catalog";
import { piModelFailureReason } from "./model-request-diagnostics";
import restriction from "./test/fixtures/openrouter-model-restricted.json";

const server = setupServer();
beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

describe("OpenRouter model restriction", () => {
  it("preserves the all-endpoint refusal without retrying or exposing configuration in diagnostics", async () => {
    const route = {
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "@preset/okou-opus",
      catalogModel: "auto",
      apiKey: "synthetic-token",
      dialect: "openai-completions",
      transport: "sse",
    } as const;
    const requests: unknown[] = [];
    server.use(
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        async ({ request }) => {
          requests.push(await request.json());
          return HttpResponse.json(restriction, { status: 404 });
        },
      ),
    );
    const model = resolvePiAgentModel(route);
    if (!model) throw new Error("Expected the Auto preset model");
    const result = await retryAssistantCall(
      () => {
        return piAgentStreamForConfig(route)(
          model,
          normalizeContext({
            messages: [{ role: "user", content: "hello", timestamp: 1 }],
          }),
          { apiKey: route.apiKey, maxRetries: 3 },
        ).result();
      },
      { enabled: true, maxRetries: 2, baseDelayMs: 1 },
      undefined,
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ model: "@preset/okou-opus" });
    expect(result.stopReason).toBe("error");
    expect(piModelFailureReason(result)).toBe("provider_model_restricted");
    expect(result.diagnostics).toEqual([
      {
        type: "okou_model_request",
        timestamp: expect.any(Number),
        details: {
          httpStatus: 404,
          transportAttempts: 1,
          failureReason: "provider_model_restricted",
        },
      },
    ]);
  });
});
