import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";

import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { meModelProvidersListRoutes } from "../me-model-providers-list";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { createRouteMocks } from "./helpers/route-test";
import { mockSecretKmsApplicationEnvHttp } from "./helpers/secret-kms-http";

const context = testContext();
const mocks = createRouteMocks(context);

describe("personal provider KMS configuration", () => {
  it("stores a personal provider when AWS configuration comes from the application environment", async () => {
    mockSecretKmsApplicationEnvHttp();
    const identity = randomUUID();
    mocks.clerk.session(`user_kms_${identity}`, `org_kms_${identity}`);
    server.use(
      http.get("https://api.anthropic.com/api/oauth/profile", () => {
        return HttpResponse.json({
          account: { uuid: identity, email: "kms-provider@example.com" },
          organization: {
            uuid: identity,
            name: "KMS Provider Test",
            organization_type: "claude_pro",
          },
        });
      }),
      http.get("https://api.anthropic.com/api/oauth/usage", () => {
        return HttpResponse.json({});
      }),
    );
    const client = setupApp({
      context,
      routes: [...meModelProvidersListRoutes, ...meModelProvidersUpsertRoutes],
    })(personalModelProvidersMainContract);
    const headers = { authorization: "Bearer clerk-session" };

    const created = await accept(
      client.upsert({
        body: { type: "claude-code-oauth-token", secret: "sk-ant-test" },
        headers,
      }),
      [201],
    );
    expect(created.body).toMatchObject({
      provider: { type: "claude-code-oauth-token", framework: "claude-code" },
      created: true,
    });

    const listed = await accept(client.list({ headers }), [200]);
    expect(listed.body.modelProviders).toContainEqual(
      expect.objectContaining({ id: created.body.provider.id }),
    );
  });
});
