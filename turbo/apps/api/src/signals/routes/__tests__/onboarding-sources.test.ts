import { randomUUID } from "node:crypto";

import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import {
  ONBOARDING_RECOMMENDATION_CONNECTOR_SLUGS,
  onboardingSourcesContract,
} from "@okouai/api-contracts/contracts/onboarding";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createBddApi } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockGitHubConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { assertPublicConnectorCatalogHasNoPrivateFields } from "./helpers/connector-catalog-public-leak";
import { createRouteMocks } from "./helpers/route-test";
import { connectorCatalogRoutes } from "../connector-catalog";
import { onboardingSourcesRoutes } from "../onboarding-sources";

const context = testContext({ connectorCatalog: true });
const mocks = createRouteMocks(context);
const bdd = createBddApi(context);
const connectorsApi = createConnectorBddApi(context);

function stateFromAuthorizationUrl(authorizationUrl: string): string {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected connector authorization URL to include state");
  }
  return state;
}

describe("GET /api/onboarding/sources", () => {
  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context, routes: onboardingSourcesRoutes })(
      onboardingSourcesContract,
    );
    const response = await accept(client.list({ headers: {} }), [401]);

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns the visible onboarding sources with the caller's connection status", async () => {
    const actor = bdd.user();
    mockGitHubConnectorOAuth();
    const start = await connectorsApi.startOauth(actor, "github", "oauth");
    await connectorsApi.completeOauthCallback("github", {
      code: `github-${randomUUID()}`,
      state: stateFromAuthorizationUrl(start.authorizationUrl),
    });
    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const headers = { authorization: "Bearer clerk-session" };

    const sources = await accept(
      setupApp({ context, routes: onboardingSourcesRoutes })(
        onboardingSourcesContract,
      ).list({ headers }),
      [200],
    );
    const status = await accept(
      setupApp({ context, routes: connectorCatalogRoutes })(
        connectorCatalogContract,
      ).status({ headers }),
      [200],
    );

    assertPublicConnectorCatalogHasNoPrivateFields(sources.body);
    // The visible onboarding sources, in the order onboarding names them.
    const visibleSlugs = new Set(
      status.body.connectors.map((connector) => {
        return connector.slug;
      }),
    );
    expect(
      sources.body.connectors.map((connector) => {
        return connector.slug;
      }),
    ).toStrictEqual(
      ONBOARDING_RECOMMENDATION_CONNECTOR_SLUGS.filter((slug) => {
        return visibleSlugs.has(slug);
      }),
    );
    const github = sources.body.connectors.find((connector) => {
      return connector.slug === "github";
    });
    expect(github).toMatchObject({
      connected: true,
      connectionStatus: "connected",
      singleAuthCodeAuthMethodId: "oauth",
    });
    expect(github).not.toHaveProperty("permissionSummary");
  });
});
