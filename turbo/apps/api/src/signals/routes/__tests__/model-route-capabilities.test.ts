import { randomUUID } from "node:crypto";
import { http, HttpResponse } from "msw";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import { expect, test } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { userModelPreferenceRoutes } from "../user-model-preference";
import { createBddApi } from "./helpers/api-bdd";
import { credentials } from "./helpers/codex-reset-credit-expiry";

const context = testContext();
const headers = { authorization: "Bearer clerk-session" };
const providers = setupApp({ context, routes: meModelProvidersUpsertRoutes });
const preferences = setupApp({ context, routes: userModelPreferenceRoutes });

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
  const client = providers(personalModelProvidersMainContract);
  await accept(
    client.upsert({
      headers,
      body: {
        type: "claude-code-oauth-token",
        secret: `sk-ant-oat01-${randomUUID()}`,
      },
    }),
    [201],
  );
  await accept(
    client.upsert({
      headers,
      body: {
        type: "codex-oauth-token",
        authMethod: "auth_json",
        secrets: { CODEX_AUTH_JSON: credentials().raw },
      },
    }),
    [201],
  );
}

test("model-route-capabilities-002 offers Fast only for the connected model whose route supports priority", async () => {
  await connectFableAndAstraSubscriptions();
  const client = preferences(userModelPreferenceContract);

  const fable = await client.update({
    headers,
    body: { selectedModel: "claude-fable-5-1", serviceTier: "priority" },
  });
  const astra = await accept(
    client.update({
      headers,
      body: { selectedModel: "gpt-6-astra", serviceTier: "priority" },
    }),
    [200],
  );

  expect(fable).toMatchObject({
    status: 400,
    body: {
      error: { message: "Codex fast mode is only available for GPT 5.6 runs" },
    },
  });
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
