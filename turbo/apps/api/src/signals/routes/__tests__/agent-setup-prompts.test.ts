import { randomUUID } from "node:crypto";

import { agentSetupPromptsContract } from "@okouai/api-contracts/contracts/agent-setup-prompts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { agentSetupPromptRoutes } from "../agent-setup-prompts";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";
import {
  mockGoogleText,
  VERTEX_TEXT_URL,
  vertexTextRequest,
  vertexTextResponse,
} from "./helpers/google-text";

const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const responsibility =
  "Every Monday, sumarize open Zendesk tickets for the Acme account.\nFlag anything waiting more than 2 days and post it in #support-leads.";
const context = testContext();
const mocks = createRouteMocks(context);

function client() {
  return setupApp({ context, routes: agentSetupPromptRoutes })(
    agentSetupPromptsContract,
  );
}

async function signIn(options: { readonly featureEnabled: boolean }) {
  const actor = {
    orgId: `org_agent_setup_${randomUUID()}`,
    userId: `user_agent_setup_${randomUUID()}`,
  };
  if (options.featureEnabled) {
    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.AgentResponsibilitySetup]: true,
    });
  }
  mocks.clerk.session(actor.userId, actor.orgId);
}

describe("POST /api/agent-setup-prompts", () => {
  it("is unavailable to members without the feature", async () => {
    mockOptionalEnv("GCP_LLM_PROJECT_ID", undefined);
    await signIn({ featureEnabled: false });
    const response = await accept(
      client().create({
        headers,
        body: { agentName: "Support Scout", responsibility },
      }),
      [403],
    );
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("rejects a blank responsibility", async () => {
    mockOptionalEnv("GCP_LLM_PROJECT_ID", undefined);
    await signIn({ featureEnabled: true });
    const response = await accept(
      client().create({
        headers,
        body: { agentName: "Support Scout", responsibility: "  \n\t " },
      }),
      [400],
    );
    expect(response.body.error).toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("responsibility"),
    });
  });

  it.each([
    {
      case: "valid usage metadata",
      usageMetadata: { candidatesTokenCount: 60, thoughtsTokenCount: 10 },
    },
    {
      case: "a malformed optional count",
      usageMetadata: {
        candidatesTokenCount: "untrusted-count",
        thoughtsTokenCount: 10,
      },
    },
    {
      case: "malformed optional metadata",
      usageMetadata: "untrusted-metadata",
    },
  ])(
    "returns Flash-Lite's polished message without an OpenRouter key with $case",
    async ({ usageMetadata }) => {
      mockGoogleText();
      mockOptionalEnv("OPENROUTER_API_KEY", undefined);
      await signIn({ featureEnabled: true });
      const polished = [
        "Hi Support Scout, here is your responsibility:",
        "",
        "- Every Monday, summarize open Zendesk tickets for the Acme account.",
        "- Flag anything waiting more than 2 days and post it in #support-leads.",
        "",
        "Please update your description and instructions accordingly, then briefly confirm what you changed.",
      ].join("\n");
      const providerRequests: unknown[] = [];
      server.use(
        http.post(VERTEX_TEXT_URL, async ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Bearer synthetic-google-token",
          );
          providerRequests.push(
            vertexTextRequest(await request.json(), request.url),
          );
          return HttpResponse.json({
            candidates: [
              {
                finishReason: "STOP",
                content: {
                  parts: [
                    {
                      text: "Private reasoning must not enter the setup brief",
                      thought: true,
                    },
                    { text: polished },
                  ],
                },
              },
            ],
            usageMetadata,
          });
        }),
      );
      const response = await accept(
        client().create({
          headers,
          body: { agentName: "Support Scout", responsibility },
        }),
        [200],
      );
      expect(response.body).toStrictEqual({ prompt: polished });
      expect(providerRequests).toHaveLength(1);
      expect(providerRequests[0]).toMatchObject({
        model: "gemini-3.1-flash-lite",
        contents: [
          {
            role: "user",
            parts: [
              {
                text: JSON.stringify({
                  agentName: "Support Scout",
                  responsibility,
                }),
              },
            ],
          },
        ],
        generationConfig: {
          thinkingConfig: { thinkingLevel: "MINIMAL" },
          maxOutputTokens: 2048,
        },
      });
    },
  );

  it.each([
    {
      case: "Google is not configured",
      configured: false,
      provider: () => {
        return vertexTextResponse("Should not be requested");
      },
    },
    {
      case: "the provider fails",
      configured: true,
      provider: () => {
        return new HttpResponse("private upstream error", { status: 503 });
      },
    },
    {
      case: "the provider rejects credentials",
      configured: true,
      provider: () => {
        return new HttpResponse("private upstream error", { status: 401 });
      },
    },
    {
      case: "the provider is rate limited",
      configured: true,
      provider: () => {
        return new HttpResponse(null, { status: 429 });
      },
    },
    {
      case: "the polished message is truncated",
      configured: true,
      provider: () => {
        return vertexTextResponse("Hi Support Scout, every Mon", "MAX_TOKENS");
      },
    },
    {
      case: "the provider blocks the output",
      configured: true,
      provider: () => {
        return HttpResponse.json({ promptFeedback: { blockReason: "SAFETY" } });
      },
    },
    {
      case: "the provider returns invalid JSON",
      configured: true,
      provider: () => {
        return new HttpResponse("private invalid body");
      },
    },
    {
      case: "the provider returns a tool call",
      configured: true,
      provider: () => {
        return HttpResponse.json({
          candidates: [
            {
              finishReason: "STOP",
              content: {
                parts: [
                  { functionCall: { name: "unexpected_tool" } },
                  { text: "private text" },
                ],
              },
            },
          ],
        });
      },
    },
    {
      case: "the response exceeds the byte bound",
      configured: true,
      provider: () => {
        return new HttpResponse("x".repeat(256 * 1024 + 1));
      },
    },
  ])(
    "asks the Agent to adopt the raw responsibility when $case without falling back to OpenRouter",
    async ({ configured, provider }) => {
      if (configured) {
        mockGoogleText();
      } else {
        mockOptionalEnv("GCP_LLM_PROJECT_ID", undefined);
      }
      // An available OpenRouter key must not become an implicit generation fallback.
      mockOptionalEnv("OPENROUTER_API_KEY", "unused-openrouter-key");
      await signIn({ featureEnabled: true });
      let openRouterRequests = 0;
      server.use(
        http.post(VERTEX_TEXT_URL, provider),
        http.post("https://openrouter.ai/api/v1/chat/completions", () => {
          openRouterRequests += 1;
          return HttpResponse.error();
        }),
      );
      const response = await accept(
        client().create({
          headers,
          body: { agentName: "Support Scout", responsibility },
        }),
        [200],
      );
      expect(response.body.prompt).toContain("Support Scout");
      expect(response.body.prompt).toContain(responsibility);
      expect(response.body.prompt).toContain(
        "update your description and instructions",
      );
      expect(openRouterRequests).toBe(0);
    },
  );
});
