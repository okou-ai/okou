import { testContext } from "../../../__tests__/test-context";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  manualHttpCustomConnectorCreateBody,
} from "./helpers/api-bdd-connectors";

const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);

async function createUnconfiguredCustomConnector(
  actor: ApiTestUser,
  slug: string,
) {
  return await connectors.createCustomConnector(
    actor,
    manualHttpCustomConnectorCreateBody({
      displayName: `Connector ${slug}`,
      slug: `_${slug}`,
      prefixTemplates: [`https://${slug}.example.test`],
    }),
  );
}

async function createCustomConnector(actor: ApiTestUser, slug: string) {
  const connector = await createUnconfiguredCustomConnector(actor, slug);
  await connectors.setCustomConnectorSecret(
    actor,
    connector.id,
    `${slug}-secret`,
  );
  return connector;
}

async function createPermissionedCustomConnector(
  actor: ApiTestUser,
  slug: string,
) {
  return await connectors.createCustomConnector(
    actor,
    manualHttpCustomConnectorCreateBody({
      displayName: `Connector ${slug}`,
      slug: `_${slug}`,
      prefixTemplates: [`https://${slug}.example.test`],
      permissionBundleRef: "builtin:slack@1",
    }),
  );
}

describe("GET /api/custom-connectors/:id/permissions", () => {
  it("returns permission metadata for a custom connector with a bundle", async () => {
    const actor = bdd.user();
    const connector = await createPermissionedCustomConnector(
      actor,
      "permission-metadata",
    );

    const response = await connectors.readCustomConnectorPermissions(
      actor,
      connector.id,
    );

    expect(response.ref).toBe("builtin:slack@1");
    expect(response.permissions).toContainEqual(
      expect.objectContaining({ name: "chat:write" }),
    );
    expect(response.defaultPolicies["chat:write"]).toBe("deny");
  });

  it("returns 404 when the custom connector has no permission bundle", async () => {
    const actor = bdd.user();
    const connector = await createCustomConnector(actor, "no-permissions");

    const response = await connectors.requestCustomConnectorPermissions(
      actor,
      connector.id,
      [404],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Custom connector permission bundle not found",
        code: "NOT_FOUND",
      },
    });
  });
});
