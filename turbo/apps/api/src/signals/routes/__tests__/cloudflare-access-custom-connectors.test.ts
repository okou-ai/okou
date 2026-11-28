import { randomUUID } from "node:crypto";

import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import {
  customConnectorByIdContract,
  customConnectorProposalContract,
  customConnectorsContract,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { cloudflareAccessRoutes } from "../cloudflare-access";
import { customConnectorsRoutes } from "../custom-connectors";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function workspaceAdmin() {
  const actor = {
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
    orgRole: "org:admin" as const,
  };
  const signIn = () => {
    createRouteMocks(context).clerk.session(
      actor.userId,
      actor.orgId,
      actor.orgRole,
    );
  };
  signIn();
  return { actor, signIn };
}

function clients() {
  return {
    configs: setupApp({ context, routes: cloudflareAccessRoutes })(
      cloudflareAccessContract,
    ),
    connectors: setupApp({ context, routes: customConnectorsRoutes })(
      customConnectorsContract,
    ),
    connector: setupApp({ context, routes: customConnectorsRoutes })(
      customConnectorByIdContract,
    ),
    proposals: setupApp({ context, routes: customConnectorsRoutes })(
      customConnectorProposalContract,
    ),
  };
}

async function createOrganizationConfig(
  configs: ReturnType<typeof clients>["configs"],
  clientSecret = `secret-${randomUUID()}`,
) {
  const created = await accept(
    configs.create({
      headers,
      query: { view: "scoped" },
      body: {
        id: randomUUID(),
        name: `Gateway ${randomUUID().slice(0, 8)}`,
        scope: "organization",
        credentials: { clientId: `client-${randomUUID()}`, clientSecret },
      },
    }),
    [201],
  );
  return created.body;
}

function httpDefinition(displayName: string) {
  return {
    displayName,
    prefixTemplates: [`https://api-${randomUUID()}.example.test/v1/`],
    fields: [],
    headerInjections: [],
    queryInjections: [],
    authMode: "none" as const,
  };
}

describe("custom connector Cloudflare Access bindings", () => {
  it("cloudflare-access-custom-connectors-005 rejects a new Cloudflare binding while the feature is disabled", async () => {
    workspaceAdmin();
    const api = clients();
    const networkBinding = {
      type: "cloudflare_access" as const,
      configId: randomUUID(),
    };
    const definition = httpDefinition("Partner API");

    await accept(
      api.connectors.create({
        headers,
        body: { ...definition, networkBinding },
      }),
      [400],
    );
    await accept(
      api.proposals.save({
        headers,
        body: {
          proposal: {
            operation: "create",
            displayName: definition.displayName,
            prefixTemplates: definition.prefixTemplates,
            fields: [],
            headerInjections: [],
            queryInjections: [],
            networkBinding,
          },
          values: [],
        },
      }),
      [400],
    );
    const empty = await accept(api.connectors.list({ headers }), [200]);
    expect(empty.body.connectors).toStrictEqual([]);

    const created = await accept(
      api.connectors.create({ headers, body: definition }),
      [201],
    );
    await accept(
      api.connector.update({
        headers,
        params: { id: created.body.id },
        body: { ...definition, networkBinding },
      }),
      [400],
    );
    const read = await accept(
      api.connector.get({ headers, params: { id: created.body.id } }),
      [200],
    );
    expect(read.body).not.toHaveProperty("networkBinding");
  });

  it("cloudflare-access-custom-connectors-003 leaves unbound HTTP connectors direct and never exposes the Cloudflare secret", async () => {
    workspaceAdmin();
    const api = clients();
    const clientSecret = `secret-${randomUUID()}`;
    const config = await createOrganizationConfig(api.configs, clientSecret);
    const definition = httpDefinition("Billing API");

    const created = await accept(
      api.connectors.create({ headers, body: definition }),
      [201],
    );
    const read = await accept(
      api.connector.get({ headers, params: { id: created.body.id } }),
      [200],
    );
    expect(read.body).not.toHaveProperty("networkBinding");
    const renamed = await accept(
      api.connector.update({
        headers,
        params: { id: created.body.id },
        body: { ...definition, displayName: "Billing API v2" },
      }),
      [200],
    );
    expect(renamed.body.displayName).toBe("Billing API v2");
    expect(renamed.body).not.toHaveProperty("networkBinding");

    const plain = await accept(
      api.configs.list({ headers, query: { view: "scoped" } }),
      [200],
    );
    const plainConfig = plain.body.configs.find(({ id }) => {
      return id === config.id;
    });
    expect(plainConfig).toBeDefined();
    expect(plainConfig).not.toHaveProperty("customConnectors");
    const withConnectors = await accept(
      api.configs.list({
        headers,
        query: { view: "scoped", includeCustomConnectors: "true" },
      }),
      [200],
    );
    const optedIn = withConnectors.body.configs.find(({ id }) => {
      return id === config.id;
    });
    expect(optedIn?.customConnectors).toStrictEqual([]);
    expect(JSON.stringify(withConnectors.body)).not.toContain(clientSecret);

    const preview = await accept(
      api.configs.impactPreview({
        headers,
        params: { configId: config.id },
        query: { operation: "convert", includeCustomConnectors: "true" },
      }),
      [200],
    );
    expect(preview.body.customConnectors).toStrictEqual([]);
    await accept(
      api.configs.convertToPersonal({
        headers,
        params: { configId: config.id },
        body: {
          expectedRevision: preview.body.expectedRevision,
          impactSnapshot: preview.body.impactSnapshot,
        },
      }),
      [200],
    );
    await accept(
      api.connector.delete({ headers, params: { id: created.body.id } }),
      [204],
    );
  });

  it("cloudflare-access-custom-connectors-001 keeps a bound HTTP connector blocking its configuration until the binding is cleared", async () => {
    const { actor, signIn } = workspaceAdmin();
    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.CustomConnectorCloudflareAccess]: true,
    });
    signIn();
    const api = clients();
    const config = await createOrganizationConfig(api.configs);
    const binding = { type: "cloudflare_access" as const, configId: config.id };
    const definition = httpDefinition("Internal Orders");

    const created = await accept(
      api.connectors.create({
        headers,
        body: { ...definition, networkBinding: binding },
      }),
      [201],
    );
    expect(created.body.networkBinding).toMatchObject({
      ...binding,
      status: "available",
    });

    const renamed = await accept(
      api.connector.update({
        headers,
        params: { id: created.body.id },
        body: { ...definition, displayName: "Internal Orders v2" },
      }),
      [200],
    );
    expect(renamed.body.networkBinding).toStrictEqual(
      created.body.networkBinding,
    );
    expect(renamed.body.storageVersion).toBe(created.body.storageVersion);

    const listed = {
      id: created.body.id,
      displayName: "Internal Orders v2",
      kind: "http",
    };
    const previews = await Promise.all(
      (["delete", "convert"] as const).map((operation) => {
        return accept(
          api.configs.impactPreview({
            headers,
            params: { configId: config.id },
            query: { operation, includeCustomConnectors: "true" },
          }),
          [200],
        );
      }),
    );
    const [deletePreview, convertPreview] = previews;
    if (!deletePreview || !convertPreview) {
      throw new Error("Expected both impact previews");
    }
    expect(deletePreview.body.customConnectors).toStrictEqual([listed]);
    expect(convertPreview.body.customConnectors).toStrictEqual([listed]);
    const [blockedDelete, blockedConvert] = await Promise.all([
      accept(
        api.configs.delete({
          headers,
          params: { configId: config.id },
          body: {
            expectedRevision: deletePreview.body.expectedRevision,
            impactSnapshot: deletePreview.body.impactSnapshot,
          },
        }),
        [409],
      ),
      accept(
        api.configs.convertToPersonal({
          headers,
          params: { configId: config.id },
          body: {
            expectedRevision: convertPreview.body.expectedRevision,
            impactSnapshot: convertPreview.body.impactSnapshot,
          },
        }),
        [409],
      ),
    ]);
    expect(blockedDelete.body.error.message).toContain("custom connectors");
    expect(blockedConvert.body.error.message).toContain("custom connectors");

    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.CustomConnectorCloudflareAccess]: false,
    });
    signIn();
    const cleared = await accept(
      api.connector.update({
        headers,
        params: { id: created.body.id },
        body: {
          ...definition,
          displayName: "Internal Orders v2",
          networkBinding: null,
        },
      }),
      [200],
    );
    expect(cleared.body).not.toHaveProperty("networkBinding");
    expect(cleared.body.storageVersion).toBe(created.body.storageVersion);

    const freePreview = await accept(
      api.configs.impactPreview({
        headers,
        params: { configId: config.id },
        query: { operation: "delete", includeCustomConnectors: "true" },
      }),
      [200],
    );
    expect(freePreview.body.customConnectors).toStrictEqual([]);
    await accept(
      api.configs.delete({
        headers,
        params: { configId: config.id },
        body: {
          expectedRevision: freePreview.body.expectedRevision,
          impactSnapshot: freePreview.body.impactSnapshot,
        },
      }),
      [204],
    );
  });
});
