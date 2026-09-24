import { randomUUID } from "node:crypto";

import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import {
  onboardingSourcesContract,
  onboardingWorkflowConnectorsContract,
} from "@okouai/api-contracts/contracts/onboarding";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import {
  corruptApiTestConnectorCatalogActiveSnapshotPayload,
  deleteApiTestConnectorCatalogRuntimeProjectionRow,
  installApiTestConnectorCatalog,
} from "../../../test-fixtures/connector-catalog";
import { createRouteMocks } from "./helpers/route-test";
import { connectorCatalogRoutes } from "../connector-catalog";
import { onboardingSourcesRoutes } from "../onboarding-sources";
import { onboardingWorkflowConnectorsRoutes } from "../onboarding-workflow-connectors";

const context = testContext({ connectorCatalog: true });
const mocks = createRouteMocks(context);

function catalogClient() {
  return setupApp({ context, routes: connectorCatalogRoutes })(
    connectorCatalogContract,
  );
}

const headers = Object.freeze({ authorization: "Bearer clerk-session" });

/**
 * Installs a catalog whose runtime projection is ready, then makes the
 * complete snapshot unreadable. Reads that still answer can only have come
 * from the per-connector projection.
 */
async function projectionOnlyCatalog(): Promise<void> {
  // Own the source so other files' catalog setup cannot replace this one.
  mockEnv(
    "R2_USER_STORAGES_BUCKET_NAME",
    `test-catalog-projection-reads-${randomUUID()}`,
  );
  await installApiTestConnectorCatalog({
    catalogVersion: `api-test-projection-reads-${randomUUID()}`,
    runtimeProjection: true,
  });
  mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
}

describe("connector catalog reads from the runtime projection", () => {
  it("answers a single connector from its projection row without the complete catalog", async () => {
    await projectionOnlyCatalog();
    const before = await accept(
      catalogClient().get({ headers, params: { connectorSlug: "openai" } }),
      [200],
    );

    await corruptApiTestConnectorCatalogActiveSnapshotPayload();

    const status = await accept(catalogClient().status({ headers }), [503]);
    expect(status.body.error.code).toBe("PROVIDER_UNAVAILABLE");
    const after = await accept(
      catalogClient().get({ headers, params: { connectorSlug: "openai" } }),
      [200],
    );
    expect(after.body).toStrictEqual(before.body);
    const permissions = await accept(
      catalogClient().permissions({
        headers,
        params: { connectorSlug: "notion" },
      }),
      [200],
    );
    expect(permissions.body.permissions.connectorSlug).toBe("notion");
  });

  it("reports a slug the complete projection does not hold as unknown", async () => {
    await projectionOnlyCatalog();
    await corruptApiTestConnectorCatalogActiveSnapshotPayload();

    const response = await accept(
      catalogClient().get({
        headers,
        params: { connectorSlug: `missing-${randomUUID().slice(0, 8)}` },
      }),
      [404],
    );
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("lists the onboarding sources from the projection", async () => {
    await projectionOnlyCatalog();
    const before = await accept(
      setupApp({ context, routes: onboardingSourcesRoutes })(
        onboardingSourcesContract,
      ).list({ headers }),
      [200],
    );
    expect(before.body.connectors.length).toBeGreaterThan(0);

    await corruptApiTestConnectorCatalogActiveSnapshotPayload();

    const after = await accept(
      setupApp({ context, routes: onboardingSourcesRoutes })(
        onboardingSourcesContract,
      ).list({ headers }),
      [200],
    );
    expect(after.body).toStrictEqual(before.body);
  });

  it("lists the onboarding workflow connectors from the projection", async () => {
    await projectionOnlyCatalog();
    const client = setupApp({
      context,
      routes: onboardingWorkflowConnectorsRoutes,
    })(onboardingWorkflowConnectorsContract);
    const before = await accept(client.list({ headers }), [200]);
    expect(before.body.connectors.length).toBeGreaterThan(0);

    await corruptApiTestConnectorCatalogActiveSnapshotPayload();

    const after = await accept(client.list({ headers }), [200]);
    expect(after.body).toStrictEqual(before.body);
  });

  it("falls back to the complete catalog when a projection row is missing", async () => {
    await projectionOnlyCatalog();
    await deleteApiTestConnectorCatalogRuntimeProjectionRow("openai");
    await corruptApiTestConnectorCatalogActiveSnapshotPayload();

    // The incomplete projection cannot answer for openai, so the read goes to
    // the complete catalog, which is unreadable here.
    const openai = await accept(
      catalogClient().get({ headers, params: { connectorSlug: "openai" } }),
      [503],
    );
    expect(openai.body.error.code).toBe("PROVIDER_UNAVAILABLE");
    // A connector whose row is still there keeps answering from it.
    await accept(
      catalogClient().get({ headers, params: { connectorSlug: "github" } }),
      [200],
    );
  });
});
