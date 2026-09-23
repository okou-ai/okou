import { randomUUID } from "node:crypto";

import { agentSetupPromptsContract } from "@okouai/api-contracts/contracts/agent-setup-prompts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { FAST_PATH_MODEL } from "../../external/openrouter";
import { agentSetupPromptRoutes } from "../agent-setup-prompts";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
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

function completion(content: string, finishReason = "stop") {
  return HttpResponse.json({
    choices: [
      {
        finish_reason: finishReason,
        ...(finishReason === "length"
          ? { native_finish_reason: "MAX_TOKENS" }
          : {}),
        message: { content },
      },
    ],
    usage: { prompt_tokens: 120, completion_tokens: 60 },
  });
}

describe("POST /api/agent-setup-prompts", () => {
  it("is unavailable to members without the feature", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
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
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
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

  it("returns the fast model's polished message for the responsibility", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", "agent-setup-openrouter-key");
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
      http.post(OPENROUTER_CHAT_URL, async ({ request }) => {
        providerRequests.push(await request.json());
        return completion(polished);
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
      model: FAST_PATH_MODEL,
      messages: [
        { role: "system" },
        {
          role: "user",
          content: JSON.stringify({
            agentName: "Support Scout",
            responsibility,
          }),
        },
      ],
    });
  });

  it.each([
    { case: "the LLM is not configured", apiKey: undefined, provider: null },
    {
      case: "the provider fails",
      apiKey: "agent-setup-openrouter-key",
      provider: () => {
        return HttpResponse.json(
          { error: { message: "upstream unavailable" } },
          { status: 500 },
        );
      },
    },
    {
      case: "the polished message is truncated",
      apiKey: "agent-setup-openrouter-key",
      provider: () => {
        return completion("Hi Support Scout, every Mon", "length");
      },
    },
  ])(
    "asks the Agent to adopt the raw responsibility when $case",
    async ({ apiKey, provider }) => {
      mockOptionalEnv("OPENROUTER_API_KEY", apiKey);
      await signIn({ featureEnabled: true });
      if (provider) {
        server.use(http.post(OPENROUTER_CHAT_URL, provider));
      }

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
    },
  );
});
