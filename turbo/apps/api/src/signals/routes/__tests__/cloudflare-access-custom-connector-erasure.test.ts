import { randomUUID } from "node:crypto";

import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import {
  customConnectorByIdContract,
  customConnectorsContract,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { orgDeleteContract } from "@okouai/api-contracts/contracts/org-routes";
import { webhookClerkContract } from "@okouai/api-contracts/contracts/webhooks";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { cloudflareAccessRoutes } from "../cloudflare-access";
import { customConnectorsRoutes } from "../custom-connectors";
import { featureSwitchesRoutes } from "../feature-switches";
import { orgDeleteRoutes } from "../org-delete";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { createBddApi } from "./helpers/api-bdd";
import { createRouteMocks } from "./helpers/route-test";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const query = Object.freeze({ view: "scoped" as const });
const configs = () => {
  return setupApp({ context, routes: cloudflareAccessRoutes })(
    cloudflareAccessContract,
  );
};
const connectors = () => {
  return setupApp({ context, routes: customConnectorsRoutes })(
    customConnectorsContract,
  );
};
const connectorById = () => {
  return setupApp({ context, routes: customConnectorsRoutes })(
    customConnectorByIdContract,
  );
};

async function owner() {
  const bdd = createBddApi(context);
  const actor = bdd.user({ orgRole: "org:admin" });
  await bdd.readMe(actor);
  if (!actor.orgId) {
    throw new Error("Expected a workspace owner");
  }
  mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
  mocks.s3.listObjects([]);
  await accept(
    setupApp({ context, routes: featureSwitchesRoutes })(
      featureSwitchesContract,
    ).update({
      headers,
      body: {
        switches: { [FeatureSwitchKey.CustomConnectorCloudflareAccess]: true },
      },
    }),
    [200],
  );
  return { ...actor, orgId: actor.orgId };
}

async function createConfig(id: string = randomUUID()) {
  return (
    await accept(
      configs().create({
        headers,
        query,
        body: {
          id,
          scope: "organization",
          name: "Erasure gateway",
          credentials: {
            clientId: "synthetic-id",
            clientSecret: "synthetic-secret",
          },
        },
      }),
      [201],
    )
  ).body;
}

function definition(configId: string) {
  return {
    displayName: "Protected HTTP connector",
    kind: "http" as const,
    prefixTemplates: ["https://api.example.com/"],
    authMode: "none" as const,
    fields: [],
    headerInjections: [],
    queryInjections: [],
    networkBinding: { type: "cloudflare_access" as const, configId },
  };
}

async function eraseOrganization(entry: "manual" | "webhook", orgId: string) {
  if (entry === "manual") {
    context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
      id: orgId,
    });
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      { data: [] },
    );
    context.mocks.clerk.organizations.deleteOrganization.mockResolvedValue({});
    await accept(
      setupApp({ context, routes: orgDeleteRoutes })(orgDeleteContract).delete({
        headers,
        body: { confirm: "confirm" },
      }),
      [200],
    );
  } else {
    mockOptionalEnv(
      "CLERK_WEBHOOK_SIGNING_SECRET",
      "synthetic-erasure-signing-secret",
    );
    const event = { type: "organization.deleted", data: { id: orgId } };
    context.mocks.clerk.verifyWebhook.mockResolvedValueOnce(event);
    await accept(
      setupApp({ context, routes: webhooksClerkRoutes })(
        webhookClerkContract,
      ).post({
        body: JSON.stringify(event),
      }),
      [200],
    );
  }
  await flushWaitUntilForTest();
}

async function erasureScenario() {
  useSecretKmsProbe();
  const departing = await owner();
  const removed = await createConfig();
  const existing = (
    await accept(
      connectors().create({ headers, body: definition(removed.id) }),
      [201],
    )
  ).body;
  await accept(
    connectors().create({
      headers,
      body: {
        displayName: "Protected MCP connector",
        authMode: "none",
        fields: [],
        headerInjections: [],
        queryInjections: [],
        networkBinding: { type: "cloudflare_access", configId: removed.id },
        kind: "mcp",
        endpoint: "https://api.example.com/mcp",
        transport: "streamable-http",
      },
    }),
    [201],
  );
  const survivor = await owner();
  const retained = await createConfig();
  const retainedConnector = (
    await accept(
      connectors().create({ headers, body: definition(retained.id) }),
      [201],
    )
  ).body;
  mocks.clerk.session(departing.userId, departing.orgId, "org:admin");
  return {
    departing,
    removed,
    existing,
    survivor,
    retained,
    retainedConnector,
  };
}

test.each([
  ["manual", "create"],
  ["manual", "update"],
  ["webhook", "create"],
  ["webhook", "update"],
] as const)(
  "%s organization erasure rejects a %s already preparing its network binding",
  async (entry, operation) => {
    const {
      departing,
      removed,
      existing,
      survivor,
      retained,
      retainedConnector,
    } = await erasureScenario();

    // The real KMS boundary follows binding validation and precedes atomic publication.
    // Erasure must disable existing parents before releasing their restrictive edges.
    const probe = useSecretKmsProbe(async (request, callNumber) => {
      if (callNumber === 1) {
        await eraseOrganization(entry, departing.orgId);
      }
      return {
        keyId: request.keyId,
        plaintext: Buffer.from("0123456789abcdef0123456789abcdef", "utf8"),
        encryptedDataKey: Buffer.from(
          `encrypted-data-key:${request.keyId}`,
          "utf8",
        ),
      };
    });
    const oauthDefinition = {
      ...definition(removed.id),
      authMode: "oauth" as const,
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate: "Bearer {{oauth.access_token}}",
        },
      ],
      oauthConfig: {
        providerAdapter: "standard" as const,
        clientId: "application-client",
        clientSecret: "application-secret",
        authorizationUrl: "https://api.example.com/authorize",
        tokenUrl: "https://api.example.com/token",
        tokenEndpointAuthMethod: "client_secret_post" as const,
        pkceMethod: "S256" as const,
        scopes: ["read"],
        authorizationParams: {},
      },
    };
    const rejected =
      operation === "create"
        ? await accept(
            connectors().create({ headers, body: oauthDefinition }),
            [400],
          )
        : await accept(
            connectorById().update({
              headers,
              params: { id: existing.id },
              body: {
                ...oauthDefinition,
                storageVersion: existing.storageVersion,
              },
            }),
            [400],
          );
    expect(probe.generateDataKeyCalls).toBe(1);
    expect(JSON.stringify(rejected.body)).not.toContain("application-secret");

    mocks.clerk.session(survivor.userId, survivor.orgId, "org:admin");
    // Reusing the ID proves deletion removed the protected configuration and all edges.
    const recreated = await createConfig(removed.id);
    expect(recreated.id).toBe(removed.id);
    const current = (
      await accept(
        connectorById().get({ headers, params: { id: retainedConnector.id } }),
        [200],
      )
    ).body;
    expect(current.networkBinding).toMatchObject({
      configId: retained.id,
      status: "available",
    });
  },
);
