import { GetObjectCommand } from "@aws-sdk/client-s3";
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { connectedConnectorsContract } from "@okouai/api-contracts/contracts/connected-connectors";
import { cronConnectorCatalogContract } from "@okouai/api-contracts/contracts/cron";
import {
  CONNECTOR_CATALOG_ACTIVE_KEY,
  connectorCatalogArtifactSchema,
  type ConnectorCatalogArtifact,
} from "@okouai/connectors/connector-catalog/artifacts/artifacts";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { API_TEST_CONNECTOR_CATALOG_ARTIFACT } from "../../../test-fixtures/connector-catalog-artifact";
import { connectedConnectorsRoutes } from "../connected-connectors";
import { cronConnectorCatalogRoutes } from "../cron-connector-catalog";
import { createBddApi } from "./helpers/api-bdd";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import { createRouteMocks } from "./helpers/route-test";

const TEST_APP_ROUTES = Object.freeze([
  ...cronConnectorCatalogRoutes,
  ...connectedConnectorsRoutes,
]);
const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);
const mocks = createRouteMocks(context);

function changedMetadata(phase: string) {
  return {
    label: `Brief ${phase}`,
    icon: {
      url: `https://static.vm0.io/test-fixtures/connectors/brief-${phase}.svg`,
      invertInDarkMode: true,
    },
  };
}

function catalog(version: string, phase: string | null) {
  const artifact = connectorCatalogArtifactSchema.parse(
    structuredClone(API_TEST_CONNECTOR_CATALOG_ARTIFACT),
  );
  artifact.catalogVersion = version;
  if (phase === null) {
    artifact.connectors = artifact.connectors.filter((connector) => {
      return connector.slug !== "openai" && connector.slug !== "github";
    });
  } else {
    for (const slug of ["openai", "github"]) {
      const connector = artifact.connectors.find((entry) => {
        return entry.slug === slug;
      });
      if (!connector) {
        throw new Error(`Missing fixed ${slug} connector`);
      }
      connector.label = changedMetadata(phase).label;
      connector.icon = {
        key: `test-fixtures/connectors/brief-${phase}.svg`,
        invertInDarkMode: true,
      };
    }
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

describe("connected connector briefs", () => {
  it("uses current metadata, omits removed entries and restores saved connectors", async () => {
    const generation = `2099-03-04.${randomUUID()}`;
    const app = await setupApp({
      context,
      routes: TEST_APP_ROUTES,
      isolatePg: true,
    });
    const publisher = app(cronConnectorCatalogContract);
    const cronHeaders = { authorization: "Bearer test-cron-secret" };
    const headers = { authorization: "Bearer clerk-session" };

    serve(catalog(`${generation}.initial`, "initial"));
    const first = await accept(publisher.sync({ headers: cronHeaders }), [200]);
    expect(first.body).toStrictEqual({
      outcome: "accepted",
      failureCode: null,
    });
    const owner = bdd.user();
    await connectors.connectManualGrant(owner, "openai", "api-token", {
      apiKey: "synthetic-brief-openai-key",
    });
    await connectors.connectManualGrant(owner, "gitlab", "api-token", {
      accessToken: "synthetic-brief-gitlab-key",
      host: "gitlab.example.com",
    });
    mocks.clerk.session(owner.userId, owner.orgId, owner.orgRole);
    const connected = app(connectedConnectorsContract);
    const initial = await accept(connected.list({ headers }), [200]);
    expect(initial.body.builtinConnectors).toContainEqual(
      expect.objectContaining({
        slug: "openai",
        ...changedMetadata("initial"),
      }),
    );

    serve(catalog(`${generation}.replacement`, "replacement"));
    expect(
      (await accept(publisher.sync({ headers: cronHeaders }), [200])).body,
    ).toStrictEqual(first.body);
    const replaced = await accept(connected.list({ headers }), [200]);
    expect(replaced.body).toStrictEqual({
      ...initial.body,
      builtinConnectors: initial.body.builtinConnectors.map((brief) => {
        return brief.slug === "openai"
          ? { ...brief, ...changedMetadata("replacement") }
          : brief;
      }),
    });

    serve(catalog(`${generation}.removed`, null));
    expect(
      (await accept(publisher.sync({ headers: cronHeaders }), [200])).body,
    ).toStrictEqual(first.body);
    const removed = await accept(connected.list({ headers }), [200]);
    expect(removed.body).toStrictEqual({
      ...initial.body,
      builtinConnectors: initial.body.builtinConnectors.filter((brief) => {
        return brief.slug !== "openai";
      }),
    });

    serve(catalog(`${generation}.restored`, "restored"));
    expect(
      (await accept(publisher.sync({ headers: cronHeaders }), [200])).body,
    ).toStrictEqual(first.body);
    const restored = await accept(connected.list({ headers }), [200]);
    expect(restored.body).toStrictEqual({
      ...initial.body,
      builtinConnectors: initial.body.builtinConnectors.map((brief) => {
        return brief.slug === "openai"
          ? { ...brief, ...changedMetadata("restored") }
          : brief;
      }),
    });
  });
});
