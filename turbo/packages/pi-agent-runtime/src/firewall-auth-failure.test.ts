import { normalizeContext } from "@earendil-works/pi-ai";
import { retryAssistantCall } from "@earendil-works/pi-ai/utils/retry";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { piAgentStreamForConfig } from "./model";
import { resolvePiAgentModel } from "./model-catalog";
import { piModelFailureReason } from "./model-request-diagnostics";
import fixture from "./test/fixtures/local-firewall-auth-failure.json";

const routes = [
  {
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "@preset/okou-1-0",
    catalogModel: "okou-1.0",
    apiKey: "synthetic-token",
    dialect: "openai-completions",
    transport: "sse",
  },
  {
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "@preset/okou-1-0",
    catalogModel: "okou-1.0",
    apiKey: "synthetic-token",
    dialect: "openai-responses",
    transport: "sse",
  },
  {
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api",
    model: "gpt-6-luna",
    apiKey: "synthetic-token",
    accountId: "synthetic-account",
    dialect: "openai-codex-responses",
    transport: "sse",
  },
] as const;
const server = setupServer();
beforeAll(() => {
  return server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  return server.resetHandlers();
});
afterAll(() => {
  return server.close();
});

function stream(route: (typeof routes)[number] = routes[0]) {
  const model = resolvePiAgentModel(route);
  if (!model) throw new Error("Missing firewall attribution test model");
  return piAgentStreamForConfig(route)(
    model,
    normalizeContext({
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
    }),
    { apiKey: route.apiKey },
  );
}

describe("local firewall authentication attribution", () => {
  it.each(routes)(
    "retains local cause through $dialect consumption and existing native retry",
    async (route) => {
      let requests = 0;
      server.use(
        http.post("*", () => {
          requests++;
          return HttpResponse.json(
            {
              ...fixture.response,
              message:
                "private-token https://private.invalid/path?secret=token",
              authFailure: {
                ...fixture.response.authFailure,
                debug: "private-token",
              },
            },
            { status: 502 },
          );
        }),
      );
      const result = await retryAssistantCall(
        async () => {
          const response = stream(route);
          for await (const event of response) {
            if (event.type === "error") {
              expect(event.error.errorMessage).toBe(
                fixture.message.errorMessage,
              );
            }
          }
          return response.result();
        },
        { enabled: true, maxRetries: 1, baseDelayMs: 1 },
        undefined,
      );
      expect(requests).toBe(2);
      expect(result).toMatchObject({ ...fixture.message, api: route.dialect });
      expect(piModelFailureReason(result)).toBe("firewall_auth_failed");
      expect(JSON.stringify(result.diagnostics)).not.toContain("private-token");
      expect(JSON.stringify(result.diagnostics)).not.toContain(
        "private.invalid",
      );
    },
  );

  it.each([
    {
      evidence: {
        source: "okou_firewall_auth",
        kind: "deadline_exceeded",
        phase: "response_headers",
      },
      summary:
        '502 "auth_failed": local firewall auth deadline_exceeded during response_headers',
    },
    {
      evidence: { source: "okou_firewall_auth", kind: "transport_error" },
      summary: '502 "auth_failed": local firewall auth transport_error',
    },
    {
      evidence: { source: "okou_firewall_auth", kind: "invalid_response" },
      summary: '502 "auth_failed": local firewall auth invalid_response',
    },
  ])(
    "preserves the finite $evidence.kind cause through result()",
    async ({ evidence, summary }) => {
      server.use(
        http.post("*", () => {
          return HttpResponse.json(
            { error: "auth_failed", authFailure: evidence },
            { status: 502 },
          );
        }),
      );
      const result = await stream().result();
      expect(result.errorMessage).toBe(summary);
      expect(piModelFailureReason(result)).toBe("firewall_auth_failed");
    },
  );

  it("keeps a later provider failure as the selected failure instead of retaining local evidence", async () => {
    let requests = 0;
    server.use(
      http.post("*", () => {
        requests++;
        return requests === 1
          ? HttpResponse.json(fixture.response, { status: 502 })
          : HttpResponse.json(
              {
                error: {
                  code: "server_error",
                  message: "provider unavailable",
                },
              },
              { status: 503 },
            );
      }),
    );
    const result = await retryAssistantCall(
      async () => {
        return stream().result();
      },
      { enabled: true, maxRetries: 1, baseDelayMs: 1 },
      undefined,
    );
    expect(requests).toBe(2);
    expect(piModelFailureReason(result)).toBe("provider_server_error");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        type: "okou_model_request",
        details: expect.objectContaining({
          httpStatus: 503,
          failureReason: "provider_server_error",
        }),
      }),
    );
    expect(JSON.stringify(result.diagnostics)).not.toContain(
      "okou_firewall_auth",
    );
  });

  it.each([
    { error: "auth_failed" },
    { error: "server_error", authFailure: fixture.response.authFailure },
    {
      error: "auth_failed",
      authFailure: { ...fixture.response.authFailure, source: "upstream" },
    },
    {
      error: "auth_failed",
      authFailure: { ...fixture.response.authFailure, status: "private-token" },
    },
  ])(
    "does not infer a local failure from an incomplete or unrelated provider envelope",
    async (body) => {
      server.use(
        http.post("*", () => {
          return HttpResponse.json(body, { status: 502 });
        }),
      );
      expect(piModelFailureReason(await stream().result())).toBe(
        "provider_server_error",
      );
    },
  );

  it("preserves an API-confirmed reconnect outcome", async () => {
    server.use(
      http.post("*", () => {
        return HttpResponse.json(
          {
            error: "TOKEN_REFRESH_FAILED",
            failureReason: "reconnect_required",
            connectors: ["codex-oauth-token"],
          },
          { status: 502 },
        );
      }),
    );
    expect(piModelFailureReason(await stream().result())).toBe(
      "reconnect_required",
    );
  });
});
