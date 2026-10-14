import { GetObjectCommand } from "@aws-sdk/client-s3";
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cronConnectorCatalogContract } from "@okouai/api-contracts/contracts/cron";
import { userPermissionGrantsContract } from "@okouai/api-contracts/contracts/user-permission-grants";
import {
  CONNECTOR_CATALOG_ACTIVE_KEY,
  connectorCatalogArtifactSchema,
  type ConnectorCatalogArtifact,
} from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { API_TEST_CONNECTOR_CATALOG_ARTIFACT } from "../../../test-fixtures/connector-catalog-artifact";
import { cronConnectorCatalogRoutes } from "../cron-connector-catalog";
import { userPermissionGrantsRoutes } from "../user-permission-grants";
import { createBddApi } from "./helpers/api-bdd";
import { createRouteMocks } from "./helpers/route-test";

const TEST_APP_ROUTES = Object.freeze([
  ...cronConnectorCatalogRoutes,
  ...userPermissionGrantsRoutes,
]);
const context = testContext();
const bdd = createBddApi(context);
const mocks = createRouteMocks(context);

function catalog(version: string, includeSlack: boolean) {
  const artifact = connectorCatalogArtifactSchema.parse(
    structuredClone(API_TEST_CONNECTOR_CATALOG_ARTIFACT),
  );
  artifact.catalogVersion = version;
  // Retain a stable connector so the generation without Slack is still a valid,
  // nonempty catalog, without republishing every unrelated connector.
  artifact.connectors = artifact.connectors.filter((connector) => {
    return (
      connector.slug === "openai" ||
      (includeSlack && connector.slug === "slack")
    );
  });
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

describe("permission-grant current catalog membership", () => {
  it("hides removed connector grants and restores their original responses", async () => {
    const generation = `2099-02-01.${randomUUID()}`;
    const app = await setupApp({
      context,
      routes: TEST_APP_ROUTES,
      isolatePg: true,
    });
    const publisher = app(cronConnectorCatalogContract);
    const client = app(userPermissionGrantsContract);
    const cronHeaders = { authorization: "Bearer test-cron-secret" };
    const headers = { authorization: "Bearer clerk-session" };

    serve(catalog(`${generation}.present`, true));
    const first = await accept(publisher.sync({ headers: cronHeaders }), [200]);
    expect(first.body).toStrictEqual({
      outcome: "accepted",
      failureCode: null,
    });

    const owner = bdd.user({ orgRole: "org:member" });
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(owner);
    mocks.clerk.session(owner.userId, owner.orgId, "org:member");
    const applied = await accept(
      client.apply({
        headers,
        body: {
          agentId: agent.agentId,
          connectorSlug: "slack",
          mode: "patch",
          grants: [
            { permission: "conversations:read", action: "allow" },
            { permission: "chat:write", action: "deny" },
          ],
        },
      }),
      [200],
    );
    expect(applied.body).toHaveLength(2);
    const listed = await accept(
      client.list({ headers, query: { agentId: agent.agentId } }),
      [200],
    );
    expect(listed.body).toHaveLength(2);
    expect(listed.body).toStrictEqual(expect.arrayContaining(applied.body));

    serve(catalog(`${generation}.removed`, false));
    const removed = await accept(
      publisher.sync({ headers: cronHeaders }),
      [200],
    );
    expect(removed.body).toStrictEqual({
      outcome: "accepted",
      failureCode: null,
    });
    const hidden = await accept(
      client.list({ headers, query: { agentId: agent.agentId } }),
      [200],
    );
    expect(hidden.body).toStrictEqual([]);

    serve(catalog(`${generation}.restored`, true));
    const restored = await accept(
      publisher.sync({ headers: cronHeaders }),
      [200],
    );
    expect(restored.body).toStrictEqual({
      outcome: "accepted",
      failureCode: null,
    });
    const visible = await accept(
      client.list({ headers, query: { agentId: agent.agentId } }),
      [200],
    );
    expect(visible.body).toStrictEqual(listed.body);
  });
});
