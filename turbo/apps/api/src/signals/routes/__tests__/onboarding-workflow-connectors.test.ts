import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import {
  ONBOARDING_WORKFLOW_CONNECTOR_SLUGS,
  onboardingWorkflowConnectorsContract,
} from "@okouai/api-contracts/contracts/onboarding";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createBddApi } from "./helpers/api-bdd";
import { createRouteMocks } from "./helpers/route-test";
import { connectorCatalogRoutes } from "../connector-catalog";
import { onboardingWorkflowConnectorsRoutes } from "../onboarding-workflow-connectors";

const context = testContext({ connectorCatalog: true });
const mocks = createRouteMocks(context);
const bdd = createBddApi(context);

function workflowConnectorsClient() {
  return setupApp({ context, routes: onboardingWorkflowConnectorsRoutes })(
    onboardingWorkflowConnectorsContract,
  );
}

describe("GET /api/onboarding/workflow-connectors", () => {
  it("returns 401 when not authenticated", async () => {
    const response = await accept(
      workflowConnectorsClient().list({ headers: {} }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns only the label and icon of each visible workflow connector", async () => {
    const actor = bdd.user();
    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const headers = { authorization: "Bearer clerk-session" };

    const workflowConnectors = await accept(
      workflowConnectorsClient().list({ headers }),
      [200],
    );
    const status = await accept(
      setupApp({ context, routes: connectorCatalogRoutes })(
        connectorCatalogContract,
      ).status({ headers }),
      [200],
    );

    const workflowSlugs = new Set<string>(ONBOARDING_WORKFLOW_CONNECTOR_SLUGS);
    const expected = status.body.connectors.flatMap(({ slug, label, icon }) => {
      return workflowSlugs.has(slug) ? [{ slug, label, icon }] : [];
    });
    expect(expected.length).toBeGreaterThan(0);
    const bySlug = (left: { slug: string }, right: { slug: string }) => {
      return left.slug.localeCompare(right.slug);
    };
    expect([...workflowConnectors.body.connectors].sort(bySlug)).toStrictEqual(
      expected.sort(bySlug),
    );
  });
});
