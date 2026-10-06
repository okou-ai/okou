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
    expect(
      response.body.models.every((entry) => {
        return entry.priceTier === null;
      }),
    ).toBeTruthy();
    expect(response.body.models[0]).toMatchObject({
      model: "okou-1.0",
      displayName: "Auto",
      priceTier: null,
    });
    expect(
      response.body.routes.filter((route) => {
        return route.providerType === "built-in";
      }),
    ).toStrictEqual([
      expect.objectContaining({ providerType: "built-in", enabled: true }),
    ]);
  });

  it("keeps new catalog metadata without exposing a platform execution route", async () => {
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
    expect(response.body.models).toContainEqual(
      expect.objectContaining({ model, displayName: "Retired direct model" }),
    );
    expect(
      response.body.routes.some((route) => {
        return route.model === model;
      }),
    ).toBeFalsy();
  });

  it("requires an authenticated organization session", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
      toAuth: () => {
        return {};
      },
    });
    const response = await accept(catalog().get({ headers }), [401]);
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });
});
