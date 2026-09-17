import { createHash, randomUUID } from "node:crypto";

import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { cronConnectorCatalogContract } from "@okouai/api-contracts/contracts/cron";
import { customConnectorsContract } from "@okouai/api-contracts/contracts/custom-connectors";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { connectorCatalogRoutes } from "../connector-catalog";
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

function httpConnector(slug: string, label: string) {
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
        storage: { version: 1, secrets: ["FIXTURE_TOKEN"], variables: [] },
        grant: {
          kind: "manual",
          fields: [
            {
              privateName: "FIXTURE_TOKEN",
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
          envBindings: { FIXTURE_TOKEN: "$secrets.FIXTURE_TOKEN" },
        },
        revoke: { kind: "none" },
      },
    ],
    icon: { key: "test/catalog-service.svg", invertInDarkMode: false },
    skill: { kind: "none" },
    firewall: { kind: "none" },
  };
}

function mcpConnector(slug = "notes-mcp") {
  const tokenBindings = { accessToken: "$secrets.NOTES_ACCESS_TOKEN" };
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
          secrets: ["NOTES_ACCESS_TOKEN"],
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
  readonly generation: 3 | 4;
  readonly label?: string;
  readonly httpSlug?: string;
  readonly mcpSlug?: string;
  readonly mutate?: (catalog: Record<string, unknown>) => void;
}) {
  const catalog: Record<string, unknown> = {
    artifactSchemaVersion: args.generation,
    catalogVersion: CATALOG_VERSION,
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
      ...(args.generation === 4 ? [mcpConnector(args.mcpSlug)] : []),
    ],
  };
  args.mutate?.(catalog);
  const catalogBytes = bytes(catalog);
  const catalogKey = `connectors/v${String(args.generation)}/releases/${CATALOG_VERSION}/catalog.json`;
  const catalogDigest = digest(catalogBytes);
  const pointer = {
    catalogVersion: CATALOG_VERSION,
    catalogKey,
    catalogDigest,
  };
  return {
    pointer,
    catalogBytes,
    objects: new Map([
      [`connectors/v${String(args.generation)}/active.json`, bytes(pointer)],
      [catalogKey, catalogBytes],
    ]),
  };
}

function serveObjects(objects: ReadonlyMap<string, Buffer>): void {
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (
      typeof command !== "object" ||
      command === null ||
      !("input" in command) ||
      typeof command.input !== "object" ||
      command.input === null ||
      !("Key" in command.input) ||
      typeof command.input.Key !== "string"
    ) {
      return Promise.reject(new Error("Unexpected object request"));
    }
    const object = objects.get(command.input.Key);
    if (object === undefined) {
      return Promise.reject(new Error("Object unavailable"));
    }
    const etag = `"${digest(object)}"`;
    if ("IfNoneMatch" in command.input && command.input.IfNoneMatch === etag) {
      return Promise.reject(
        Object.assign(new Error("Not modified"), {
          $metadata: { httpStatusCode: 304 },
        }),
      );
    }
    return Promise.resolve({
      ContentLength: object.length,
      ETag: etag,
      Body: {
        async *[Symbol.asyncIterator]() {
          yield object;
        },
      },
    });
  });
}

function cronClient() {
  return setupApp({ context, routes: cronConnectorCatalogRoutes })(
    cronConnectorCatalogContract,
  );
}

function catalogClient() {
  return setupApp({ context, routes: connectorCatalogRoutes })(
    connectorCatalogContract,
  );
}

async function sync() {
  return await accept(cronClient().sync({ headers: cronHeaders }), [200]);
}

async function warmV4() {
  return await accept(cronClient().warmV4({ headers: cronHeaders }), [200]);
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
  it("requires cron authentication for the unscheduled warm-up endpoint", async () => {
    const response = await accept(
      cronClient().warmV4({ headers: { authorization: "Bearer invalid" } }),
      [401],
    );
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("warms v4 without changing default v3 serving, then serves only the explicitly selected generation", async () => {
    const legacy = release({ generation: 3, label: "Accepted v3" });
    const candidate = release({ generation: 4, label: "Accepted v4" });
    serveObjects(new Map([...legacy.objects, ...candidate.objects]));

    expect((await sync()).body).toMatchObject({
      outcome: "accepted",
      schemaVersion: 3,
    });
    const warmed = await warmV4();
    expect(warmed.body).toMatchObject({
      outcome: "accepted",
      schemaVersion: 4,
      state: "current",
      active: { catalogDigest: candidate.pointer.catalogDigest },
      filtering: {
        stale: false,
        filteredAuthMethods: [
          {
            connectorSlug: "notes-mcp",
            authMethodId: "automatic",
            reasons: expect.arrayContaining([
              "missing-grant-provider",
              "missing-access-provider",
            ]),
          },
        ],
      },
    });
    expect((await publicCatalog()).body.connectors).toMatchObject([
      { slug: "catalog-service", label: "Accepted v3" },
    ]);
    expect((await sync()).body).toMatchObject({
      outcome: "unchanged",
      schemaVersion: 3,
      active: { catalogDigest: legacy.pointer.catalogDigest },
    });

    mockEnv("CONNECTOR_CATALOG_SERVING_GENERATION", "4");
    expect((await publicCatalog()).body.connectors).toMatchObject([
      { slug: "catalog-service", label: "Accepted v4" },
    ]);
    expect((await sync()).body).toMatchObject({
      outcome: "unchanged",
      schemaVersion: 4,
    });
    const blockedWarm = await accept(
      cronClient().warmV4({ headers: cronHeaders }),
      [409],
    );
    expect(blockedWarm.body.error.code).toBe("CONFLICT");
  });

  it("keeps a cold v4 selection unavailable when only a valid v3 snapshot exists", async () => {
    serveObjects(release({ generation: 3 }).objects);
    await sync();
    const warmed = await warmV4();
    expect(warmed.body).toMatchObject({
      outcome: "rejected",
      schemaVersion: 4,
      state: "never-synced",
      active: null,
      lastAttempt: { failureCode: "source-unavailable" },
    });

    mockEnv("CONNECTOR_CATALOG_SERVING_GENERATION", "4");
    const unavailable = await accept(
      catalogClient().list({ headers: sessionHeaders }),
      [503],
    );
    expect(unavailable.body.error.code).toBe("PROVIDER_UNAVAILABLE");

    mockEnv("CONNECTOR_CATALOG_SERVING_GENERATION", "3");
    expect((await publicCatalog()).body.connectors).toMatchObject([
      { label: "HTTP" },
    ]);
  });

  it("retains the last accepted v4 snapshot when a later candidate has an invalid protocol", async () => {
    const accepted = release({ generation: 4, label: "Last accepted" });
    serveObjects(accepted.objects);
    await warmV4();
    mockEnv("CONNECTOR_CATALOG_SERVING_GENERATION", "4");
    const invalid = release({
      generation: 4,
      label: "Rejected candidate",
      mutate(catalog) {
        catalog.connectors = [
          httpConnector("catalog-service", "Rejected candidate"),
          {
            ...mcpConnector(),
            mcp: {
              transport: "streamable-http",
              endpoint: "http://notes.example.com/mcp",
            },
          },
        ];
      },
    });
    serveObjects(invalid.objects);

    expect((await sync()).body).toMatchObject({
      outcome: "rejected",
      schemaVersion: 4,
      state: "stale",
      active: { catalogDigest: accepted.pointer.catalogDigest },
      rejectedCandidate: {
        catalogDigest: invalid.pointer.catalogDigest,
        failureCode: "invalid-artifact",
      },
    });
    expect((await publicCatalog()).body.connectors).toMatchObject([
      { label: "Last accepted" },
    ]);
  });

  it("rejects a v4 pointer that references the v3 namespace instead of downgrading", async () => {
    const legacy = release({ generation: 3 });
    const objects = new Map(legacy.objects);
    objects.set("connectors/v4/active.json", bytes(legacy.pointer));
    serveObjects(objects);

    expect((await warmV4()).body).toMatchObject({
      outcome: "rejected",
      schemaVersion: 4,
      active: null,
      lastAttempt: { failureCode: "invalid-pointer" },
    });
  });

  it("rejects changed bytes under the accepted digest without replacing the accepted projection", async () => {
    const accepted = release({ generation: 4, label: "Verified bytes" });
    serveObjects(accepted.objects);
    await warmV4();
    const changed = release({ generation: 4, label: "Unverified bytes" });
    // A new pointer identity forces fetching the candidate; its declared digest
    // deliberately belongs to the old bytes, not to this new immutable object.
    const catalogKey = "connectors/v4/releases/2026-09-18.fixture/catalog.json";
    serveObjects(
      new Map([
        [
          "connectors/v4/active.json",
          bytes({
            ...accepted.pointer,
            catalogVersion: "2026-09-18.fixture",
            catalogKey,
          }),
        ],
        [catalogKey, changed.catalogBytes],
      ]),
    );
    expect((await warmV4()).body).toMatchObject({
      outcome: "rejected",
      active: { catalogDigest: accepted.pointer.catalogDigest },
      lastAttempt: { failureCode: "digest-mismatch" },
    });
    mockEnv("CONNECTOR_CATALOG_SERVING_GENERATION", "4");
    expect((await publicCatalog()).body.connectors).toMatchObject([
      { label: "Verified bytes" },
    ]);
  });

  it("uses explicit protocol metadata for crossed-name connectors and needs no MCP skill resources", async () => {
    const candidate = release({
      generation: 4,
      httpSlug: "http-service-mcp",
      mcpSlug: "spoken-notes",
    });
    // Storage contains only the pointer and catalog. Both descriptors declare
    // skill:none, so accepting this release requires no skill resource fetch.
    serveObjects(candidate.objects);
    expect((await warmV4()).body).toMatchObject({
      outcome: "accepted",
      filtering: {
        filteredAuthMethods: [
          {
            connectorSlug: "spoken-notes",
            reasons: expect.arrayContaining([
              "missing-grant-provider",
              "missing-access-provider",
            ]),
          },
        ],
      },
    });
    mockEnv("CONNECTOR_CATALOG_SERVING_GENERATION", "4");
    expect((await publicCatalog()).body.connectors).toMatchObject([
      { slug: "http-service-mcp", authMethods: [{ grantKind: "manual" }] },
    ]);
  });

  it("does not expose an accepted MCP transport as an executable HTTP permission bundle", async () => {
    serveObjects(release({ generation: 4 }).objects);
    await warmV4();
    mockEnv("CONNECTOR_CATALOG_SERVING_GENERATION", "4");
    const client = setupApp({ context, routes: customConnectorsRoutes })(
      customConnectorsContract,
    );
    const response = await accept(
      client.create({
        headers: sessionHeaders,
        body: manualHttpCustomConnectorCreateBody({
          displayName: "Custom notes API",
          prefixTemplates: ["https://notes.example.com/mcp"],
          permissionBundleRef: "builtin:notes-mcp@1",
        }),
      }),
      [400],
    );
    expect(response.body.error.message).toBe(
      "Unknown custom connector permission bundle: builtin:notes-mcp@1",
    );
  });
});
