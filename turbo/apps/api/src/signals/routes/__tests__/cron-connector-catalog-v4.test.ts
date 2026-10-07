import { createHash, randomUUID } from "node:crypto";

import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import {
  builtinConnectorAutomaticContract,
  builtinConnectorNoAuthGrantContract,
} from "@okouai/api-contracts/contracts/connectors";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { cronConnectorCatalogContract } from "@okouai/api-contracts/contracts/cron";
import { customConnectorsContract } from "@okouai/api-contracts/contracts/custom-connectors";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { connectorCatalogRoutes } from "../connector-catalog";
import { builtinConnectorsAutomaticRoutes } from "../connectors-automatic";
import { builtinConnectorsRoutes } from "../connectors";
import { cronConnectorCatalogRoutes } from "../cron-connector-catalog";
import { customConnectorsRoutes } from "../custom-connectors";
import { featureSwitchesRoutes } from "../feature-switches";
import { createBddApi } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  manualHttpCustomConnectorCreateBody,
  mockAutomaticMcpOAuthProvider,
} from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";
import { settle } from "../../utils";

const context = testContext();
const mocks = createRouteMocks(context);
const bdd = createBddApi(context);
const connectorsApi = createConnectorBddApi(context);
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

function mcpConnector(slug = "plaud-mcp") {
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

function runtimeBuiltinConnector(
  protocol: "http" | "mcp",
  authKind: "none" | "manual" | "automatic",
  endpoint: string,
  updated = false,
) {
  const connector = mcpConnector("catalog-mcp");
  const { mcp, ...baseConnector } = connector;
  return {
    ...baseConnector,
    ...(protocol === "mcp" ? { mcp: { ...mcp, endpoint } } : {}),
    authMethods:
      authKind === "automatic"
        ? connector.authMethods
        : authKind === "manual"
          ? httpConnector("catalog-mcp", "Notes").authMethods
          : [
              {
                id: "public",
                label: "Connect",
                description: null,
                visible: true,
                storage: { version: 1, secrets: [], variables: [] },
                grant: { kind: "none" },
                access: { kind: "none" },
                revoke: { kind: "none" },
              },
            ],
    firewall: {
      ...connector.firewall,
      config: {
        description: "Notes",
        apis: [
          {
            base: endpoint,
            auth:
              authKind === "manual"
                ? {
                    headers: {
                      [updated ? "X-Api-Key" : "Authorization"]:
                        `Bearer \${{ secrets.FIXTURE_TOKEN }}`,
                    },
                  }
                : {},
            permissions: [],
          },
        ],
      },
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
    catalogBytes,
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

beforeEach(() => {
  mockEnv("CRON_SECRET", CRON_SECRET);
  mockEnv("R2_USER_STORAGES_BUCKET_NAME", `catalog-v4-${randomUUID()}`);
  mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
});

describe("connector catalog v4 preparation", () => {
  it.each([
    ["mcp", "none"],
    ["mcp", "manual"],
    ["mcp", "automatic"],
    ["http", "manual"],
  ] as const)(
    "refreshes a running %s %s builtin when its catalog configuration changes, disappears, or is restored",
    async (protocol, authKind) => {
      const endpoint = "https://automatic-mcp.example.test/server";
      const initial = release({
        mutate(catalog) {
          catalog.connectors = [
            runtimeBuiltinConnector(protocol, authKind, endpoint),
          ];
        },
      });
      serveObjects(initial.objects);
      expect((await sync()).body.outcome).toBe("accepted");
      const runs = createRunsApi(context);
      const actor = bdd.user();
      bdd.acceptAgentStorageWrites();
      runs.acceptStorageDownloads();
      runs.acceptTelemetryIngest();
      const runnerGroup = runs.configureRunnerGroup();
      await runs.grantProEntitlement(actor);
      await runs.ensurePersonalSubscriptionModel(actor);
      const agent = await bdd.createAgent(actor, {
        displayName: "Builtin catalog changes",
        visibility: "private",
      });
      const created: { runId?: string; connectionId?: string } = {};
      const outcome = await settle(
        (async () => {
          const request = {
            headers: sessionHeaders,
            params: { connectorSlug: "catalog-mcp" },
            body: {
              agentId: agent.agentId,
              account: { intent: "add" as const },
            },
          };
          if (authKind === "manual") {
            const connected = await connectorsApi.connectManualGrant(
              actor,
              "catalog-mcp",
              "api-token",
              { credential: "catalog-api-token" },
              agent.agentId,
            );
            created.connectionId = connected.id;
          } else if (authKind === "none") {
            const connected = await accept(
              setupApp({ context, routes: builtinConnectorsRoutes })(
                builtinConnectorNoAuthGrantContract,
              ).connect({
                ...request,
                body: { ...request.body, authMethod: "public" },
              }),
              [200],
            );
            created.connectionId = connected.body.id;
          } else {
            mockAutomaticMcpOAuthProvider(context, {
              registration: "none",
              authentication: "none",
            });
            const connected = await accept(
              setupApp({ context, routes: builtinConnectorsAutomaticRoutes })(
                builtinConnectorAutomaticContract,
              ).start({
                ...request,
                body: { ...request.body, authMethod: "automatic" },
              }),
              [200],
            );
            if (connected.body.result !== "connected") {
              throw new Error("Expected accepted no-auth Automatic connection");
            }
            created.connectionId = connected.body.connectedAccountId;
          }
          const run = await runs.createThreadRun(actor, {
            agentId: agent.agentId,
            prompt: "Use the selected builtin MCP account",
          });
          created.runId = run.runId;
          await runs.heartbeatRunner(runnerGroup);
          const claim = await runs.claimRunnerJob(run.runId);
          const target = {
            kind: "builtin" as const,
            connectorSlug: "catalog-mcp",
          };
          const registration = claim.connectorRuntimeTargets.find((entry) => {
            return (
              entry.kind === "builtin" &&
              entry.connectorSlug === target.connectorSlug
            );
          });
          if (!registration) {
            throw new Error("Expected the claimed builtin MCP runtime");
          }
          const [initialRuntime] = await runs.syncConnectorRuntime(run.runId, {
            targets: [registration],
          });
          expect(initialRuntime).toMatchObject({ state: "available" });

          for (const change of ["updated", "removed", "restored"] as const) {
            const nextEndpoint = "https://updated.example.test/mcp";
            serveObjects(
              release({
                version: `${CATALOG_VERSION}.${change}`,
                mutate(catalog) {
                  catalog.connectors =
                    change === "removed"
                      ? [
                          httpConnector(
                            "unrelated-service",
                            "Unrelated service",
                          ),
                        ]
                      : [
                          runtimeBuiltinConnector(
                            protocol,
                            authKind,
                            change === "updated" ? nextEndpoint : endpoint,
                            change === "updated",
                          ),
                        ];
                },
              }).objects,
            );
            context.mocks.ably.batchPublish.mockClear();
            expect((await sync()).body.outcome).toBe("accepted");
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
            const [updated] = await runs.syncConnectorRuntime(run.runId, {
              targets: [registration],
            });
            expect(updated).toMatchObject(
              change === "removed"
                ? {
                    target,
                    state: "unresolved",
                    reason: "connector-unavailable",
                  }
                : {
                    target,
                    state: "available",
                  },
            );
          }
        })(),
      );
      // Restore the authored method before deleting its test-owned account.
      serveObjects(
        release({
          version: `${CATALOG_VERSION}.cleanup`,
          mutate(catalog) {
            catalog.connectors = [
              runtimeBuiltinConnector(protocol, authKind, endpoint),
            ];
          },
        }).objects,
      );
      await sync();
      context.mocks.s3.send.mockResolvedValue({ Contents: [] });
      if (created.runId) {
        await runs.requestCancelRun(actor, created.runId, [200, 404]);
      }
      if (created.connectionId) {
        await connectorsApi.deleteBuiltinConnectorAccount(
          actor,
          "catalog-mcp",
          created.connectionId,
        );
      }
      await bdd.deleteAgent(actor, agent.agentId);
      if (!outcome.ok) {
        throw outcome.error;
      }
    },
  );

  it("serves v4 HTTP and generic Automatic MCP methods through normal sync", async () => {
    const candidate = release({ label: "Accepted v4", mcpSlug: "notes-mcp" });
    serveObjects(candidate.objects);
    expect((await sync()).body).toMatchObject({
      outcome: "accepted",
      schemaVersion: 4,
      state: "current",
      active: { catalogDigest: candidate.pointer.catalogDigest },
      filtering: {
        stale: false,
        filteredAuthMethods: [],
      },
    });
    expect((await publicCatalog()).body.connectors).toMatchObject([
      { slug: "catalog-service", label: "Accepted v4" },
      { slug: "notes-mcp", authMethods: [{ grantKind: "automatic" }] },
    ]);
    expect((await sync()).body).toMatchObject({
      outcome: "unchanged",
      schemaVersion: 4,
    });
  });

  it.each([
    ["Plaud", "plaud-mcp", FeatureSwitchKey.PlaudConnector],
    ["Monday.com", "monday-mcp", FeatureSwitchKey.MondayConnector],
  ] as const)(
    "uses the %s auth-method switch for discovery while accepting its catalog",
    async (_label, connectorSlug, featureSwitch) => {
      serveObjects(release({ mcpSlug: connectorSlug }).objects);
      expect((await sync()).body).toMatchObject({
        outcome: "accepted",
        filtering: { filteredAuthMethods: [] },
      });
      expect(
        (await publicCatalog()).body.connectors.map((connector) => {
          return connector.slug;
        }),
      ).toStrictEqual(["catalog-service"]);
      const features = setupApp({ context, routes: featureSwitchesRoutes })(
        featureSwitchesContract,
      );
      await accept(
        features.update({
          headers: sessionHeaders,
          body: { switches: { [featureSwitch]: true } },
        }),
        [200],
      );
      expect((await publicCatalog()).body.connectors).toMatchObject([
        { slug: "catalog-service" },
        {
          slug: connectorSlug,
          authMethods: [{ id: "automatic", grantKind: "automatic" }],
        },
      ]);
      await accept(
        features.update({
          headers: sessionHeaders,
          body: { switches: { [featureSwitch]: false } },
        }),
        [200],
      );
      expect(
        (await publicCatalog()).body.connectors.map((connector) => {
          return connector.slug;
        }),
      ).toStrictEqual(["catalog-service"]);
    },
  );

  it("reports strict storage readiness through staff diagnostics around a rejected-source sync", async () => {
    const features = setupApp({ context, routes: featureSwitchesRoutes })(
      featureSwitchesContract,
    );
    await accept(
      features.update({
        headers: sessionHeaders,
        body: { switches: { [FeatureSwitchKey.OkouDebug]: true } },
      }),
      [200],
    );
    const healthy = {
      missingConnectorVersions: 0,
      unownedConnectorSecrets: 0,
      unownedConnectorVariables: 0,
      unresolvedBridgeCredentials: 0,
    };
    context.mocks.s3.send.mockClear();
    const before = await accept(
      catalogClient().diagnostics({ headers: sessionHeaders }),
      [200],
    );
    expect(before.body.credentialStorage).toStrictEqual(healthy);
    expect(context.mocks.s3.send).not.toHaveBeenCalled();

    serveObjects(new Map());
    const rejected = await sync();
    expect(rejected.body).toMatchObject({
      outcome: "rejected",
      failureCode: "source-unavailable",
    });
    expect(rejected.body.credentialStorage).toStrictEqual(healthy);
    context.mocks.s3.send.mockClear();
    const after = await accept(
      catalogClient().diagnostics({ headers: sessionHeaders }),
      [200],
    );
    expect(after.body.credentialStorage).toStrictEqual(healthy);
    expect(after.body).not.toHaveProperty("sourceId");
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
  });

  it("keeps staff and cron storage readiness healthy across owned secret and variable account creation and deletion", async () => {
    const actor = bdd.user();
    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const features = setupApp({ context, routes: featureSwitchesRoutes })(
      featureSwitchesContract,
    );
    await accept(
      features.update({
        headers: sessionHeaders,
        body: { switches: { [FeatureSwitchKey.OkouDebug]: true } },
      }),
      [200],
    );
    const slug = `readiness-${randomUUID()}`;
    const descriptor = httpConnector(slug, "Owned credentials");
    const candidate = release({
      mutate(catalog) {
        catalog.connectors = [
          {
            ...descriptor,
            authMethods: descriptor.authMethods.map((method) => {
              return {
                ...method,
                storage: { ...method.storage, variables: ["FIXTURE_REGION"] },
                grant: {
                  ...method.grant,
                  fields: [
                    ...method.grant.fields,
                    {
                      privateName: "FIXTURE_REGION",
                      publicId: "region",
                      label: "Region",
                      required: true,
                      placeholder: null,
                      storage: "variable",
                    },
                  ],
                },
                access: {
                  ...method.access,
                  envBindings: {
                    ...method.access.envBindings,
                    FIXTURE_REGION: "$vars.FIXTURE_REGION",
                  },
                },
              };
            }),
          },
        ];
      },
    });
    serveObjects(candidate.objects);
    const healthy = {
      missingConnectorVersions: 0,
      unownedConnectorSecrets: 0,
      unownedConnectorVariables: 0,
      unresolvedBridgeCredentials: 0,
    };
    const accepted = await sync();
    expect(accepted.body.outcome).toBe("accepted");
    expect(accepted.body.credentialStorage).toStrictEqual(healthy);
    const connected = await connectorsApi.connectManualGrant(
      actor,
      slug,
      "api-token",
      { credential: "readiness-token", region: "readiness-region" },
    );
    const outcome = await settle(
      (async () => {
        await expect(
          connectorsApi.listBuiltinConnectorAccounts(actor, slug),
        ).resolves.toContainEqual(
          expect.objectContaining({ id: connected.id }),
        );
        context.mocks.s3.send.mockClear();
        const staff = await accept(
          catalogClient().diagnostics({ headers: sessionHeaders }),
          [200],
        );
        expect(staff.body.credentialStorage).toStrictEqual(healthy);
        expect(JSON.stringify(staff.body)).not.toContain("readiness-token");
        expect(JSON.stringify(staff.body)).not.toContain("readiness-region");
        expect(context.mocks.s3.send).not.toHaveBeenCalled();
        expect((await sync()).body.credentialStorage).toStrictEqual(healthy);
      })(),
    );
    await connectorsApi.deleteBuiltinConnectorAccount(
      actor,
      slug,
      connected.id,
    );
    if (!outcome.ok) {
      throw outcome.error;
    }
    await expect(
      connectorsApi.listBuiltinConnectorAccounts(actor, slug),
    ).resolves.toStrictEqual([]);
    const removed = await accept(
      catalogClient().diagnostics({ headers: sessionHeaders }),
      [200],
    );
    expect(removed.body.credentialStorage).toStrictEqual(healthy);
    expect((await sync()).body.credentialStorage).toStrictEqual(healthy);
  });

  it("keeps staff diagnostics on the current pointer across a rejected sync", async () => {
    const features = setupApp({ context, routes: featureSwitchesRoutes })(
      featureSwitchesContract,
    );
    await accept(
      features.update({
        headers: sessionHeaders,
        body: { switches: { [FeatureSwitchKey.OkouDebug]: true } },
      }),
      [200],
    );
    const before = await accept(
      catalogClient().diagnostics({ headers: sessionHeaders }),
      [200],
    );
    expect(before.body.schemaVersion).toBe(4);
    expect(before.body).not.toHaveProperty("lastAttempt");

    serveObjects(new Map());
    const rejected = await sync();
    // The rejected attempt reports the retained pointer as stale; without a
    // pointer there is nothing to retain.
    expect(rejected.body).toMatchObject({
      outcome: "rejected",
      failureCode: "source-unavailable",
      state: before.body.pointer === null ? "never-synced" : "stale",
      active: before.body.active,
    });
    expect(rejected.body.pointer).toStrictEqual(before.body.pointer);
    context.mocks.s3.send.mockClear();
    const after = await accept(
      catalogClient().diagnostics({ headers: sessionHeaders }),
      [200],
    );
    expect(after.body).toStrictEqual({
      ...before.body,
      filtering: {
        ...before.body.filtering,
        evaluatedAt: after.body.filtering.evaluatedAt,
      },
    });
    expect(after.body).not.toHaveProperty("sourceId");
    expect(after.body).not.toHaveProperty("catalog");
    expect(after.body).not.toHaveProperty("lastAttempt");
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
  });

  it("evaluates staff filtering on demand for the current capability and accepted v4 catalog identity", async () => {
    const features = setupApp({ context, routes: featureSwitchesRoutes })(
      featureSwitchesContract,
    );
    await accept(
      features.update({
        headers: sessionHeaders,
        body: { switches: { [FeatureSwitchKey.OkouDebug]: true } },
      }),
      [200],
    );
    mockOptionalEnv("GOOGLE_OAUTH_CLIENT_ID", undefined);
    const initial = release({ mcpSlug: "notes-mcp" });
    serveObjects(initial.objects);
    const accepted = await sync();
    expect(accepted.body).toMatchObject({
      outcome: "accepted",
      active: {
        catalogVersion: initial.pointer.catalogDigest,
        catalogDigest: initial.pointer.catalogDigest,
      },
      pointer: { hash: initial.pointer.catalogDigest },
      filtering: { stale: false, filteredAuthMethods: [] },
    });
    expect(accepted.body.filtering.evaluatedAt).not.toBeNull();
    context.mocks.s3.send.mockClear();
    const original = await accept(
      catalogClient().diagnostics({ headers: sessionHeaders }),
      [200],
    );
    expect(original.body.filtering).toStrictEqual({
      ...accepted.body.filtering,
      evaluatedAt: expect.any(String),
    });

    // A capability change is visible on the next read, without a sync.
    mockOptionalEnv("GOOGLE_OAUTH_CLIENT_ID", "catalog-capability-client-id");
    const configured = await accept(
      catalogClient().diagnostics({ headers: sessionHeaders }),
      [200],
    );
    expect(configured.body.filtering).toMatchObject({
      capabilityDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      stale: false,
      filteredAuthMethods: [],
    });
    expect(configured.body.filtering.evaluatedAt).not.toBeNull();
    expect(configured.body.filtering.capabilityDigest).not.toBe(
      original.body.filtering.capabilityDigest,
    );
    expect(configured.body.active).toStrictEqual(original.body.active);
    expect(context.mocks.s3.send).not.toHaveBeenCalled();

    mockOptionalEnv("GOOGLE_OAUTH_CLIENT_ID", undefined);
    const restored = await accept(
      catalogClient().diagnostics({ headers: sessionHeaders }),
      [200],
    );
    expect(restored.body.filtering).toStrictEqual({
      ...original.body.filtering,
      evaluatedAt: expect.any(String),
    });

    mockOptionalEnv("GOOGLE_OAUTH_CLIENT_ID", "catalog-capability-client-id");
    const replacement = release({
      version: `${CATALOG_VERSION}.capability-next`,
      label: "Replacement v4",
      mcpSlug: "notes-mcp",
    });
    serveObjects(replacement.objects);
    const replaced = await sync();
    expect(replaced.body).toMatchObject({
      outcome: "accepted",
      active: {
        catalogVersion: replacement.pointer.catalogDigest,
        catalogDigest: replacement.pointer.catalogDigest,
      },
      pointer: { hash: replacement.pointer.catalogDigest },
      filtering: {
        capabilityDigest: configured.body.filtering.capabilityDigest,
        stale: false,
        filteredAuthMethods: [],
      },
    });
    mockOptionalEnv("GOOGLE_OAUTH_CLIENT_ID", undefined);
    context.mocks.s3.send.mockClear();
    const current = await accept(
      catalogClient().diagnostics({ headers: sessionHeaders }),
      [200],
    );
    expect(current.body.active).toStrictEqual({
      catalogVersion: replacement.pointer.catalogDigest,
      catalogDigest: replacement.pointer.catalogDigest,
    });
    expect(current.body.pointer).toStrictEqual(replaced.body.pointer);
    expect(current.body.filtering).toStrictEqual({
      ...original.body.filtering,
      evaluatedAt: expect.any(String),
    });
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
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
      failureCode: "invalid-artifact",
      state: "stale",
      active: { catalogDigest: accepted.pointer.catalogDigest },
      pointer: { hash: accepted.pointer.catalogDigest },
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

    const rejected = await sync();
    expect(rejected.body).toMatchObject({
      outcome: "rejected",
      failureCode: "invalid-pointer",
      schemaVersion: 4,
    });
    expect(rejected.body.pointer?.hash).not.toBe(
      candidate.pointer.catalogDigest,
    );
  });

  it("treats a pointer to the serving digest as unchanged without downloading its catalog", async () => {
    const accepted = release({ label: "Verified bytes" });
    serveObjects(accepted.objects);
    expect((await sync()).body.outcome).toBe("accepted");
    const changed = release({ label: "Unverified bytes" });
    // A new publication label and key whose declared digest is the serving
    // hash. The pointer only references validated complete generations, so
    // the writer trusts the digest and never reads the changed bytes.
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
    context.mocks.s3.send.mockClear();
    expect((await sync()).body).toMatchObject({
      outcome: "unchanged",
      failureCode: null,
      state: "current",
      active: { catalogDigest: accepted.pointer.catalogDigest },
      pointer: { hash: accepted.pointer.catalogDigest },
    });
    expect(
      context.mocks.s3.send.mock.calls.map(([command]) => {
        return requestedKey(command);
      }),
    ).toStrictEqual(["connectors/v4/active.json"]);
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
        filteredAuthMethods: [],
      },
    });
    expect((await publicCatalog()).body.connectors).toMatchObject([
      { slug: "http-service-mcp", authMethods: [{ grantKind: "manual" }] },
      { slug: "spoken-notes", authMethods: [{ grantKind: "automatic" }] },
    ]);
  });

  it("does not expose an accepted MCP transport as an executable HTTP permission bundle", async () => {
    serveObjects(release({ mcpSlug: "notes-mcp" }).objects);
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
