import { randomUUID } from "node:crypto";
import { describe, expect, it, onTestFinished } from "vitest";
import { modelCatalogContract } from "@okouai/api-contracts/contracts/model-catalog";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { insertCatalogModelFixture } from "../../../test-fixtures/model-catalog";
import { modelCatalogRoutes } from "../model-catalog";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
function catalog() {
  return setupApp({ context, routes: modelCatalogRoutes })(
    modelCatalogContract,
  );
}
function authenticate() {
  const id = randomUUID();
  mocks.clerk.session(
    `user_auto_catalog_${id}`,
    `org_auto_catalog_${id}`,
    "org:member",
  );
}

describe("fixed Auto catalog authority", () => {
  it("exposes Auto without a workspace price or provider chooser", async () => {
    authenticate();
    const response = await accept(catalog().get({ headers }), [200]);
    expect(response.body.systemDefaultModel).toBe("okou-1.0");
    expect(response.body.models).toHaveLength(1);
    expect(response.body.models[0]).toMatchObject({
      model: "okou-1.0",
      displayName: "Auto",
      priceTier: null,
    });
    expect(response.body.routes).toStrictEqual([
      expect.objectContaining({ providerType: "built-in", enabled: true }),
    ]);
  });

  it("does not expose or admit a new platform model just because a catalog row exists", async () => {
    const model = `retired_catalog_route_${randomUUID()}`;
    onTestFinished(
      await insertCatalogModelFixture({
        model,
        displayName: "Retired direct model",
        sortOrder: 90_000,
        builtInRoutes: [
          {
            concreteProviderType: "openai-api-key",
            upstreamModel: "arbitrary-native-model",
            priority: 0,
            efforts: [],
            defaultEffort: null,
          },
        ],
      }),
    );
    authenticate();
    const response = await accept(catalog().get({ headers }), [200]);
    expect(response.body.systemDefaultModel).toBe("okou-1.0");
    expect(
      response.body.models.map((entry) => {
        return entry.model;
      }),
    ).toStrictEqual(["okou-1.0"]);
  });

  it("requires an authenticated organization session", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
      toAuth: () => {
        return {};
      },
    });
    await accept(catalog().get({ headers }), [401]);
  });
});
