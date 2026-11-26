import { randomUUID } from "node:crypto";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import {
  ONBOARDING_RECOMMENDATION_CONNECTOR_SLUGS,
  onboardingSourcesContract,
} from "@okouai/api-contracts/contracts/onboarding";
import { expect, test } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { connectorCatalogRoutes } from "../connector-catalog";
import { onboardingSourcesRoutes } from "../onboarding-sources";
import { createBddApi } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockGitHubConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { assertPublicConnectorCatalogHasNoPrivateFields } from "./helpers/connector-catalog-public-leak";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

test("onboarding-sources-002 lists the visible onboarding sources in recommendation order", async () => {
  mockGitHubConnectorOAuth();
  const actor = createBddApi(context).user();
  const connectors = createConnectorBddApi(context);
  const started = await connectors.startOauth(actor, "github", "oauth");
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected OAuth state");
  }
  const connected = await connectors.completeOauthCallbackResult("github", {
    state,
    code: `code-${randomUUID()}`,
  });
  expect(connected.body.status).toBe("success");
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );

  const sources = await accept(
    setupApp({ context, routes: onboardingSourcesRoutes })(
      onboardingSourcesContract,
    ).list({ headers }),
    [200],
  );
  const catalog = await accept(
    setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    ).status({ headers }),
    [200],
  );

  const visible = new Set(
    catalog.body.connectors.map((connector) => {
      return connector.slug;
    }),
  );
  expect(
    sources.body.connectors.map((connector) => {
      return connector.slug;
    }),
  ).toStrictEqual(
    ONBOARDING_RECOMMENDATION_CONNECTOR_SLUGS.filter((slug) => {
      return visible.has(slug);
    }),
  );
  const github = sources.body.connectors.find((connector) => {
    return connector.slug === "github";
  });
  expect(github).toMatchObject({
    singleAuthCodeAuthMethodId: "oauth",
    authMethods: [expect.objectContaining({ id: "oauth" })],
  });
  expect(github).not.toHaveProperty("permissionSummary");
  assertPublicConnectorCatalogHasNoPrivateFields(sources.body);
});
