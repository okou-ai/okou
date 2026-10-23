import { GetObjectCommand } from "@aws-sdk/client-s3";
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { builtinConnectorManualGrantContract } from "@okouai/api-contracts/contracts/connectors";
import { cronConnectorCatalogContract } from "@okouai/api-contracts/contracts/cron";
import {
  CONNECTOR_CATALOG_ACTIVE_KEY,
  connectorCatalogArtifactSchema,
  type ConnectorCatalogArtifact,
} from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { API_TEST_CONNECTOR_CATALOG_ARTIFACT } from "../../../test-fixtures/connector-catalog-artifact";
import { connectorCatalogRoutes } from "../connector-catalog";
import { builtinConnectorsRoutes } from "../connectors";
import { cronConnectorCatalogRoutes } from "../cron-connector-catalog";
import { createBddApi } from "./helpers/api-bdd";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import { createRouteMocks } from "./helpers/route-test";

const TEST_APP_ROUTES = Object.freeze([
  ...cronConnectorCatalogRoutes,
  ...connectorCatalogRoutes,
]);
const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);
const mocks = createRouteMocks(context);

function catalog(version: string, label: string | null) {
  const artifact = connectorCatalogArtifactSchema.parse(
    structuredClone(API_TEST_CONNECTOR_CATALOG_ARTIFACT),
  );
  artifact.catalogVersion = version;
  const openai = artifact.connectors.find((connector) => {
    return connector.slug === "openai";
  });
  if (!openai) {
    throw new Error("Missing fixed openai connector");
  }
  if (label === null) {
    artifact.connectors = artifact.connectors.filter((connector) => {
      return connector.slug !== "openai";
    });
  } else {
    openai.label = label;
  }
  return artifact;
}

function serve(artifact: ConnectorCatalogArtifact) {
  const raw = Buffer.from(JSON.stringify(artifact));
  const key = `connectors/v4/releases/${artifact.catalogVersion}/catalog.json`;
  const pointer = Buffer.from(
    JSON.stringify({
      catalogVersion: artifact.catalogVersion,
      catalogKey: key,
      catalogDigest: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
    }),
  );
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (!(command instanceof GetObjectCommand)) {
      throw new Error("Unexpected catalog storage request");
    }
    const bytes =
      command.input.Key === CONNECTOR_CATALOG_ACTIVE_KEY
        ? pointer
        : command.input.Key === key
          ? raw
          : undefined;
    if (!bytes) {
      throw new Error("Unexpected catalog storage key");
    }
    return Promise.resolve({
      ContentLength: bytes.length,
      Body: {
        async *[Symbol.asyncIterator]() {
          yield bytes;
        },
      },
    });
  });
}

describe("single-connector current catalog status", () => {
  it("projects missing required configuration consistently and reconnects the exact default", async () => {
    const generation = `2099-03-04.${randomUUID()}`;
    const app = await setupApp({
      context,
      routes: [...TEST_APP_ROUTES, ...builtinConnectorsRoutes],
      isolatePg: true,
    });
    const publisher = app(cronConnectorCatalogContract);
    const cronHeaders = { authorization: "Bearer test-cron-secret" };
    const headers = { authorization: "Bearer clerk-session" };
    serve(catalog(`${generation}.initial`, "Configuration status"));
    await accept(publisher.sync({ headers: cronHeaders }), [200]);
    const owner = bdd.user();
    const connection = await connectors.connectManualGrant(
      owner,
      "openai",
      "api-token",
      { apiKey: "configuration-status-key" },
    );
    const initial = await connectors.readBuiltinConnectorAccount(
      owner,
      "openai",
      connection.id,
    );
    const changed = catalog(
      `${generation}.required-region`,
      "Configuration status",
    );
    const method = changed.connectors
      .find((connector) => {
        return connector.slug === "openai";
      })
      ?.authMethods.find((candidate) => {
        return candidate.id === "api-token";
      });
    if (method?.grant.kind !== "manual") {
      throw new Error("Expected the manual OpenAI auth method");
    }
    method.storage.variables.push("OPENAI_REGION");
    method.grant.fields.push({
      privateName: "OPENAI_REGION",
      publicId: "region",
      label: "Region",
      required: true,
      placeholder: null,
      storage: "variable",
    });
    serve(changed);
    const published = await accept(
      publisher.sync({ headers: cronHeaders }),
      [200],
    );
    expect(published.body).toStrictEqual({
      outcome: "accepted",
      failureCode: null,
    });

    const attention = {
      id: connection.id,
      connectionStatus: "reconnect-required",
      reconnectReason: "configuration_incomplete",
    };
    const account = await connectors.readBuiltinConnectorAccount(
      owner,
      "openai",
      connection.id,
    );
    expect(account).toMatchObject({
      ...attention,
      isDefault: true,
      missingRequiredFields: ["region"],
      configuredFieldKeys: ["apiKey"],
      updatedAt: initial.updatedAt,
    });
    const listed = await connectors.listBuiltinConnectors(owner);
    expect(listed.connectors).toStrictEqual([
      expect.objectContaining(attention),
    ]);
    await expect(
      connectors.readDefaultBuiltinAccount(owner, "openai"),
    ).resolves.toMatchObject(attention);

    mocks.clerk.session(owner.userId, owner.orgId, owner.orgRole);
    const reconnected = await accept(
      app(builtinConnectorManualGrantContract).connect({
        headers,
        params: { connectorSlug: "openai" },
        body: {
          authMethod: "api-token",
          account: { intent: "reconnect", connectionId: connection.id },
          values: {
            apiKey: "reconnected-configuration-key",
            region: "us-test",
          },
        },
      }),
      [200],
    );
    expect(reconnected.body.connectionId).toBe(connection.id);
    await expect(
      connectors.readBuiltinConnectorAccount(owner, "openai", connection.id),
    ).resolves.toMatchObject({
      id: connection.id,
      isDefault: true,
      connectionStatus: "connected",
      reconnectReason: null,
      missingRequiredFields: [],
      configuredFieldKeys: ["apiKey", "region"],
    });
    await expect(
      connectors.readDefaultBuiltinAccount(owner, "openai"),
    ).resolves.toMatchObject({
      id: connection.id,
      connectionStatus: "connected",
      reconnectReason: null,
    });
  });

  it("uses replacement metadata and retains the connection after catalog restoration", async () => {
    const generation = `2099-03-03.${randomUUID()}`;
    const app = await setupApp({
      context,
      routes: TEST_APP_ROUTES,
      isolatePg: true,
    });
    const publisher = app(cronConnectorCatalogContract);
    const client = app(connectorCatalogContract);
    const cronHeaders = { authorization: "Bearer test-cron-secret" };
    const headers = { authorization: "Bearer clerk-session" };
    const params = { connectorSlug: "openai" };

    serve(catalog(`${generation}.initial`, "Initial status catalog"));
    const first = await accept(publisher.sync({ headers: cronHeaders }), [200]);
    expect(first.body).toStrictEqual({
      outcome: "accepted",
      failureCode: null,
    });
    const owner = bdd.user();
    const connection = await connectors.connectManualGrant(
      owner,
      "openai",
      "api-token",
      { apiKey: "catalog-status-openai-key" },
    );
    mocks.clerk.session(owner.userId, owner.orgId, owner.orgRole);
    const initial = await accept(client.get({ headers, params }), [200]);
    expect(initial.body.connector).toMatchObject({
      slug: "openai",
      label: "Initial status catalog",
    });

    serve(catalog(`${generation}.replacement`, "Replacement status catalog"));
    const replacement = await accept(
      publisher.sync({ headers: cronHeaders }),
      [200],
    );
    expect(replacement.body).toStrictEqual(first.body);
    const changed = await accept(client.get({ headers, params }), [200]);
    expect(changed.body).toStrictEqual({
      connector: {
        ...initial.body.connector,
        label: "Replacement status catalog",
      },
    });

    serve(catalog(`${generation}.removed`, null));
    const removed = await accept(
      publisher.sync({ headers: cronHeaders }),
      [200],
    );
    expect(removed.body).toStrictEqual(first.body);
    const missing = await accept(client.get({ headers, params }), [404]);
    expect(missing.body).toStrictEqual({
      error: {
        message: "Connector catalog item not found",
        code: "NOT_FOUND",
      },
    });

    serve(catalog(`${generation}.restored`, "Restored status catalog"));
    const restored = await accept(
      publisher.sync({ headers: cronHeaders }),
      [200],
    );
    expect(restored.body).toStrictEqual(first.body);
    const recovered = await accept(client.get({ headers, params }), [200]);
    expect(recovered.body).toStrictEqual({
      connector: {
        ...initial.body.connector,
        label: "Restored status catalog",
      },
    });
    await expect(
      connectors.readBuiltinConnectorAccount(owner, "openai", connection.id),
    ).resolves.toMatchObject({
      id: connection.id,
      target: { kind: "builtin", connectorSlug: "openai" },
      connectionStatus: "connected",
    });
  });
});
