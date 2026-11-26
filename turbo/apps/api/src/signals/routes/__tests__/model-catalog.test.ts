import { randomUUID } from "node:crypto";
import { modelCatalogContract } from "@okouai/api-contracts/contracts/model-catalog";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { modelCatalogRoutes } from "../model-catalog";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const app = setupApp({ context, routes: modelCatalogRoutes });
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

describe("GET /api/model-catalog", () => {
  it("model-catalog-001 returns only fixed Auto without a personal subscription", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    createRouteMocks(context).clerk.session(userId, orgId);

    const response = await accept(
      app(modelCatalogContract).get({ headers }),
      [200],
    );

    expect(response.body.systemDefaultModel).toBe("auto");
    expect(response.body.models).toContainEqual(
      expect.objectContaining({
        model: "auto",
        displayName: "Auto",
      }),
    );
    const builtInRoutes = response.body.routes.filter((route) => {
      return route.providerType === "built-in";
    });
    expect(builtInRoutes).toHaveLength(1);
    expect(builtInRoutes[0]).toMatchObject({
      model: "auto",
      providerType: "built-in",
      concreteProviderType: "openrouter-codex",
      upstreamModel: "@preset/okou-1-0",
    });
  });
});
