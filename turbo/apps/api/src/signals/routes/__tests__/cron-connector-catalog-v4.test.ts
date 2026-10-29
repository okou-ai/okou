import { createHash, randomUUID } from "node:crypto";

import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { builtinConnectorsSearchContract } from "@okouai/api-contracts/contracts/connectors";
import { cronConnectorCatalogContract } from "@okouai/api-contracts/contracts/cron";
import { customConnectorsContract } from "@okouai/api-contracts/contracts/custom-connectors";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { connectorCatalogRoutes } from "../connector-catalog";
import { builtinConnectorsRoutes } from "../connectors";
import { cronConnectorCatalogRoutes } from "../cron-connector-catalog";
import { customConnectorsRoutes } from "../custom-connectors";
import { manualHttpCustomConnectorCreateBody } from "./helpers/api-bdd-connectors";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const CRON_SECRET = "v4-catalog-cron-secret";
const CATALOG_VERSION = "2026-09-17.fixture";
const cronHeaders = { authorization: `Bearer ${CRON_SECRET}` } as const;
const sessionHeaders = { authorization: "Bearer clerk-session" } as const;

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function bytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

function httpConnector(
  slug: string,
  label: string,
  tokenName = "FIXTURE_TOKEN",
) {
  return {
    slug,
    label,
    description: "Catalog generation test service",
    category: "testing",
    generation: [],
    tags: [],
    authMethods: [
      {
        id: "api-token",
        label: "API Token",
        description: null,
        visible: true,
        storage: { version: 1, secrets: [tokenName], variables: [] },
        grant: {
          kind: "manual",
          fields: [
            {
              privateName: tokenName,
              publicId: "credential",
              label: "Credential",
              required: true,
              placeholder: null,
              storage: "secret",
            },
          ],
        },
        access: {
          kind: "static",
          envBindings: { [tokenName]: `$secrets.${tokenName}` },
        },
        revoke: { kind: "none" },
      },
    ],
    icon: { key: "test/catalog-service.svg", invertInDarkMode: false },
    skill: { kind: "none" },
    firewall: { kind: "none" },
  };
}

function mcpConnector(slug = "plaud-mcp", tokenName = "NOTES_ACCESS_TOKEN") {
  const tokenBindings = { accessToken: `$secrets.${tokenName}` };
  return {
    ...httpConnector(slug, "Notes"),
    mcp: {
      transport: "streamable-http",
      endpoint: "https://notes.example.com/mcp",
    },
    authMethods: [
      {
        id: "automatic",
        label: "Connect",
        description: null,
        visible: true,
        storage: {
          version: 1,
          secrets: [tokenName],
          variables: [],
        },
        grant: {
          kind: "automatic",
          callbackOrigin: "api",
          outputs: tokenBindings,
        },
        access: {
          kind: "automatic",
          inputs: tokenBindings,
          outputs: tokenBindings,
        },
        revoke: { kind: "none" },
      },
    ],
    firewall: {
      kind: "generated",
      billable: false,
      config: {
        description: "Notes",
        apis: [
          { base: "https://notes.example.com/mcp", auth: {}, permissions: [] },
        ],
      },
      categories: null,
      defaultAllowed: null,
      defaultUnknownPolicy: "allow",
    },
  };
}

function release(args: {
  readonly version?: string;
  readonly label?: string;
  readonly httpSlug?: string;
  readonly mcpSlug?: string;
  readonly mutate?: (catalog: Record<string, unknown>) => void;
}) {
  const version = args.version ?? CATALOG_VERSION;
  const catalog: Record<string, unknown> = {
    artifactSchemaVersion: 4,
    catalogVersion: version,
    categoryMetadata: {
      categories: [
        {
          id: "testing",
          label: "Testing",
          menuLabel: "Testing",
          groupId: null,
        },
      ],
      groups: [],
    },
    connectors: [
      httpConnector(args.httpSlug ?? "catalog-service", args.label ?? "HTTP"),
      mcpConnector(args.mcpSlug),
    ],
  };
  args.mutate?.(catalog);
  const catalogBytes = bytes(catalog);
  const catalogKey = `connectors/v4/releases/${version}/catalog.json`;
  const catalogDigest = digest(catalogBytes);
  const pointer = {
    catalogVersion: version,
    catalogKey,
    catalogDigest,
  };
  return {
    pointer,
    objects: new Map([
      ["connectors/v4/active.json", bytes(pointer)],
      [catalogKey, catalogBytes],
    ]),
  };
}

function requestedKey(command: unknown): string | undefined {
  if (
    typeof command !== "object" ||
    command === null ||
    !("input" in command) ||
    typeof command.input !== "object" ||
    command.input === null ||
    !("Key" in command.input) ||
    typeof command.input.Key !== "string"
  ) {
    return undefined;
  }
  return command.input.Key;
}

function serveObjects(objects: ReadonlyMap<string, Buffer>): void {
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    const key = requestedKey(command);
    if (key === undefined) {
      return Promise.reject(new Error("Unexpected object request"));
    }
    const object = objects.get(key);
    if (object === undefined) {
      return Promise.reject(new Error("Object unavailable"));
    }
    return Promise.resolve({
      ContentLength: object.length,
      Body: {
        async *[Symbol.asyncIterator]() {
          yield object;
        },
      },
    });
  });
}

function cronClient() {
  const app = setupApp({
    context,
    routes: cronConnectorCatalogRoutes,
  });
  return app(cronConnectorCatalogContract);
}

function catalogClient() {
  return setupApp({ context, routes: connectorCatalogRoutes })(
    connectorCatalogContract,
  );
}

async function sync(client = cronClient()) {
  return await accept(client.sync({ headers: cronHeaders }), [200]);
}

async function publicCatalog() {
  return await accept(catalogClient().list({ headers: sessionHeaders }), [200]);
}

beforeEach(() => {
  mockEnv("CRON_SECRET", CRON_SECRET);
  mockEnv("R2_USER_STORAGES_BUCKET_NAME", `catalog-v4-${randomUUID()}`);
  mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
});

describe("connector catalog v4 preparation", () => {
  it("keeps serving the catalog when its source is unavailable", async () => {
    const serving = (await publicCatalog()).body;
    serveObjects(new Map());
    expect((await sync()).body).toStrictEqual({
      outcome: "rejected",
      failureCode: "source-unavailable",
    });
    expect((await publicCatalog()).body).toStrictEqual(serving);
  });

  it("rejects a pointer outside the canonical v4 release namespace", async () => {
    const candidate = release({ label: "Outside namespace" });
    const objects = new Map(candidate.objects);
    objects.set(
      "connectors/v4/active.json",
      bytes({
        ...candidate.pointer,
        catalogKey: `connectors/v3/releases/${CATALOG_VERSION}/catalog.json`,
      }),
    );
    serveObjects(objects);

    expect((await sync()).body).toStrictEqual({
      outcome: "rejected",
      failureCode: "invalid-pointer",
    });
    // The rejected candidate never serves.
    expect(JSON.stringify((await publicCatalog()).body)).not.toContain(
      "Outside namespace",
    );
  });

  it("finds the current Monday MCP connector by name and slug", async () => {
    const searchClient = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorsSearchContract,
    );
    for (const keyword of ["Monday.com", "monday-mcp"]) {
      const searched = await accept(
        searchClient.search({ query: { keyword }, headers: sessionHeaders }),
        [200],
      );
      expect(searched.body.connectors[0]).toMatchObject({ slug: "monday-mcp" });
      const discovered = await accept(
        catalogClient().discovery({
          query: { keyword },
          headers: sessionHeaders,
        }),
        [200],
      );
      expect(discovered.body.connectors[0]).toMatchObject({
        slug: "monday-mcp",
      });
    }
  });

  it("does not expose an MCP transport as an executable HTTP permission bundle", async () => {
    const available = await accept(
      catalogClient().get({
        headers: sessionHeaders,
        params: { connectorSlug: "plaud-mcp" },
      }),
      [200],
    );
    expect(available.body.connector.authMethods).toContainEqual(
      expect.objectContaining({ grantKind: "automatic" }),
    );
    const client = setupApp({ context, routes: customConnectorsRoutes })(
      customConnectorsContract,
    );
    const response = await accept(
      client.create({
        headers: sessionHeaders,
        body: manualHttpCustomConnectorCreateBody({
          displayName: "Custom notes API",
          prefixTemplates: ["https://notes.example.com/mcp"],
          permissionBundleRef: "builtin:plaud-mcp@1",
        }),
      }),
      [400],
    );
    expect(response.body.error.message).toBe(
      "Unknown custom connector permission bundle: builtin:plaud-mcp@1",
    );
  });
});
