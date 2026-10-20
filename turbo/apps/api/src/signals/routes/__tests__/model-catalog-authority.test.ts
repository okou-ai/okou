import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { modelCatalogContract } from "@okouai/api-contracts/contracts/model-catalog";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
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
  it("exposes canonical Auto without a provider chooser", async () => {
    authenticate();
    const response = await accept(catalog().get({ headers }), [200]);
    expect(response.body.systemDefaultModel).toBe("auto");
    expect(response.body.models[0]).toMatchObject({
      model: "auto",
      displayName: "Auto",
    });
    expect(
      response.body.routes.filter((route) => {
        return route.providerType === "built-in";
      }),
    ).toStrictEqual([
      expect.objectContaining({ providerType: "built-in", enabled: true }),
    ]);
  });

  it("projects shared Fast usage and Pi capability for independently shipped clients", async () => {
    authenticate();
    const { body } = await accept(catalog().get({ headers }), [200]);
    const codex = body.models.find((model) => {
      return model.model === "gpt-6.1-sol";
    });
    expect(codex?.runOptions?.fast?.chatGptUsageMultiplier).toBe(2.5);
    expect(
      body.routes.find((route) => {
        return (
          route.model === "gpt-6.1-sol" &&
          route.providerType === "codex-oauth-token"
        );
      })?.piRuntimeCapable,
    ).toBeTruthy();
    expect(
      body.routes
        .filter((route) => {
          return route.providerType === "claude-code-oauth-token";
        })
        .every((route) => {
          return route.piRuntimeCapable === false;
        }),
    ).toBeTruthy();
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
