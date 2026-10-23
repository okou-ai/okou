import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
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
