import { randomUUID } from "node:crypto";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { userModelPreferenceRoutes } from "../user-model-preference";
import { createBddApi } from "./helpers/api-bdd";
import { credentials } from "./helpers/codex-reset-credit-expiry";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const app = setupApp({
  context,
  routes: [...meModelProvidersUpsertRoutes, ...userModelPreferenceRoutes],
});

function mockSubscriptionProviders() {
  server.use(
    http.get("https://api.anthropic.com/api/oauth/profile", () => {
      return HttpResponse.json({});
    }),
    http.get("https://api.anthropic.com/api/oauth/usage", () => {
      return HttpResponse.json({});
    }),
    http.get("https://chatgpt.com/backend-api/wham/usage", () => {
      return HttpResponse.json({ plan_type: "pro" });
    }),
  );
}

async function connectFableAndAstraSubscriptions() {
  const api = createBddApi(context);
  await api.bootstrapLimitedFreeOnboarding(api.user());
  mockSubscriptionProviders();
  const client = app(personalModelProvidersMainContract);
  await Promise.all([
    accept(
      client.upsert({
        headers,
        body: {
          type: "claude-code-oauth-token",
          secret: `sk-ant-oat01-${randomUUID()}`,
        },
      }),
      [201],
    ),
    accept(
      client.upsert({
        headers,
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: { CODEX_AUTH_JSON: credentials().raw },
        },
      }),
      [201],
    ),
  ]);
}

describe("personal model route capabilities", () => {
  it("model-route-capabilities-002 (1/2) rejects Fast priority for a connected Claude Fable subscription", async () => {
    await connectFableAndAstraSubscriptions();
    const client = app(userModelPreferenceContract);

    const fable = await accept(
      client.update({
        headers,
        body: { selectedModel: "claude-fable-5-1", serviceTier: "priority" },
      }),
      [400],
    );

    expect(fable.body.error.message).toBe(
      "Codex fast mode is only available for GPT 5.6 runs",
    );
  });

  it("model-route-capabilities-002 (2/2) saves Fast priority for a connected GPT-6 Astra subscription", async () => {
    await connectFableAndAstraSubscriptions();
    const client = app(userModelPreferenceContract);

    const astra = await accept(
      client.update({
        headers,
        body: { selectedModel: "gpt-6-astra", serviceTier: "priority" },
      }),
      [200],
    );

    expect(astra.body).toMatchObject({
      selectedModel: "gpt-6-astra",
      serviceTier: "priority",
    });
    const saved = await accept(client.get({ headers }), [200]);
    expect(saved.body).toMatchObject({
      selectedModel: "gpt-6-astra",
      serviceTier: "priority",
    });
  });
});
