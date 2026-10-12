import { GetObjectCommand } from "@aws-sdk/client-s3";
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  chatThreadConnectorSelectionContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { cronConnectorCatalogContract } from "@okouai/api-contracts/contracts/cron";
import {
  CONNECTOR_CATALOG_ACTIVE_KEY,
  connectorCatalogArtifactSchema,
  type ConnectorCatalogArtifact,
} from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { API_TEST_CONNECTOR_CATALOG_ARTIFACT } from "../../../test-fixtures/connector-catalog-artifact";
import { chatThreadConnectorSelectionRoutes } from "../chat-threads-connector-selections";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import { cronConnectorCatalogRoutes } from "../cron-connector-catalog";
import { createBddApi } from "./helpers/api-bdd";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";

const TEST_APP_ROUTES = Object.freeze([
  ...cronConnectorCatalogRoutes,
  ...chatThreadCreateRoutes,
  ...chatThreadConnectorSelectionRoutes,
]);
const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);
const runs = createRunsApi(context);
const mocks = createRouteMocks(context);

function catalog(version: string, includeOpenai: boolean) {
  const artifact = connectorCatalogArtifactSchema.parse(
    structuredClone(API_TEST_CONNECTOR_CATALOG_ARTIFACT),
  );
  artifact.catalogVersion = version;
  if (!includeOpenai) {
    artifact.connectors = artifact.connectors.filter((connector) => {
      return connector.slug !== "openai";
    });
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

describe("chat-thread current catalog membership", () => {
  it("rejects removed targets and accepts the original account after restoration", async () => {
    const generation = `2099-02-02.${randomUUID()}`;
    const app = await setupApp({
      context,
      routes: TEST_APP_ROUTES,
      isolatePg: true,
    });
    const publisher = app(cronConnectorCatalogContract);
    const threads = app(chatThreadsContract);
    const selections = app(chatThreadConnectorSelectionContract);
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
    await runs.ensurePersonalSubscriptionModel(owner);
    const agent = await bdd.createAgent(owner);
    const connection = await connectors.connectManualGrant(
      owner,
      "openai",
      "api-token",
      { apiKey: "catalog-selection-openai-key" },
      agent.agentId,
    );
    mocks.clerk.session(owner.userId, owner.orgId, "org:member");
    const selection = {
      connectionId: connection.id,
      target: { kind: "builtin" as const, connectorSlug: "openai" },
    };
    const createBody = {
      agentId: agent.agentId,
      model: "claude-fable-5-1",
      connectorSelections: [selection],
    };
    const created = await accept(
      threads.create({ headers, body: createBody }),
      [201],
    );
    const params = { id: created.body.id };
    const initial = await accept(selections.get({ headers, params }), [200]);
    expect(initial.body.selections).toStrictEqual([selection]);
    const updated = await accept(
      selections.update({ headers, params, body: selection }),
      [200],
    );
    expect(updated.body).toStrictEqual(selection);

    serve(catalog(`${generation}.removed`, false));
    const removed = await accept(
      publisher.sync({ headers: cronHeaders }),
      [200],
    );
    expect(removed.body).toStrictEqual({
      outcome: "accepted",
      failureCode: null,
    });
    const rejectedCreate = await accept(
      threads.create({ headers, body: createBody }),
      [400],
    );
    const rejectedUpdate = await accept(
      selections.update({ headers, params, body: selection }),
      [400],
    );
    const unavailable = {
      error: {
        message: "Connector target is unavailable",
        code: "BAD_REQUEST",
      },
    };
    expect(rejectedCreate.body).toStrictEqual(unavailable);
    expect(rejectedUpdate.body).toStrictEqual(unavailable);

    serve(catalog(`${generation}.restored`, true));
    const restored = await accept(
      publisher.sync({ headers: cronHeaders }),
      [200],
    );
    expect(restored.body).toStrictEqual({
      outcome: "accepted",
      failureCode: null,
    });
    const retained = await accept(selections.get({ headers, params }), [200]);
    expect(retained.body.selections).toStrictEqual(initial.body.selections);
    const acceptedUpdate = await accept(
      selections.update({ headers, params, body: selection }),
      [200],
    );
    expect(acceptedUpdate.body).toStrictEqual(selection);
    const acceptedCreate = await accept(
      threads.create({ headers, body: createBody }),
      [201],
    );
    const newSelections = await accept(
      selections.get({ headers, params: { id: acceptedCreate.body.id } }),
      [200],
    );
    expect(newSelections.body.selections).toStrictEqual([selection]);
  });
});
