import { randomUUID } from "node:crypto";
import { modelCatalogContract } from "@okouai/api-contracts/contracts/model-catalog";
import { expect, test } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { modelCatalogRoutes } from "../model-catalog";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const app = setupApp({ context, routes: modelCatalogRoutes });

test("model-catalog-authority-001 exposes canonical Auto first without a provider chooser", async () => {
  createRouteMocks(context).clerk.session(
    `user_${randomUUID()}`,
    `org_${randomUUID()}`,
    "org:member",
  );

  const response = await accept(
    app(modelCatalogContract).get({
      headers: { authorization: "Bearer clerk-session" },
    }),
    [200],
  );

  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.body.systemDefaultModel).toBe("auto");
  expect(response.body.models[0]?.model).toBe("auto");
  const autoRoutes = response.body.routes.filter((route) => {
    return route.model === "auto" && route.enabled;
  });
  expect(autoRoutes).toHaveLength(1);
  expect(autoRoutes[0]?.subscriptionType).toBeNull();
});

test("model-catalog-authority-002 exposes Sol Fast usage and Pi capability per subscription route", async () => {
  createRouteMocks(context).clerk.session(
    `user_${randomUUID()}`,
    `org_${randomUUID()}`,
  );

  const response = await accept(
    app(modelCatalogContract).get({
      headers: { authorization: "Bearer clerk-session" },
    }),
    [200],
  );
  const solRoutes = response.body.routes.filter((route) => {
    return (
      route.subscriptionType === "codex-oauth-token" &&
      route.model.endsWith("-sol")
    );
  });
  expect(solRoutes.length).toBeGreaterThan(0);
  for (const route of solRoutes) {
    expect(route).toMatchObject({ piRuntimeCapable: true });
    const model = response.body.models.find((row) => {
      return row.model === route.model;
    });
    expect(model?.displayName).toMatch(/ Sol$/);
    expect(model?.runOptions).toStrictEqual({
      fast: { chatGptUsageMultiplier: 2.5 },
    });
  }
  const claudeCodeRoutes = response.body.routes.filter((route) => {
    return route.subscriptionType === "claude-code-oauth-token";
  });
  expect(claudeCodeRoutes.length).toBeGreaterThan(0);
  for (const route of claudeCodeRoutes) {
    expect(route).toMatchObject({ piRuntimeCapable: false });
  }
});
