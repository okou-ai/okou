import { createHash, randomUUID } from "node:crypto";

import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { connectorCheckContract } from "@okouai/api-contracts/contracts/connector-check";
import { cronConnectorCatalogContract } from "@okouai/api-contracts/contracts/cron";
import { customConnectorsContract } from "@okouai/api-contracts/contracts/custom-connectors";
import { runnersBuiltinFirewallsResolveContract } from "@okouai/api-contracts/contracts/runners";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { corruptApiTestConnectorCatalogActiveSnapshotPayload } from "../../../test-fixtures/connector-catalog";
import { installAcceptedV3ConnectorCatalog } from "../../../test-fixtures/connector-catalog-v3";
import { connectorCatalogRoutes } from "../connector-catalog";
import { connectorCheckRoutes } from "../connector-check";
import { cronConnectorCatalogRoutes } from "../cron-connector-catalog";
import { customConnectorsRoutes } from "../custom-connectors";
import { runnersRoutes } from "../runners";
import { createBddApi } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  manualHttpCustomConnectorCreateBody,
} from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const bdd = createBddApi(context);
const connectorsApi = createConnectorBddApi(context);
const CRON_SECRET = "v4-catalog-cron-secret";
const CATALOG_VERSION = "2026-09-17.fixture";
const V3_CATALOG_VERSION = "2099-01-01.retained-v3";
const OFFICIAL_RUNNER_AUTHORIZATION =
  "Bearer vm0_official_abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
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

function httpConnectorWithFirewall(label: string) {
  return {
    ...httpConnector("catalog-service", label),
    firewall: {
      kind: "generated",
      billable: false,
      config: {
        placeholders: { FIXTURE_TOKEN: "fixture-token-placeholder" },
        apis: [
          {
            base: "https://catalog.example.com/v1",
            auth: {
              headers: {
                Authorization: `Bearer \${{ secrets.FIXTURE_TOKEN }}`,
              },
            },
            permissions: [
              {
                name: "items.read",
                description: "Read items",
                rules: ["GET /items"],
              },
            ],
          },
        ],
      },
      categories: null,
      defaultAllowed: ["items.read"],
      defaultUnknownPolicy: "deny",
    },
  };
}

async function installRetainedV3(): Promise<void> {
  await installAcceptedV3ConnectorCatalog({
    catalogVersion: V3_CATALOG_VERSION,
    catalogBytes: bytes({
      artifactSchemaVersion: 3,
      catalogVersion: V3_CATALOG_VERSION,
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
      connectors: [httpConnectorWithFirewall("Retained v3")],
    }),
  });
}

function release(args: {
  readonly label?: string;
  readonly httpSlug?: string;
  readonly mcpSlug?: string;
  readonly mutate?: (catalog: Record<string, unknown>) => void;
}) {
  const catalog: Record<string, unknown> = {
    artifactSchemaVersion: 4,
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
      mcpConnector(args.mcpSlug),
    ],
  };
  args.mutate?.(catalog);
  const catalogBytes = bytes(catalog);
  const catalogKey = `connectors/v4/releases/${CATALOG_VERSION}/catalog.json`;
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
      ["connectors/v4/active.json", bytes(pointer)],
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

async function publicCatalog() {
  return await accept(catalogClient().list({ headers: sessionHeaders }), [200]);
}

async function builtinFirewalls<TStatus extends 200 | 400>(status: TStatus) {
  return await accept(
    setupApp({ context, routes: runnersRoutes })(
      runnersBuiltinFirewallsResolveContract,
    ).resolve({
      headers: { authorization: OFFICIAL_RUNNER_AUTHORIZATION },
      body: { names: ["catalog-service"] },
    }),
    [status],
  );
}

beforeEach(() => {
  mockEnv("CRON_SECRET", CRON_SECRET);
  mockEnv("R2_USER_STORAGES_BUCKET_NAME", `catalog-v4-${randomUUID()}`);
  mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
});

describe("connector catalog v4 preparation", () => {
  it("keeps retained v3 HTTP connections and firewalls usable while the first v4 sync fails", async () => {
    await installRetainedV3();
    serveObjects(new Map());
    expect((await publicCatalog()).body.connectors).toMatchObject([
      { slug: "catalog-service", label: "Retained v3" },
    ]);

    const actor = bdd.user();
    const connection = await connectorsApi.connectManualGrant(
      actor,
      "catalog-service",
      "api-token",
      { credential: "retained-catalog-secret" },
    );
    onTestFinished(async () => {
      await connectorsApi.deleteDefaultBuiltinConnectorAccount(
        actor,
        "catalog-service",
      );
    });

    expect((await sync()).body).toMatchObject({
      outcome: "rejected",
      schemaVersion: 4,
      active: null,
      lastAttempt: { failureCode: "source-unavailable" },
    });
    await expect(connectorsApi.listConnectors(actor)).resolves.toMatchObject({
      connectors: [
        {
          id: connection.id,
          slug: "catalog-service",
          authMethod: "api-token",
          connectionStatus: "connected",
        },
      ],
      connectorProvidedBindings: [
        {
          connectorSlug: "catalog-service",
          namespace: "secrets",
          name: "FIXTURE_TOKEN",
        },
      ],
    });
    const check = await accept(
      setupApp({ context, routes: connectorCheckRoutes })(
        connectorCheckContract,
      ).check({
        headers: sessionHeaders,
        body: {
          mode: "url",
          method: "GET",
          url: "https://catalog.example.com/v1/items",
          connectorSlug: "catalog-service",
        },
      }),
      [200],
    );
    expect(check.body).toMatchObject({
      outcome: "resolved",
      connector: { connectorSlug: "catalog-service", label: "Retained v3" },
      permission: {
        kind: "matched",
        permissions: [{ name: "items.read" }],
      },
    });
    const firewalls = await builtinFirewalls(200);
    expect(firewalls.body.firewalls["catalog-service"]).toMatchObject({
      apis: [
        {
          base: "https://catalog.example.com/v1",
          auth: {
            headers: { Authorization: `Bearer \${{ secrets.FIXTURE_TOKEN }}` },
          },
        },
      ],
    });

    const invalid = release({
      mutate(catalog) {
        catalog.artifactSchemaVersion = 3;
      },
    });
    serveObjects(invalid.objects);
    expect((await sync()).body).toMatchObject({
      outcome: "rejected",
      schemaVersion: 4,
      active: null,
      lastAttempt: { failureCode: "unsupported-schema" },
    });
    expect((await publicCatalog()).body.connectors).toMatchObject([
      { label: "Retained v3" },
    ]);
    await expect(
      connectorsApi.readConnectorBySlug(actor, "catalog-service"),
    ).resolves.toMatchObject({
      id: connection.id,
      connectionStatus: "connected",
    });
  });

  it("switches a warmed v3 reader to v4 and retains v4 after a rejected update even when v3 has a newer catalog version", async () => {
    await installRetainedV3();
    serveObjects(new Map());
    expect((await publicCatalog()).body.connectors).toMatchObject([
      { label: "Retained v3" },
    ]);
    expect((await builtinFirewalls(200)).body.firewalls).toHaveProperty(
      "catalog-service",
    );

    const accepted = release({ label: "Preferred v4" });
    serveObjects(accepted.objects);
    expect((await sync()).body).toMatchObject({
      outcome: "accepted",
      schemaVersion: 4,
      active: { catalogVersion: CATALOG_VERSION },
      filtering: { stale: false },
    });
    expect((await publicCatalog()).body.connectors).toMatchObject([
      { label: "Preferred v4" },
    ]);
    expect((await builtinFirewalls(400)).body.error.message).toBe(
      "Unknown builtin firewall: catalog-service",
    );

    const rejected = release({
      label: "Rejected replacement",
      mutate(catalog) {
        catalog.artifactSchemaVersion = 3;
      },
    });
    serveObjects(rejected.objects);
    expect((await sync()).body).toMatchObject({
      outcome: "rejected",
      schemaVersion: 4,
      active: { catalogDigest: accepted.pointer.catalogDigest },
    });
    expect((await publicCatalog()).body.connectors).toMatchObject([
      { label: "Preferred v4" },
    ]);
  });

  it.each(["preserved", "removed"] as const)(
    "handles a %s retained v3 permission bundle for claimed custom connector runtimes during the first v4 sync",
    async (bundleState) => {
      // Historical-state exception: today's sync endpoint cannot recreate a
      // retained v3 snapshot left by an older API. All runtime setup uses APIs.
      await installRetainedV3();
      const runs = createRunsApi(context);
      const actor = bdd.user();
      bdd.acceptAgentStorageWrites();
      runs.acceptStorageDownloads();
      runs.acceptTelemetryIngest();
      const runnerGroup = runs.configureRunnerGroup();
      await runs.grantProEntitlement(actor);
      await runs.ensureOrgModelProvider(actor);
      const agent = await bdd.createAgent(actor, {
        displayName: "Catalog bootstrap permission agent",
        visibility: "private",
      });
      const custom = await connectorsApi.createCustomConnector(
        actor,
        manualHttpCustomConnectorCreateBody({
          displayName: "Catalog bootstrap custom API",
          prefixTemplates: ["https://custom-catalog.example.test/v1/"],
          permissionBundleRef: "builtin:catalog-service@1",
        }),
      );
      const created: { runId?: string } = {};
      onTestFinished(async () => {
        context.mocks.s3.send.mockResolvedValue({ Contents: [] });
        if (created.runId) {
          await runs.requestCancelRun(actor, created.runId, [200, 404]);
        }
        await connectorsApi.deleteCustomConnector(actor, custom.id);
        await bdd.deleteAgent(actor, agent.agentId);
      });
      await connectorsApi.setCustomConnectorSecret(
        actor,
        custom.id,
        "catalog-bootstrap-custom-secret",
      );
      await connectorsApi.requestUpdateAgentCustomConnectorGrants(
        actor,
        agent.agentId,
        [{ customConnectorId: custom.id, permissionNames: ["items.read"] }],
        [200],
      );
      const run = await runs.createRun(actor, {
        agentId: agent.agentId,
        prompt: "Use the retained catalog permission bundle",
        modelProvider: "anthropic-api-key",
      });
      created.runId = run.runId;
      await runs.heartbeatRunner(runnerGroup);
      const claim = await runs.claimRunnerJob(run.runId);
      const registration = claim.connectorRuntimeTargets.find((target) => {
        return (
          target.kind === "custom" && target.customConnectorId === custom.id
        );
      });
      if (!registration) {
        throw new Error("Expected the claimed custom connector runtime");
      }
      const target = { kind: "custom", customConnectorId: custom.id };
      const [initialRuntime] = await runs.syncConnectorRuntime(run.runId, {
        targets: [registration],
      });
      expect(initialRuntime).toMatchObject({
        target,
        state: "available",
        networkPolicy: { allow: ["items.read"] },
      });

      const candidate = release({
        mutate(catalog) {
          catalog.connectors = [
            bundleState === "preserved"
              ? httpConnectorWithFirewall("Retained v3")
              : httpConnector("catalog-service", "Retained v3"),
            mcpConnector(),
          ];
        },
      });
      serveObjects(candidate.objects);
      context.mocks.ably.batchPublish.mockClear();
      expect((await sync()).body.outcome).toBe("accepted");
      const [updatedRuntime] = await runs.syncConnectorRuntime(run.runId, {
        targets: [registration],
      });
      if (bundleState === "preserved") {
        expect(updatedRuntime).toMatchObject({
          target,
          state: "available",
          networkPolicy: { allow: ["items.read"] },
        });
        expect(context.mocks.ably.batchPublish).not.toHaveBeenCalled();
      } else {
        expect(updatedRuntime).toStrictEqual({
          target,
          state: "unresolved",
          reason: "permission-bundle-unavailable",
        });
        expect(context.mocks.ably.batchPublish).toHaveBeenCalledWith({
          channels: [expect.stringMatching(/^runner-group:/)],
          messages: [
            {
              name: "connector-runtime-sync",
              data: JSON.stringify({ runId: run.runId, target }),
              encoding: "json",
            },
          ],
        });
      }
    },
    15_000,
  );

  it("does not return retained v3 when an accepted v4 snapshot is corrupt", async () => {
    await installRetainedV3();
    serveObjects(new Map());
    expect((await publicCatalog()).body.connectors).toMatchObject([
      { label: "Retained v3" },
    ]);
    serveObjects(release({ label: "Accepted v4" }).objects);
    expect((await sync()).body.outcome).toBe("accepted");

    // Infrastructure-corruption exception: no production endpoint writes an
    // invalid gzip snapshot. Corrupt before the first v4 read, so its original
    // immutable bytes are not already in this process's accepted-reader cache.
    await corruptApiTestConnectorCatalogActiveSnapshotPayload();
    const unavailable = await accept(
      catalogClient().list({ headers: sessionHeaders }),
      [503],
    );
    expect(unavailable.body.error.code).toBe("PROVIDER_UNAVAILABLE");
  });

  it("serves complete v4 HTTP data through normal sync while filtering unsupported MCP methods", async () => {
    const candidate = release({ label: "Accepted v4" });
    serveObjects(candidate.objects);
    expect((await sync()).body).toMatchObject({
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
              "unsupported-protocol",
              "missing-grant-provider",
              "missing-access-provider",
            ]),
          },
        ],
      },
    });
    expect((await publicCatalog()).body.connectors).toMatchObject([
      { slug: "catalog-service", label: "Accepted v4" },
    ]);
    expect((await sync()).body).toMatchObject({
      outcome: "unchanged",
      schemaVersion: 4,
    });
  });

  it("reports a cold catalog as unavailable until v4 is accepted", async () => {
    serveObjects(new Map());
    expect((await sync()).body).toMatchObject({
      outcome: "rejected",
      schemaVersion: 4,
      state: "never-synced",
      active: null,
      lastAttempt: { failureCode: "source-unavailable" },
    });

    const unavailable = await accept(
      catalogClient().list({ headers: sessionHeaders }),
      [503],
    );
    expect(unavailable.body.error.code).toBe("PROVIDER_UNAVAILABLE");

    serveObjects(release({}).objects);
    expect((await sync()).body.outcome).toBe("accepted");
    expect((await publicCatalog()).body.connectors).toMatchObject([
      { label: "HTTP" },
    ]);
  });

  it("retains the last accepted v4 snapshot when a later candidate has an invalid protocol", async () => {
    const accepted = release({ label: "Last accepted" });
    serveObjects(accepted.objects);
    await sync();
    const invalid = release({
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

  it("rejects a pointer outside the canonical v4 release namespace", async () => {
    const candidate = release({});
    const objects = new Map(candidate.objects);
    objects.set(
      "connectors/v4/active.json",
      bytes({
        ...candidate.pointer,
        catalogKey: `connectors/v3/releases/${CATALOG_VERSION}/catalog.json`,
      }),
    );
    serveObjects(objects);

    expect((await sync()).body).toMatchObject({
      outcome: "rejected",
      schemaVersion: 4,
      active: null,
      lastAttempt: { failureCode: "invalid-pointer" },
    });
  });

  it("rejects changed bytes under the accepted digest without replacing the accepted projection", async () => {
    const accepted = release({ label: "Verified bytes" });
    serveObjects(accepted.objects);
    await sync();
    const changed = release({ label: "Unverified bytes" });
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
    expect((await sync()).body).toMatchObject({
      outcome: "rejected",
      active: { catalogDigest: accepted.pointer.catalogDigest },
      lastAttempt: { failureCode: "digest-mismatch" },
    });
    expect((await publicCatalog()).body.connectors).toMatchObject([
      { label: "Verified bytes" },
    ]);
  });

  it("uses explicit protocol metadata for crossed-name connectors and needs no MCP skill resources", async () => {
    const candidate = release({
      httpSlug: "http-service-mcp",
      mcpSlug: "spoken-notes",
    });
    // Storage contains only the pointer and catalog. Both descriptors declare
    // skill:none, so accepting this release requires no skill resource fetch.
    serveObjects(candidate.objects);
    expect((await sync()).body).toMatchObject({
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
    expect((await publicCatalog()).body.connectors).toMatchObject([
      { slug: "http-service-mcp", authMethods: [{ grantKind: "manual" }] },
    ]);
  });

  it("does not expose an accepted MCP transport as an executable HTTP permission bundle", async () => {
    serveObjects(release({}).objects);
    await sync();
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
