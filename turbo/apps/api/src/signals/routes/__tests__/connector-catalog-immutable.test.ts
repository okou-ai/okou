/* eslint-disable no-restricted-imports, api/no-package-variable, api/no-test-vi-mocks -- Only this N lifecycle process binds the existing DB module to per-case real PGlite; all ordinary suites retain node-postgres (target-state v5). */
/* oxlint-disable vitest/warn-todo -- N1 belongs to the later publisher pointer stage. */
import { syncBuiltinESMExports } from "node:module";
import { createApiTestKmsClient } from "../../../__tests__/secret-kms";
import { withSecretKmsClientForTest } from "../../../lib/secret-kms-client";
import { HttpResponse, http } from "msw";
import { server } from "../../../mocks/server";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import {
  customConnectorByIdContract,
  customConnectorsContract,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { connectorAccountRoutes } from "../connector-accounts";
import { customConnectorsRoutes } from "../custom-connectors";
import { customConnectorsDeleteRoutes } from "../custom-connectors-delete";
import { customConnectorsValuesSetRoutes } from "../custom-connectors-values-set";
import { createBddApi } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockGitHubConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import {
  catalogWithAuthMethod,
  catalogWithManualConnector,
  createPublicConnectorCatalog,
} from "./helpers/public-connector-catalog";
import { readFile, readdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mcpConnectorsContract } from "@okouai/api-contracts/contracts/mcp-connectors";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { mcpConnectorsRoutes } from "../mcp-connectors";
import { immutableConnectorRuntimeSelection } from "../../services/connector-catalog-entries.service";
import {
  builtinConnectorsSearchContract,
  builtinConnectorManualGrantContract,
} from "@okouai/api-contracts/contracts/connectors";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { connectorOverviewContract } from "@okouai/api-contracts/contracts/connector-overview";
import {
  onboardingSourcesContract,
  onboardingWorkflowConnectorsContract,
} from "@okouai/api-contracts/contracts/onboarding";
import { connectorCatalogRoutes } from "../connector-catalog";
import { connectorOverviewRoutes } from "../connector-overview";
import { onboardingSourcesRoutes } from "../onboarding-sources";
import { onboardingWorkflowConnectorsRoutes } from "../onboarding-workflow-connectors";
import { SYSTEM_ORG_ID, VOLUME_ORG_USER_ID } from "@okouai/core/storage-names";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { btree_gin } from "@electric-sql/pglite/contrib/btree_gin";
import { drizzle } from "drizzle-orm/pglite";
import {
  afterAll,
  afterEach,
  aroundEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { cronConnectorCatalogContract } from "@okouai/api-contracts/contracts/cron";
import {
  runnersJobClaimContract,
  storedExecutionContextSchema,
} from "@okouai/api-contracts/contracts/runners";
import { runnersRoutes } from "../runners";
import { OFFICIAL_RUNNER_TOKEN_PREFIX } from "@okouai/api-contracts/contracts/runner-primitives";
import { connectorCatalogExecutableCapabilityDigest } from "../../services/connector-catalog-compatibility.service";
import { connectorCatalogSource } from "../../services/connector-catalog-source";
import { currentConnectorCatalogValidatorIdentity } from "../../services/connector-catalog-validator-authority";
import {
  connectorCatalogArtifactSchema,
  CONNECTOR_CATALOG_ACTIVE_KEY,
} from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import { API_TEST_CONNECTOR_CATALOG_ARTIFACT } from "../../../test-fixtures/connector-catalog-artifact";
import { getApiTestMocks, resetApiTestMocks } from "../../../__tests__/mocks";
import { setupApp } from "../../../__tests__/test-helpers";
import { accept, testContext } from "../../../__tests__/test-context";
import { clearMockedEnv, mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { cronConnectorCatalogRoutes } from "../cron-connector-catalog";
import { flushWaitUntilForTest, waitUntil } from "../../context/wait-until";
import { db$, writeDb$ } from "../../external/db";
import type {
  ClerkOrganizationMembership,
  ClerkPaginated,
} from "../../external/clerk";
import { createStore } from "ccstate";
import { createDeferredPromise, settle } from "../../utils";
import { builtinConnectorsRoutes } from "../connectors";
import { createRouteMocks, createFixtureTracker } from "./helpers/route-test";
import { createExecutionStorageObjects } from "../../services/execution-storage.service";
import {
  API_TEST_CONNECTOR_CATALOG,
  mockApiTestConnectorProviderConfiguration,
} from "../../../test-fixtures/connector-catalog";

const binding = vi.hoisted(() => {
  return {
    database: undefined as ReturnType<typeof drizzle> | undefined,
  };
});
vi.mock("../../../lib/db", () => {
  return {
    db: () => {
      if (!binding.database) {
        throw new Error("Lifecycle DB is not bound");
      }
      return binding.database;
    },
    closeDbPool: () => {
      return Promise.resolve();
    },
  };
});
let engine: PGlite | undefined;
let statements: string[] = [];
interface EngineTrace {
  readonly name: string;
  readonly engine: PGlite;
  readonly signal: AbortSignal;
  readonly events: string[];
  setupFailureObserved: boolean;
}
const engineTraces: EngineTrace[] = [];
let caseTrace: EngineTrace | undefined;

// Register FIRST: locked Vitest's stack order runs this AFTER testContext's
// owner abort/shared detached cleanup. Never flush abort-dependent work first.
afterEach(async () => {
  const ownedEngine = engine;
  const trace = caseTrace;
  const drained = await settle(
    (async () => {
      const beforeFlush = [...(trace?.events ?? [])];
      await flushWaitUntilForTest();
      trace?.events.push("waitUntil-drained");
      // Diagnostics must not skip drainage if their own assertion fails.
      if (trace) {
        assert.equal(trace.signal.aborted, true);
        assert.deepEqual(beforeFlush, ["owner-aborted", "native-drained"]);
      }
    })(),
  );
  binding.database = undefined;
  const released = await settle(ownedEngine?.close() ?? Promise.resolve());
  if (released.ok) {
    trace?.events.push("closed");
  }
  engine = undefined;
  caseTrace = undefined;
  clearMockedEnv();
  resetApiTestMocks();
  server.resetHandlers();
  if (!drained.ok) {
    throw drained.error;
  }
  if (!released.ok) {
    throw released.error;
  }
});
const context = testContext();
const routeMocks = createRouteMocks(context);

const migrationDir = new URL(
  "../../../../../../packages/db/src/migrations/",
  import.meta.url,
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  syncBuiltinESMExports();
});

aroundEach(async (runTest) => {
  await withSecretKmsClientForTest(createApiTestKmsClient(), runTest);
});

beforeEach(async () => {
  resetApiTestMocks();
  mockEnv("SECRETS_KMS_KEY_ID", "alias/okou-secrets-test");
  engine = new PGlite({ extensions: { pgcrypto, btree_gin } });
  const ownedEngine = engine;
  const signal = context.signal;
  const trace: EngineTrace = {
    name: expect.getState().currentTestName ?? "Missing test name",
    engine: ownedEngine,
    signal,
    events: [],
    setupFailureObserved: false,
  };
  caseTrace = trace;
  engineTraces.push(trace);
  const aborted = createDeferredPromise<void>(signal);
  // Existing shared trackers own real work that cannot finish until abort.
  // Native SQL must finish while this case's engine is still alive.
  waitUntil(
    aborted.promise.then(
      () => {
        throw new Error("Cleanup probe unexpectedly resolved before abort");
      },
      async (error: unknown) => {
        assert.equal(signal.aborted, true);
        assert.equal(error, signal.reason);
        trace.events.push("owner-aborted");
        assert.deepEqual((await ownedEngine.query("SELECT 1 AS alive")).rows, [
          { alive: 1 },
        ]);
        trace.events.push("native-drained");
      },
    ),
  );
  if (trace.name.endsWith("engine closes after initial SQL failure")) {
    const failure = await settle(
      ownedEngine.exec("CREATE TABLE invalid_initial_sql ("),
    );
    if (!failure.ok) {
      trace.setupFailureObserved = true;
      throw failure.error;
    }
    throw new Error("The invalid initial SQL unexpectedly succeeded");
  }
  const files = (await readdir(migrationDir))
    .filter((name) => {
      return /^\d+.*\.sql$/.test(name);
    })
    .sort();
  const journal = JSON.parse(
    await readFile(new URL("meta/_journal.json", migrationDir), "utf8"),
  ) as { entries: { tag: string; when: number }[] };
  await engine.exec(
    "CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)",
  );
  for (const name of files) {
    let sql = await readFile(new URL(name, migrationDir), "utf8");
    // The baseline declares vector but has no vector columns or indexes. The
    // unused extension declaration is the only omitted baseline statement;
    // all table, index, FK and CHECK DDL and subsequent migrations run intact.
    if (name === "1078_baseline.sql") {
      sql = sql
        .replace(
          "CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;",
          "",
        )
        .replace(
          "COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';",
          "",
        );
    }
    // pgstattuple is metadata inspection only (1178), absent in PGlite; no
    // table/index/constraint or lifecycle operation depends on that extension.
    sql = sql.replace(
      "CREATE EXTENSION IF NOT EXISTS pgstattuple WITH SCHEMA public;",
      "",
    );
    if (sql.includes("-- vm0:non-transactional")) {
      for (const statement of sql.split("--> statement-breakpoint")) {
        await engine.exec(statement);
      }
    } else if (/\b(?:CREATE|DROP) (?:UNIQUE )?INDEX CONCURRENTLY\b/.test(sql)) {
      if (sql.includes("$$")) {
        throw new Error(
          "Concurrent migration requires SQL-aware statement boundaries",
        );
      }
      for (const statement of sql.split(";")) {
        if (statement.trim()) {
          await engine.exec(statement);
        }
      }
    } else {
      const migration = await settle(engine.exec(sql));
      if (!migration.ok) {
        throw new Error(`Lifecycle migration failed: ${name}`, {
          cause: migration.error,
        });
      }
    }
    const metadata = journal.entries.find((entry) => {
      return `${entry.tag}.sql` === name;
    });
    if (!metadata) {
      throw new Error(`Missing migration journal entry: ${name}`);
    }
    await engine.query(
      "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
      [
        createHash("sha256")
          .update(await readFile(new URL(name, migrationDir)))
          .digest("hex"),
        metadata.when,
      ],
    );
  }
  await engine.exec("SET search_path TO public");
  statements = [];
  binding.database = drizzle(engine, {
    logger: {
      logQuery(query) {
        statements.push(query);
      },
    },
  });
  mockApiTestConnectorProviderConfiguration();
});

afterAll(() => {
  server.close();
  syncBuiltinESMExports();
  for (const trace of engineTraces) {
    assert.deepEqual(trace.events, [
      "owner-aborted",
      "native-drained",
      "waitUntil-drained",
      "closed",
    ]);
    assert.equal(trace.engine.closed, true);
  }
  const failedSetup = engineTraces.find((trace) => {
    return trace.name.endsWith("engine closes after initial SQL failure");
  });
  if (failedSetup) {
    assert.equal(failedSetup.setupFailureObserved, true);
  }
});

function release(
  version: string,
  label: string,
  runtimeChange = false,
  entrySlug?: string,
  skillMetadataChange = false,
) {
  const artifact = connectorCatalogArtifactSchema.parse(
    structuredClone(API_TEST_CONNECTOR_CATALOG_ARTIFACT),
  );
  artifact.catalogVersion = version;
  if (skillMetadataChange) {
    for (const entry of artifact.connectors) {
      if (entry.skill.kind === "bundled") {
        entry.skill.size += 1;
        entry.skill.archiveSize += 1;
        entry.skill.fileCount += 1;
      }
    }
  }
  const first =
    entrySlug === undefined
      ? artifact.connectors[0]
      : artifact.connectors.find((entry) => {
          return entry.slug === entrySlug;
        });
  if (!first) {
    throw new Error("Missing fixed catalog connector");
  }
  first.label = label;
  const method = first.authMethods[0];
  if (!method) {
    throw new Error("Missing runtime method");
  }
  if (runtimeChange) {
    method.label = label;
  }
  const raw = Buffer.from(JSON.stringify(artifact));
  const hash = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
  const key = `connectors/v4/releases/${version}/catalog.json`;
  const pointer = Buffer.from(
    JSON.stringify({
      catalogVersion: version,
      catalogKey: key,
      catalogDigest: hash,
    }),
  );
  return { artifact, raw, hash, key, pointer };
}

function serve(candidate: ReturnType<typeof release>) {
  getApiTestMocks().s3.send.mockImplementation((command: unknown) => {
    const input = (command as { input: { Key?: string } }).input;
    const bytes =
      input.Key === CONNECTOR_CATALOG_ACTIVE_KEY
        ? candidate.pointer
        : input.Key === candidate.key
          ? candidate.raw
          : undefined;
    if (!bytes) {
      throw new Error("Uncontrolled lifecycle R2 key");
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

async function directory(candidate: ReturnType<typeof release>) {
  routeMocks.clerk.session("catalog-lifecycle-user", "catalog-lifecycle-org");
  const first = candidate.artifact.connectors[0];
  if (!first) {
    throw new Error("Missing fixed catalog connector");
  }
  const response = await setupApp({ context, routes: builtinConnectorsRoutes })(
    builtinConnectorsSearchContract,
  ).search({
    headers: { authorization: "Bearer clerk-session" },
    query: { keyword: first.slug },
  });
  expect(response.status).toBe(200);
  if (response.status !== 200) {
    throw new Error("Catalog search failed");
  }
  expect(
    response.body.connectors.find((entry) => {
      return entry.slug === first.slug;
    })?.label,
  ).toBe(first.label);
}

async function sync() {
  return await setupApp({ context, routes: cronConnectorCatalogRoutes })(
    cronConnectorCatalogContract,
  ).sync({ headers: { authorization: "Bearer test-cron-secret" } });
}

// Only this per-case engine can construct missing immutable rows/captured
// generations. Exercise the real authenticated MCP consumer, not a test route.
async function ownedMcpRun(candidate: ReturnType<typeof release>) {
  if (!engine) {
    throw new Error("Missing case engine");
  }
  const connector = candidate.artifact.connectors[0];
  const method = connector?.authMethods[0];
  if (!connector?.mcp || !method) {
    throw new Error("Missing fixed MCP connector");
  }
  const userId = `catalog-user-${randomUUID()}`;
  const orgId = `catalog-org-${randomUUID()}`;
  const agentId = randomUUID();
  const sessionId = randomUUID();
  const runId = randomUUID();
  const connectionId = randomUUID();
  await engine.query(
    "INSERT INTO agents (id, org_id, owner, name) VALUES ($1, $2, $3, 'catalog-mcp')",
    [agentId, orgId, userId],
  );
  await engine.query(
    "INSERT INTO agent_sessions (id, user_id, org_id, agent_id) VALUES ($1, $2, $3, $4)",
    [sessionId, userId, orgId, agentId],
  );
  await engine.query(
    "INSERT INTO agent_runs (id, status, prompt, user_id, org_id, runner_group, session_id) VALUES ($1, 'running', 'catalog lifecycle', $2, $3, 'catalog-n4', $4)",
    [runId, userId, orgId, sessionId],
  );
  await engine.query(
    "INSERT INTO connectors (id, auth_method, user_id, org_id, storage_version, connector_slug) VALUES ($1, $2, $3, $4, 1, $5)",
    [connectionId, method.id, userId, orgId, connector.slug],
  );
  return { userId, orgId, runId, connectionId, connectorSlug: connector.slug };
}

async function mcpDirectory(actor: Awaited<ReturnType<typeof ownedMcpRun>>) {
  // Real agent tokens still resolve the owner's organization membership.
  // Bound only this owned actor; unrelated users receive a valid empty list.
  context.mocks.clerk.users.getOrganizationMembershipList.mockImplementation(
    (params: unknown): Promise<ClerkPaginated<ClerkOrganizationMembership>> => {
      const matches =
        typeof params === "object" &&
        params !== null &&
        "userId" in params &&
        params.userId === actor.userId;
      return Promise.resolve({
        totalCount: matches ? 1 : 0,
        data: matches
          ? [
              {
                id: `membership-${actor.userId}`,
                role: "org:member",
                createdAt: now(),
                organization: {
                  id: actor.orgId,
                  name: "Owned catalog organization",
                  slug: null,
                  imageUrl: "",
                  hasImage: false,
                  createdAt: now(),
                },
                publicUserData: { userId: actor.userId },
              },
            ]
          : [],
      });
    },
  );
  const seconds = Math.floor(now() / 1000);
  const token = signSandboxJwtForTests({
    scope: "okou",
    userId: actor.userId,
    orgId: actor.orgId,
    runId: actor.runId,
    capabilities: ["connector:read"],
    builtinConnectorSourceIds: { [actor.connectorSlug]: actor.connectionId },
    iat: seconds,
    exp: seconds + 3600,
  });
  return await setupApp({ context, routes: mcpConnectorsRoutes })(
    mcpConnectorsContract,
  ).list({
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("immutable connector catalog real-entry lifecycle", () => {
  it.fails("engine closes after initial SQL failure", () => {
    expect.unreachable(
      "The deliberately failing initial SQL must prevent the body",
    );
  });
  it.todo("n1: rejects downloaded bytes whose hash differs from the pointer");
  it("entry column migrations preserve payloads and backfill bundled and absent skills", async () => {
    if (!engine) {
      throw new Error("Missing case engine");
    }
    // Historical schema upgrades cannot be constructed through a public API.
    // Reuse the sole case-owned lifecycle engine, not another database binding.
    await engine.exec(`ALTER TABLE connector_catalog_entries
      DROP COLUMN label, DROP COLUMN description, DROP COLUMN category,
      DROP COLUMN auth_methods, DROP COLUMN firewall, DROP COLUMN storage_name,
      DROP COLUMN version_id, DROP COLUMN mcp_endpoint`);
    const versionId = "a".repeat(64);
    const entries = [
      {
        slug: "bundled",
        label: "Bundled connector",
        description: "Description",
        category: "productivity",
        authMethods: [{ id: "token" }],
        firewall: { kind: "generated", config: { rules: [] } },
        skill: {
          kind: "bundled",
          storageName: "connector-skill@bundled",
          versionId,
          storageVersionPrefix: `__system__/volume/connector-skill@bundled/${versionId}`,
        },
      },
      {
        slug: "no-skill",
        label: "No skill connector",
        description: "Other description",
        category: "communication",
        authMethods: [{ id: "oauth" }],
        firewall: { kind: "none" },
        skill: { kind: "none" },
        mcp: {
          transport: "streamable-http",
          endpoint: "https://mcp.example.com/mcp",
        },
      },
    ];
    for (const entry of entries) {
      await engine.query(
        "INSERT INTO connector_catalog_entries VALUES ('catalog', $1, $2)",
        [entry.slug, JSON.stringify(entry)],
      );
    }
    for (const name of [
      "1328_connector_catalog_entry_columns.sql",
      "1329_backfill_connector_catalog_entry_columns.sql",
    ]) {
      await engine.exec(await readFile(new URL(name, migrationDir), "utf8"));
    }
    const expected = entries.map((entry) => {
      return {
        hash: "catalog",
        slug: entry.slug,
        payload: entry,
        label: entry.label,
        description: entry.description,
        category: entry.category,
        auth_methods: entry.authMethods,
        firewall: entry.firewall,
        storage_name: entry.skill.storageName ?? null,
        version_id: entry.skill.versionId ?? null,
        mcp_endpoint: entry.mcp?.endpoint ?? null,
      };
    });
    expect(
      (
        await engine.query(
          "SELECT * FROM connector_catalog_entries ORDER BY slug",
        )
      ).rows,
    ).toStrictEqual(expected);
    await engine.query(
      "INSERT INTO connector_catalog_entries (hash, slug, payload) VALUES ('old-api', $1, $2)",
      [entries[0]?.slug, JSON.stringify(entries[0])],
    );
    const backfill = await readFile(
      new URL(
        "1329_backfill_connector_catalog_entry_columns.sql",
        migrationDir,
      ),
      "utf8",
    );
    await engine.exec(backfill);
    await engine.exec(backfill);
    expect(
      (
        await engine.query(
          "SELECT * FROM connector_catalog_entries WHERE hash = 'old-api'",
        )
      ).rows,
    ).toStrictEqual([{ ...expected[0], hash: "old-api" }]);
  });
  it("n2: binds all existing gateways to the case engine and accepts the publisher-shaped digest through cron", async () => {
    if (!engine || !binding.database) {
      throw new Error("Missing case engine");
    }
    const owner = createStore();
    expect(owner.get(db$)).toBe(binding.database);
    expect(owner.set(writeDb$)).toBe(binding.database);
    const first = release("2099-01-01.first", "First lifecycle catalog");
    serve(first);
    statements = [];
    const started = performance.now();
    const response = await sync();
    const durationMs = performance.now() - started;
    process.stdout.write(
      `P3_PGLITE_FULL_SYNC ${JSON.stringify({
        source: "real cron / per-case PGlite / controlled full catalog",
        connectors: first.artifact.connectors.length,
        statements: statements.length,
        durationMs,
        entryInserts: statements.filter((query) => {
          return query.startsWith('insert into "connector_catalog_entries"');
        }).length,
        entrySelects: statements.filter((query) => {
          return query.includes('from "connector_catalog_entries"');
        }).length,
      })}\n`,
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      outcome: "accepted",
      active: { catalogVersion: first.artifact.catalogVersion },
    });
    expect(
      (await engine.query("SELECT hash FROM connector_catalog")).rows,
    ).toStrictEqual([{ hash: first.hash }]);
    const expectedColumns = first.artifact.connectors
      .map((entry) => {
        return {
          slug: entry.slug,
          label: entry.label,
          description: entry.description,
          category: entry.category,
          auth_methods: entry.authMethods,
          firewall: entry.firewall,
          storage_name:
            entry.skill.kind === "bundled" ? entry.skill.storageName : null,
          version_id:
            entry.skill.kind === "bundled" ? entry.skill.versionId : null,
          payload: entry,
          mcp_endpoint: entry.mcp?.endpoint ?? null,
        };
      })
      .sort((a, b) => {
        return a.slug.localeCompare(b.slug);
      });
    const readColumns = async () => {
      if (!engine) {
        throw new Error("Missing case engine");
      }
      return (
        await engine.query(
          `SELECT slug, label, description, category, auth_methods, firewall,
                  storage_name, version_id, payload, mcp_endpoint
           FROM connector_catalog_entries WHERE hash = $1 ORDER BY slug`,
          [first.hash],
        )
      ).rows;
    };
    await expect(readColumns()).resolves.toStrictEqual(expectedColumns);
    // A retry trusts previously published entries instead of rewriting them.
    await engine.exec("DELETE FROM connector_catalog");
    expect((await sync()).body).toMatchObject({ outcome: "accepted" });
    await expect(readColumns()).resolves.toStrictEqual(expectedColumns);
    await directory(first);
    const next = release("2099-01-01.next", "Next lifecycle catalog");
    serve(next);
    const changed = await sync();
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({
      outcome: "accepted",
      active: { catalogVersion: next.artifact.catalogVersion },
    });
    expect(
      (
        await engine.query(
          "SELECT DISTINCT hash FROM connector_catalog_entries WHERE hash = $1",
          [next.hash],
        )
      ).rows,
    ).toStrictEqual([{ hash: next.hash }]);
    await directory(next);
    const mcpActor = await ownedMcpRun(next);
    expect((await mcpDirectory(mcpActor)).body).toMatchObject({
      connectors: [{ displayName: "Next lifecycle catalog" }],
    });
    expect((await sync()).body).toMatchObject({ outcome: "unchanged" });
    // Start with a genuinely accepted legacy directory and no new-table mirror.
    // This is per-case test fixture state only, never a preview database write.
    await engine.exec(
      "DELETE FROM connector_catalog; DELETE FROM connector_catalog_entries",
    );
    expect((await sync()).body).toMatchObject({ outcome: "accepted" });
    expect(
      (await engine.query("SELECT hash FROM connector_catalog")).rows,
    ).toStrictEqual([{ hash: next.hash }]);
    expect((await sync()).body).toMatchObject({ outcome: "unchanged" });
    const failed = release("2099-01-01.failed", "Prepared retry catalog");
    const blocked = failed.artifact.connectors[1];
    if (!blocked) {
      throw new Error("Missing partial preparation fixture");
    }
    await engine.exec(
      `ALTER TABLE connector_catalog_entries ADD CONSTRAINT preparation_failure CHECK (hash <> '${failed.hash}' OR slug <> '${blocked.slug}')`,
    );
    serve(failed);
    await expect(sync()).rejects.toThrow(
      "Unknown response status 500 for GET /api/cron/sync-connector-catalog",
    );
    await directory(next);
    expect((await mcpDirectory(mcpActor)).body).toMatchObject({
      connectors: [{ displayName: "Next lifecycle catalog" }],
    });
    expect(
      (await engine.query("SELECT hash FROM connector_catalog")).rows,
    ).toStrictEqual([{ hash: next.hash }]);
    expect(
      (
        await engine.query(
          "SELECT count(*)::integer AS count FROM connector_catalog_entries WHERE hash = $1",
          [failed.hash],
        )
      ).rows,
    ).toStrictEqual([{ count: 1 }]);
    await engine.exec(
      "ALTER TABLE connector_catalog_entries DROP CONSTRAINT preparation_failure",
    );
    expect((await sync()).body).toMatchObject({
      outcome: "accepted",
      active: { catalogVersion: failed.artifact.catalogVersion },
    });
    await directory(failed);
    expect((await mcpDirectory(mcpActor)).body).toMatchObject({
      connectors: [{ displayName: "Prepared retry catalog" }],
    });
    expect(
      (
        await engine.query(
          "SELECT catalog_digest FROM connector_catalog_active_snapshot",
        )
      ).rows,
    ).toStrictEqual([{ catalog_digest: failed.hash }]);
    expect(
      (await engine.query("SELECT hash FROM connector_catalog")).rows,
    ).toStrictEqual([{ hash: failed.hash }]);
    const skill = failed.artifact.connectors.flatMap((entry) => {
      return entry.skill.kind === "bundled" ? [entry.skill] : [];
    })[0];
    if (!skill) {
      throw new Error("Missing fixed bundled skill");
    }
    const storage = (
      await engine.query<{ id: string; head_version_id: string | null }>(
        "SELECT id, head_version_id FROM storages WHERE org_id = $1 AND user_id = $2 AND name = $3",
        [SYSTEM_ORG_ID, VOLUME_ORG_USER_ID, skill.storageName],
      )
    ).rows[0];
    if (!storage) {
      throw new Error("Cron did not register skill storage");
    }
    expect(storage.head_version_id).toBeNull();
    const mounted = createExecutionStorageObjects([
      {
        orgId: SYSTEM_ORG_ID,
        userId: VOLUME_ORG_USER_ID,
        storageId: storage.id,
        versionId: skill.versionId,
        name: skill.storageName,
        mountPath: "/skills/catalog-lifecycle",
        mode: "readonly",
      },
    ]);
    const prepared = await createStore().get(mounted.preparedMounts$);
    expect(prepared).toHaveLength(1);
    expect(prepared[0]).toMatchObject({
      storageId: storage.id,
      versionId: skill.versionId,
      writeback: false,
      archiveSize: skill.archiveSize,
    });
    const mount = prepared[0];
    if (!mount || mount.writeback) {
      throw new Error("Expected read-only exact skill mount");
    }
    expect(mount.archiveUrl).toStrictEqual(expect.any(String));
    // Already prepared entries are the receipt. This constraint rejects any
    // attempted reinsertion while allowing existing rows to remain untouched.
    await engine.exec(`
      ALTER TABLE connector_catalog_entries ADD CONSTRAINT no_reprepare
        CHECK (hash <> '${failed.hash}') NOT VALID;
      DELETE FROM connector_catalog;
    `);
    expect((await sync()).body).toMatchObject({ outcome: "accepted" });
    await directory(failed);
    expect(
      (await engine.query("SELECT hash FROM connector_catalog")).rows,
    ).toStrictEqual([{ hash: failed.hash }]);
  });
  it("reuses registered skill metadata without comparing the catalog copy", async () => {
    if (!engine) {
      throw new Error("Missing case engine");
    }
    const first = release("2099-01-02.first", "Original skill metadata");
    serve(first);
    expect((await sync()).body).toMatchObject({ outcome: "accepted" });
    const skill = first.artifact.connectors.flatMap((entry) => {
      return entry.skill.kind === "bundled" ? [entry.skill] : [];
    })[0];
    if (!skill) {
      throw new Error("Missing bundled skill");
    }
    const changed = release(
      "2099-01-02.changed",
      "Reused storage metadata",
      false,
      undefined,
      true,
    );
    serve(changed);
    expect((await sync()).body).toMatchObject({ outcome: "accepted" });
    await directory(changed);
    const storage = (
      await engine.query<{ id: string }>(
        "SELECT id FROM storages WHERE org_id = $1 AND user_id = $2 AND name = $3",
        [SYSTEM_ORG_ID, VOLUME_ORG_USER_ID, skill.storageName],
      )
    ).rows[0];
    if (!storage) {
      throw new Error("Missing registered skill storage");
    }
    const mounted = createExecutionStorageObjects([
      {
        orgId: SYSTEM_ORG_ID,
        userId: VOLUME_ORG_USER_ID,
        storageId: storage.id,
        versionId: skill.versionId,
        name: skill.storageName,
        mountPath: "/skills/registered-metadata",
        mode: "readonly",
      },
    ]);
    const mounts = await createStore().get(mounted.preparedMounts$);
    expect(mounts).toMatchObject([
      { versionId: skill.versionId, archiveSize: skill.archiveSize },
    ]);
    // The owning engine can construct corruption that no public API permits.
    // Wrong storage identity must still fail at the registration boundary.
    await engine.query(
      "UPDATE storage_versions SET s3_key = 'wrong-storage-path' WHERE id = $1",
      [skill.versionId],
    );
    const wrongIdentity = release("2099-01-02.wrong", "Wrong identity");
    serve(wrongIdentity);
    const rejected = await sync();
    expect(rejected.body).toMatchObject({ outcome: "rejected" });
    await directory(changed);
  });
  it("n3: real cron competitors share atomic legacy/hash/Pi acceptance and winner-only postcommit wakeups", async () => {
    if (!engine) {
      throw new Error("Missing case engine");
    }
    const first = release("2099-01-01.competitors", "Concurrent catalog");
    const connector = first.artifact.connectors[0];
    if (!connector) {
      throw new Error("Missing fixed connector");
    }
    const agentId = randomUUID();
    const sessionId = randomUUID();
    const runId = randomUUID();
    await engine.query(
      "INSERT INTO agents (id, org_id, owner, name) VALUES ($1, 'catalog-lifecycle-org', 'catalog-lifecycle-user', 'catalog-lifecycle')",
      [agentId],
    );
    await engine.query(
      "INSERT INTO agent_sessions (id, user_id, org_id, agent_id) VALUES ($1, 'catalog-lifecycle-user', 'catalog-lifecycle-org', $2)",
      [sessionId, agentId],
    );
    await engine.query(
      "INSERT INTO agent_runs (id, status, prompt, user_id, org_id, runner_group, session_id) VALUES ($1, 'running', 'catalog lifecycle', 'catalog-lifecycle-user', 'catalog-lifecycle-org', 'catalog-n3', $2)",
      [runId, sessionId],
    );
    await engine.query(
      "INSERT INTO connectors (auth_method, user_id, org_id, storage_version, connector_slug) VALUES ('token', 'catalog-lifecycle-user', 'catalog-lifecycle-org', 1, $1)",
      [connector.slug],
    );
    await engine.query(
      "INSERT INTO pi_stable_context_generations (org_id, agent_id, subject) VALUES ('catalog-lifecycle-org', $1, '@agent')",
      [agentId],
    );
    await engine.query(
      "INSERT INTO pi_stable_context_heads (org_id, user_id, agent_id, variant_digest) VALUES ('catalog-lifecycle-org', 'catalog-lifecycle-user', $1, $2)",
      [agentId, "a".repeat(64)],
    );
    const caseEngine = engine;
    context.mocks.ably.batchPublish.mockImplementation(async (spec) => {
      const current = (
        await caseEngine.query<{ hash: string }>(
          "SELECT hash FROM connector_catalog",
        )
      ).rows[0];
      const legacy = (
        await caseEngine.query<{ catalog_digest: string }>(
          "SELECT catalog_digest FROM connector_catalog_active_snapshot",
        )
      ).rows[0];
      if (!current || !legacy) {
        throw new Error("Notification preceded committed acceptance");
      }
      expect(current.hash).toBe(legacy.catalog_digest);
      expect(spec.channels).toStrictEqual(["runner-group:catalog-n3"]);
      expect(spec.messages).toHaveLength(1);
      expect(JSON.parse(String(spec.messages[0]?.data))).toStrictEqual({
        runId,
        target: { kind: "builtin", connectorSlug: connector.slug },
      });
      return {
        successCount: spec.channels.length,
        failureCount: 0,
        results: spec.channels.map((channel) => {
          return {
            channel,
            messageId: "catalog-n3-ack",
            serials: spec.messages.map(() => {
              return null;
            }),
          };
        }),
      };
    });
    serve(first);
    const accepted = await Promise.all([sync(), sync()]);
    expect(
      accepted.map((response) => {
        return response.status;
      }),
    ).toStrictEqual([200, 200]);
    expect(
      accepted
        .map((response) => {
          if (response.status !== 200) {
            throw new Error("Concurrent cron request failed");
          }
          return response.body.outcome;
        })
        .sort(),
    ).toStrictEqual(["accepted", "unchanged"]);
    expect(
      (
        await engine.query(
          "SELECT generation FROM pi_stable_context_generations",
        )
      ).rows,
    ).toStrictEqual([{ generation: 2 }]);
    expect(context.mocks.ably.batchPublish).toHaveBeenCalledTimes(1);
    expect(
      (await engine.query("SELECT hash FROM connector_catalog")).rows,
    ).toStrictEqual([{ hash: first.hash }]);
    expect(
      (
        await engine.query(
          "SELECT catalog_digest FROM connector_catalog_active_snapshot",
        )
      ).rows,
    ).toStrictEqual([{ catalog_digest: first.hash }]);
    // A legacy-accepted deployment can lack the additive mirror. Rebuilding it
    // still validates/prepares (the existing public outcome is "accepted"),
    // but must not repeat activation effects for existing consumers.
    await engine.exec(
      "DELETE FROM connector_catalog; DELETE FROM connector_catalog_entries",
    );
    expect((await sync()).body).toMatchObject({ outcome: "accepted" });
    expect(
      (await engine.query("SELECT hash FROM connector_catalog")).rows,
    ).toStrictEqual([{ hash: first.hash }]);
    expect(
      (
        await engine.query(
          "SELECT generation FROM pi_stable_context_generations",
        )
      ).rows,
    ).toStrictEqual([{ generation: 2 }]);
    expect(
      (
        await engine.query(
          "SELECT generation, status FROM pi_stable_context_heads",
        )
      ).rows,
    ).toStrictEqual([{ generation: 2, status: "missing" }]);
    expect(context.mocks.ably.batchPublish).toHaveBeenCalledTimes(1);
    expect((await sync()).body).toMatchObject({ outcome: "unchanged" });
    expect(context.mocks.ably.batchPublish).toHaveBeenCalledTimes(1);
    const concurrent = release(
      "2099-01-01.same-baseline",
      "Competing runtime update",
      true,
    );
    serve(concurrent);
    const competed = await Promise.all([sync(), sync()]);
    expect(
      competed
        .map((response) => {
          if (response.status !== 200) {
            throw new Error("Same-baseline cron failed");
          }
          return response.body.outcome;
        })
        .sort(),
    ).toStrictEqual(["accepted", "unchanged"]);
    expect(
      (
        await engine.query(
          "SELECT generation FROM pi_stable_context_generations",
        )
      ).rows,
    ).toStrictEqual([{ generation: 3 }]);
    expect(context.mocks.ably.batchPublish).toHaveBeenCalledTimes(2);
    expect(
      (await engine.query("SELECT hash FROM connector_catalog")).rows,
    ).toStrictEqual([{ hash: concurrent.hash }]);
    expect(
      (
        await engine.query(
          "SELECT catalog_digest FROM connector_catalog_active_snapshot",
        )
      ).rows,
    ).toStrictEqual([{ catalog_digest: concurrent.hash }]);
    const next = release(
      "2099-01-01.changed",
      "Changed concurrent catalog",
      true,
    );
    serve(next);
    await engine.exec(
      "ALTER TABLE pi_stable_context_generations ADD CONSTRAINT invalidation_failure CHECK (generation <= 3)",
    );
    await expect(sync()).rejects.toThrow(
      "Unknown response status 500 for GET /api/cron/sync-connector-catalog",
    );
    expect(
      (await engine.query("SELECT hash FROM connector_catalog")).rows,
    ).toStrictEqual([{ hash: concurrent.hash }]);
    expect(
      (
        await engine.query(
          "SELECT catalog_digest FROM connector_catalog_active_snapshot",
        )
      ).rows,
    ).toStrictEqual([{ catalog_digest: concurrent.hash }]);
    expect(context.mocks.ably.batchPublish).toHaveBeenCalledTimes(2);
    await engine.exec(
      "ALTER TABLE pi_stable_context_generations DROP CONSTRAINT invalidation_failure",
    );
    context.mocks.ably.batchPublish.mockRejectedValueOnce(
      new Error("Controlled realtime boundary unavailable"),
    );
    expect((await sync()).body).toMatchObject({ outcome: "accepted" });
    expect(
      (await engine.query("SELECT hash FROM connector_catalog")).rows,
    ).toStrictEqual([{ hash: next.hash }]);
    expect(
      (
        await engine.query(
          "SELECT generation FROM pi_stable_context_generations",
        )
      ).rows,
    ).toStrictEqual([{ generation: 4 }]);
    expect(context.mocks.ably.batchPublish).toHaveBeenCalledTimes(3);
    expect(
      (
        await engine.query(
          "SELECT generation, status FROM pi_stable_context_heads",
        )
      ).rows,
    ).toStrictEqual([{ generation: 4, status: "missing" }]);
    expect((await sync()).body).toMatchObject({ outcome: "unchanged" });
    expect(context.mocks.ably.batchPublish).toHaveBeenCalledTimes(3);
  });
  it("n4: real MCP consumer follows hash switches while captured entries retain their hash", async () => {
    const first = release("2099-01-02.old", "Old MCP catalog");
    const next = release("2099-01-02.new", "New MCP catalog");
    serve(first);
    expect((await sync()).body).toMatchObject({ outcome: "accepted" });
    const actor = await ownedMcpRun(first);
    expect((await mcpDirectory(actor)).body).toMatchObject({
      connectors: [
        { displayName: "Old MCP catalog", connectionId: actor.connectionId },
      ],
    });
    const slug = first.artifact.connectors[0]?.slug;
    if (!slug) {
      throw new Error("Missing MCP connector");
    }
    statements = [];
    const captured = await createStore().get(
      immutableConnectorRuntimeSelection({
        requestedConnectorSlugs: [slug],
      }),
    );
    expect(statements).toHaveLength(1);
    expect(captured.catalogIdentity.hash).toBe(first.hash);
    serve(next);
    expect((await sync()).body).toMatchObject({ outcome: "accepted" });
    expect((await mcpDirectory(actor)).body).toMatchObject({
      connectors: [
        { displayName: "New MCP catalog", connectionId: actor.connectionId },
      ],
    });
    statements = [];
    const retained = await createStore().get(
      immutableConnectorRuntimeSelection({
        requestedConnectorSlugs: [slug],
        capturedCatalog: captured.capturedCatalog,
      }),
    );
    expect(retained.connectors.get(slug)?.catalogConnector.label).toBe(
      "Old MCP catalog",
    );
    expect(retained.catalogIdentity.hash).toBe(first.hash);
    expect(statements).toHaveLength(1);
    expect(statements[0]).not.toContain('from "connector_catalog"');
    serve(first);
    expect((await sync()).body).toMatchObject({ outcome: "accepted" });
    expect((await mcpDirectory(actor)).body).toMatchObject({
      connectors: [
        { displayName: "Old MCP catalog", connectionId: actor.connectionId },
      ],
    });
    const metadata = await createStore().get(
      immutableConnectorRuntimeSelection({
        requestedConnectorSlugs: [],
        metadataConnectorSlugs: [slug],
      }),
    );
    expect(metadata.connectors.size).toBe(0);
    expect(metadata.serverFirewalls.has(slug)).toBeFalsy();
    expect(metadata.serverFirewallMetadata.has(slug)).toBeTruthy();
    expect(metadata.catalogIdentity.hash).toBe(first.hash);
    const configured = await createStore().get(
      immutableConnectorRuntimeSelection({
        requestedConnectorSlugs: ["github"],
      }),
    );
    clearMockedEnv();
    const unconfigured = await createStore().get(
      immutableConnectorRuntimeSelection({
        requestedConnectorSlugs: ["github"],
      }),
    );
    expect(unconfigured.catalogIdentity.hash).toBe(
      configured.catalogIdentity.hash,
    );
    expect(unconfigured.catalogIdentity.capabilityDigest).not.toBe(
      configured.catalogIdentity.capabilityDigest,
    );
    expect(unconfigured.connectors.get("github")?.methods.size).toBeLessThan(
      configured.connectors.get("github")?.methods.size ?? 0,
    );
  });
  it("n5: real MCP consumer treats absent entries as unknown and rejects a missing pointer", async () => {
    if (!engine) {
      throw new Error("Missing case engine");
    }
    const candidate = release("2099-01-03.missing", "Missing-row catalog");
    serve(candidate);
    expect((await sync()).body).toMatchObject({ outcome: "accepted" });
    const actor = await ownedMcpRun(candidate);
    expect((await mcpDirectory(actor)).status).toBe(200);
    const slug = candidate.artifact.connectors[0]?.slug;
    if (!slug) {
      throw new Error("Missing MCP connector");
    }
    const unknown = "unknown-catalog-connector";
    const unknownActor = { ...actor, connectorSlug: unknown };
    expect((await mcpDirectory(unknownActor)).body).toStrictEqual({
      connectors: [],
    });
    const empty = await createStore().get(
      immutableConnectorRuntimeSelection({
        requestedConnectorSlugs: [],
      }),
    );
    expect(empty.catalogIdentity.hash).toBe(candidate.hash);
    expect(empty.connectors.size).toBe(0);
    context.mocks.s3.send.mockClear();
    statements = [];
    await engine.query(
      "DELETE FROM connector_catalog_entries WHERE hash = $1 AND slug = $2",
      [candidate.hash, slug],
    );
    expect((await mcpDirectory(actor)).body).toStrictEqual({ connectors: [] });
    expect((await mcpDirectory(unknownActor)).body).toStrictEqual({
      connectors: [],
    });
    await engine.exec("DELETE FROM connector_catalog");
    expect((await mcpDirectory(unknownActor)).status).toBe(500);
    await expect(
      createStore().get(
        immutableConnectorRuntimeSelection({
          requestedConnectorSlugs: [],
        }),
      ),
    ).rejects.toThrow("Immutable connector catalog current is missing");
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
    const catalogReads = statements.filter((query) => {
      return query.includes("connector_catalog");
    });
    expect(catalogReads).toHaveLength(4);
    for (const query of catalogReads) {
      expect(query).not.toContain("connector_catalog_active_snapshot");
      expect(query).not.toContain("connector_catalog_compatibility_evaluation");
    }
  });
});

// These seven cases replace the old projection-reader suite. Only this lifecycle
// project may publish/fault immutable current: every case owns its PGlite engine.
// Storage corruption cannot be constructed through a production user endpoint.
describe("slug-first current catalog business readers", () => {
  const headers = { authorization: "Bearer clerk-session" };
  function catalogClient() {
    return setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    );
  }
  async function publishedCatalog() {
    const candidate = release(
      `2099-02-01.${randomUUID()}`,
      "Slug-reader catalog",
    );
    serve(candidate);
    expect((await sync()).body).toMatchObject({ outcome: "accepted" });
    routeMocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    return candidate;
  }
  async function unreadableLegacySnapshot() {
    if (!engine) {
      throw new Error("Missing case engine");
    }
    await engine.query(
      "UPDATE connector_catalog_active_snapshot SET catalog_gzip = $1",
      [Buffer.from("invalid gzip")],
    );
  }

  it("answers detail and permissions from current entries", async () => {
    await publishedCatalog();
    const before = await accept(
      catalogClient().get({ headers, params: { connectorSlug: "openai" } }),
      [200],
    );
    await unreadableLegacySnapshot();
    expect(
      (
        await accept(
          catalogClient().get({ headers, params: { connectorSlug: "openai" } }),
          [200],
        )
      ).body,
    ).toStrictEqual(before.body);
    const permissions = await accept(
      catalogClient().permissions({
        headers,
        params: { connectorSlug: "notion" },
      }),
      [200],
    );
    expect(permissions.body.permissions.connectorSlug).toBe("notion");
  });
  it("reports an absent slug as unknown", async () => {
    await publishedCatalog();
    await unreadableLegacySnapshot();
    const result = await accept(
      catalogClient().get({
        headers,
        params: { connectorSlug: "missing-catalog-slug" },
      }),
      [404],
    );
    expect(result.body.error.code).toBe("NOT_FOUND");
  });
  it("serves complete lists, search and compatibility from published entries", async () => {
    const candidate = await publishedCatalog();
    if (!engine) {
      throw new Error("Missing case engine");
    }
    await unreadableLegacySnapshot();
    await engine.exec(
      "DELETE FROM connector_catalog_compatibility_evaluation; DELETE FROM connector_catalog_active_snapshot; DELETE FROM connector_catalog_sync_state",
    );
    await engine.query(
      "UPDATE connector_catalog SET entry_slugs = '[]'::jsonb, catalog_version = 'ignored-publication-label'",
    );
    const listed = await accept(catalogClient().list({ headers }), [200]);
    expect(listed.body.connectors).toContainEqual(
      expect.objectContaining({ slug: "github" }),
    );
    // Category labels come from the pointer row that owns the listed hash.
    const listedCategories = new Set(
      listed.body.connectors.map((connector) => {
        return connector.category;
      }),
    );
    expect(
      new Set(
        listed.body.categoryMetadata?.categories.map((category) => {
          return category.id;
        }),
      ),
    ).toStrictEqual(listedCategories);
    await directory(candidate);
    const oneClick = await accept(catalogClient().oneClick({ headers }), [200]);
    expect(oneClick.body.connectors.length).toBeGreaterThan(0);
  });

  it.each(["claude-code", "pi"])(
    "claims an old %s execution context and v1 permission baseline",
    async (cliAgentType) => {
      const candidate = await publishedCatalog();
      if (!engine) {
        throw new Error("Missing case engine");
      }
      const actor = await ownedMcpRun(candidate);
      const validator = currentConnectorCatalogValidatorIdentity();
      const storedContext = storedExecutionContextSchema.parse({
        storageMounts: [],
        environment: null,
        platformEnvironment: {},
        secretValueEnvironmentKeys: null,
        resumeSession: null,
        encryptedSecrets: null,
        cliAgentType,
        connectorRuntimeTargets: [{ kind: "builtin", connectorSlug: "github" }],
        networkPolicies: {
          github: {
            allow: [],
            deny: ["user:read"],
            ask: [],
            unknownPolicy: "deny",
          },
        },
        connectorPermissionBaseline: {
          version: 1,
          catalogIdentity: {
            sourceId: connectorCatalogSource().sourceId,
            schemaVersion: 4,
            // Pre-migration contexts have a publication version, not the hash alias.
            catalogVersion: candidate.artifact.catalogVersion,
            catalogDigest: candidate.hash,
            capabilityDigest: connectorCatalogExecutableCapabilityDigest(),
          },
          validationAuthority: {
            backendVersion: validator.validatorVersion,
            buildCommitSha: validator.buildCommitSha,
          },
          connectors: {
            github: {
              permissionNames: ["user:read"],
              defaultPolicy: {
                permissionDefault: "deny",
                unknownPolicy: "deny",
              },
            },
          },
        },
        ...(cliAgentType === "pi"
          ? {
              piSessionId: randomUUID(),
              piLaunchConfig: { schemaVersion: 2 },
              piModelConfig: {
                provider: "openrouter",
                baseUrl: "https://openrouter.ai/api/v1",
                model: "@preset/okou-1-0",
                apiKeyEnv: "OPENAI_API_KEY",
                credentialSecretName: "OPENROUTER_API_KEY",
              },
            }
          : {}),
      });
      await engine.query(
        "UPDATE agent_runs SET status = 'pending', runner_group = 'vm0/default' WHERE id = $1",
        [actor.runId],
      );
      await engine.query(
        "INSERT INTO runner_job_queue (run_id, runner_group, execution_context, expires_at) VALUES ($1, 'vm0/default', $2, now() + interval '1 hour')",
        [actor.runId, JSON.stringify(storedContext)],
      );
      await engine.exec(
        "DELETE FROM connector_catalog_compatibility_evaluation; DELETE FROM connector_catalog_active_snapshot; DELETE FROM connector_catalog_sync_state",
      );
      const claim = await accept(
        setupApp({ context, routes: runnersRoutes })(
          runnersJobClaimContract,
        ).claim({
          headers: {
            authorization: `Bearer ${OFFICIAL_RUNNER_TOKEN_PREFIX}${"abcdef0123456789".repeat(4)}`,
          },
          params: { id: actor.runId },
          body: {
            runnerIdentity: { runnerId: randomUUID(), heartbeatGeneration: 1 },
            capabilities: { piModelConfigGenerations: [1] },
          },
        }),
        [200],
      );
      expect(claim.body.cliAgentType).toBe(cliAgentType);
      expect(claim.body.networkPolicies?.github).toStrictEqual({
        allow: [],
        deny: ["user:read"],
        ask: [],
        unknownPolicy: "deny",
      });
      if (cliAgentType === "pi") {
        expect(claim.body.piSessionId).toBe(storedContext.piSessionId);
        expect(claim.body.piLaunchConfig).toStrictEqual(
          storedContext.piLaunchConfig,
        );
      }
    },
  );

  it("lists named onboarding sources from current entries", async () => {
    await publishedCatalog();
    const client = setupApp({ context, routes: onboardingSourcesRoutes })(
      onboardingSourcesContract,
    );
    const before = await accept(client.list({ headers }), [200]);
    expect(before.body.connectors.length).toBeGreaterThan(0);
    await unreadableLegacySnapshot();
    expect((await accept(client.list({ headers }), [200])).body).toStrictEqual(
      before.body,
    );
  });
  it("summarizes case-owned accounts using current methods and briefs", async () => {
    await publishedCatalog();
    const client = setupApp({
      context,
      routes: [...connectorOverviewRoutes, ...builtinConnectorsRoutes],
    });
    const account = await accept(
      client(builtinConnectorManualGrantContract).connect({
        headers,
        params: { connectorSlug: "gitlab" },
        body: {
          authMethod: "api-token",
          account: { intent: "add" },
          values: { accessToken: "gl-test-token", host: "gitlab.example.com" },
        },
      }),
      [200],
    );
    await unreadableLegacySnapshot();
    const overview = await accept(
      client(connectorOverviewContract).overview({ headers }),
      [200],
    );
    expect(overview.body.accountSummaries).toStrictEqual([
      expect.objectContaining({
        target: { kind: "builtin", connectorSlug: "gitlab" },
        accountCount: 1,
        defaultConnection: expect.objectContaining({
          id: account.body.id,
          connectionStatus: "connected",
        }),
      }),
    ]);
    expect(overview.body.builtinConnectors).toContainEqual(
      expect.objectContaining({ slug: "gitlab" }),
    );
  });
  it("lists named onboarding workflow connectors from current entries", async () => {
    await publishedCatalog();
    const client = setupApp({
      context,
      routes: onboardingWorkflowConnectorsRoutes,
    })(onboardingWorkflowConnectorsContract);
    const before = await accept(client.list({ headers }), [200]);
    expect(before.body.connectors.length).toBeGreaterThan(0);
    await unreadableLegacySnapshot();
    expect((await accept(client.list({ headers }), [200])).body).toStrictEqual(
      before.body,
    );
  });
  it("reports a missing entry as not found and a missing pointer as unavailable", async () => {
    const candidate = await publishedCatalog();
    if (!engine) {
      throw new Error("Missing case engine");
    }
    // Keep the accepted full snapshot intact: substitution would return 200.
    await engine.query(
      "DELETE FROM connector_catalog_entries WHERE hash = $1 AND slug = 'openai'",
      [candidate.hash],
    );
    const result = await accept(
      catalogClient().get({ headers, params: { connectorSlug: "openai" } }),
      [404],
    );
    expect(result.body.error.code).toBe("NOT_FOUND");
    await accept(
      catalogClient().get({ headers, params: { connectorSlug: "github" } }),
      [200],
    );
    await accept(
      catalogClient().get({
        headers,
        params: { connectorSlug: "missing-catalog-slug" },
      }),
      [404],
    );
    await engine.query(
      "DELETE FROM connector_catalog_entries WHERE hash = $1",
      [candidate.hash],
    );
    const listUnavailable = await accept(
      catalogClient().list({ headers }),
      [503],
    );
    expect(listUnavailable.body.error.code).toBe("PROVIDER_UNAVAILABLE");
    await engine.exec("DELETE FROM connector_catalog");
    const detailUnavailable = await accept(
      catalogClient().get({ headers, params: { connectorSlug: "github" } }),
      [503],
    );
    const permissionsUnavailable = await accept(
      catalogClient().permissions({
        headers,
        params: { connectorSlug: "github" },
      }),
      [503],
    );
    for (const unavailable of [detailUnavailable, permissionsUnavailable]) {
      expect(unavailable.body.error).toMatchObject({
        code: "PROVIDER_UNAVAILABLE",
        message: "Connector catalog is temporarily unavailable",
      });
    }
  });
  it("a later slug request follows current publication without a retained version", async () => {
    const first = release("2099-02-02.first", "First OpenAI", false, "openai");
    serve(first);
    expect((await sync()).body).toMatchObject({ outcome: "accepted" });
    routeMocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    expect(
      (
        await accept(
          catalogClient().get({ headers, params: { connectorSlug: "openai" } }),
          [200],
        )
      ).body.connector.label,
    ).toBe("First OpenAI");
    const next = release("2099-02-02.next", "Next OpenAI", false, "openai");
    serve(next);
    expect((await sync()).body).toMatchObject({ outcome: "accepted" });
    expect(
      (
        await accept(
          catalogClient().get({ headers, params: { connectorSlug: "openai" } }),
          [200],
        )
      ).body.connector.label,
    ).toBe("Next OpenAI");
  });
});

// Account generation cases now publish only in their own lifecycle engine.
describe("current-publication account readers", () => {
  const mocks = routeMocks;
  const routes = Object.freeze([
    ...connectorAccountRoutes,
    ...builtinConnectorsRoutes,
    ...customConnectorsRoutes,
    ...customConnectorsDeleteRoutes,
    ...customConnectorsValuesSetRoutes,
  ]);

  interface AccountCatalogFixture {
    readonly orgId: string;
    readonly userId: string;
  }

  function authHeaders() {
    return { authorization: "Bearer clerk-session" };
  }

  function accountClient() {
    return setupApp({ context, routes })(connectorAccountsContract);
  }

  function customConnectorClient() {
    return setupApp({ context, routes })(customConnectorsContract);
  }

  function customConnectorByIdClient() {
    return setupApp({ context, routes })(customConnectorByIdContract);
  }

  async function deleteBuiltinAccountPage(
    connectorSlug: "openai" | "github",
    connections: readonly { readonly id: string }[],
  ): Promise<void> {
    const accountsApi = accountClient();
    for (let offset = 0; offset < connections.length; offset += 4) {
      const deleted = await Promise.allSettled(
        connections.slice(offset, offset + 4).map(async (account) => {
          await accept(
            accountsApi.delete({
              headers: authHeaders(),
              params: { connectionId: account.id },
              body: { target: { kind: "builtin", connectorSlug } },
            }),
            [200, 404],
          );
        }),
      );
      for (const result of deleted) {
        if (result.status === "rejected") {
          throw result.reason;
        }
      }
    }
  }

  async function cleanupFixture(fixture: AccountCatalogFixture): Promise<void> {
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const accountsApi = accountClient();
    for (const connectorSlug of ["openai", "github"] as const) {
      let hasBuiltinAccounts = true;
      while (hasBuiltinAccounts) {
        const accounts = await accept(
          accountsApi.connections({
            headers: authHeaders(),
            query: { kind: "builtin", connectorSlug, limit: 100 },
          }),
          [200, 404],
        );
        hasBuiltinAccounts =
          accounts.status === 200 && accounts.body.connections.length > 0;
        if (accounts.status !== 200) {
          break;
        }
        await deleteBuiltinAccountPage(
          connectorSlug,
          accounts.body.connections,
        );
      }
    }
    const customConnectors = await accept(
      customConnectorClient().list({ headers: authHeaders() }),
      [200],
    );
    for (const definition of customConnectors.body.connectors) {
      const customAccounts = await accept(
        accountClient().connections({
          headers: authHeaders(),
          query: {
            kind: "custom",
            customConnectorId: definition.id,
            limit: 100,
          },
        }),
        [200, 404],
      );
      if (customAccounts.status === 200) {
        for (const account of customAccounts.body.connections) {
          await accept(
            accountClient().delete({
              headers: authHeaders(),
              params: { connectionId: account.id },
              body: {
                target: {
                  kind: "custom",
                  customConnectorId: definition.id,
                },
              },
            }),
            [200, 404],
          );
        }
      }
      await accept(
        customConnectorByIdClient().delete({
          headers: authHeaders(),
          params: { id: definition.id },
        }),
        [204, 404],
      );
    }
  }

  describe("connector account lifecycle routes", () => {
    const track = createFixtureTracker<AccountCatalogFixture>(cleanupFixture);

    async function seedFixture(
      overrides: Partial<AccountCatalogFixture> = {},
    ): Promise<AccountCatalogFixture> {
      const fixture = await track(
        Promise.resolve({
          orgId: overrides.orgId ?? `org_${randomUUID()}`,
          userId: overrides.userId ?? `user_${randomUUID()}`,
        }),
      );
      mocks.clerk.session(fixture.userId, fixture.orgId);
      return fixture;
    }

    it("reviews requested scopes for one exact account across default changes", async () => {
      const fixture = await seedFixture();
      const currentScopes = ["repo", "project", "workflow"] as const;
      const actor = createBddApi(context).user(fixture);
      const connectors = createConnectorBddApi(context);
      const catalog = createPublicConnectorCatalog(context, {
        cleanupOwnership: "caller",
      });
      const staleCatalog = catalogWithAuthMethod(
        { connectorSlug: "github", authMethodId: "oauth" },
        (method) => {
          if (method.grant.kind !== "auth-code") {
            throw new Error("Expected the GitHub authorization-code method");
          }
          return { ...method, grant: { ...method.grant, scopes: ["repo"] } };
        },
      );
      const accountIds: string[] = [];
      catalog.onCleanup(async () => {
        const accounts = await connectors.listBuiltinConnectorAccounts(
          actor,
          "github",
        );
        for (const account of accounts) {
          if (accountIds.includes(account.id)) {
            await connectors.deleteBuiltinConnectorAccount(
              actor,
              "github",
              account.id,
            );
          }
        }
      });
      const connectAccount = async (userId: number) => {
        mockGitHubConnectorOAuth({ userId, login: `scope-review-${userId}` });
        // Grants can be narrower than the selected catalog's requested scopes.
        server.use(
          http.post("https://github.com/login/oauth/access_token", () => {
            return HttpResponse.json({
              access_token: `scope-review-${userId}`,
              scope: "repo",
            });
          }),
        );
        const started = await connectors.startOauth(actor, "github", "oauth");
        const state = new URL(started.authorizationUrl).searchParams.get(
          "state",
        );
        if (!state) {
          throw new Error("Expected GitHub OAuth state");
        }
        await connectors.completeOauthCallback("github", {
          code: `scope-review-${userId}`,
          state,
        });
        const accounts = await connectors.listBuiltinConnectorAccounts(
          actor,
          "github",
        );
        const account = accounts.find((candidate) => {
          return candidate.externalId === String(userId);
        });
        if (!account) {
          throw new Error("Expected the exact GitHub provider identity");
        }
        accountIds.push(account.id);
        return account.id;
      };
      await catalog.publish(staleCatalog);
      const staleId = await connectAccount(1001);
      await catalog.publish(API_TEST_CONNECTOR_CATALOG);
      const currentId = await connectAccount(1002);
      await connectors.setDefaultBuiltinConnectorAccount(
        actor,
        "github",
        currentId,
      );

      const legacyList = await accept(
        accountClient().connections({
          headers: authHeaders(),
          query: { kind: "builtin", connectorSlug: "github", limit: 100 },
        }),
        [200],
      );
      expect(
        legacyList.body.connections.every((account) => {
          return !("scopeMismatch" in account);
        }),
      ).toBeTruthy();
      expect("defaultConnection" in legacyList.body).toBeFalsy();

      const enrichedList = await accept(
        accountClient().connections({
          headers: authHeaders(),
          query: {
            kind: "builtin",
            connectorSlug: "github",
            includeScopeMismatch: "true",
            limit: 100,
          },
        }),
        [200],
      );
      const mismatchById = new Map(
        enrichedList.body.connections.map((account) => {
          return [account.id, account.scopeMismatch] as const;
        }),
      );
      expect(mismatchById).toStrictEqual(
        new Map([
          [staleId, true],
          [currentId, false],
        ]),
      );
      expect(enrichedList.body.defaultConnection).toMatchObject({
        id: currentId,
        scopeMismatch: false,
      });

      const filteredList = await accept(
        accountClient().connections({
          headers: authHeaders(),
          query: {
            kind: "builtin",
            connectorSlug: "github",
            includeScopeMismatch: "true",
            limit: 100,
            search: staleId,
          },
        }),
        [200],
      );
      expect(filteredList.body.connections).toHaveLength(1);
      expect(filteredList.body.connections[0]?.id).toBe(staleId);
      expect("defaultConnection" in filteredList.body).toBeFalsy();

      const staleDiff = await accept(
        accountClient().scopeDiff({
          headers: authHeaders(),
          params: { connectionId: staleId },
          query: { connectorSlug: "github" },
        }),
        [200],
      );
      expect(staleDiff.body).toStrictEqual({
        addedScopes: ["project", "workflow"],
        removedScopes: [],
        currentScopes,
        storedScopes: ["repo"],
      });
      const currentDiff = await accept(
        accountClient().scopeDiff({
          headers: authHeaders(),
          params: { connectionId: currentId },
          query: { connectorSlug: "github" },
        }),
        [200],
      );
      expect(currentDiff.body).toStrictEqual({
        addedScopes: [],
        removedScopes: [],
        currentScopes,
        storedScopes: currentScopes,
      });

      await accept(
        accountClient().setDefault({
          headers: authHeaders(),
          params: { connectionId: staleId },
          body: { target: { kind: "builtin", connectorSlug: "github" } },
        }),
        [200],
      );
      const currentDiffAfterDefaultChange = await accept(
        accountClient().scopeDiff({
          headers: authHeaders(),
          params: { connectionId: currentId },
          query: { connectorSlug: "github" },
        }),
        [200],
      );
      expect(currentDiffAfterDefaultChange.body).toStrictEqual(
        currentDiff.body,
      );

      await accept(
        accountClient().scopeDiff({
          headers: authHeaders(),
          params: { connectionId: currentId },
          query: { connectorSlug: "openai" },
        }),
        [404],
      );
      await seedFixture();
      await accept(
        accountClient().scopeDiff({
          headers: authHeaders(),
          params: { connectionId: currentId },
          query: { connectorSlug: "github" },
        }),
        [404],
      );

      mocks.clerk.session(fixture.userId, fixture.orgId);
      await accept(
        accountClient().delete({
          headers: authHeaders(),
          params: { connectionId: currentId },
          body: { target: { kind: "builtin", connectorSlug: "github" } },
        }),
        [200],
      );
      await accept(
        accountClient().scopeDiff({
          headers: authHeaders(),
          params: { connectionId: currentId },
          query: { connectorSlug: "github" },
        }),
        [404],
      );
      await catalog.cleanup();
    });

    it("treats a removed built-in catalog target as absent", async () => {
      const fixture = await seedFixture();
      const actor = createBddApi(context).user(fixture);
      const connectors = createConnectorBddApi(context);
      const catalog = createPublicConnectorCatalog(context, {
        cleanupOwnership: "caller",
      });
      const available = catalogWithManualConnector({
        connectorSlug: "retired-connector",
        authMethodId: "api-token",
      });
      await catalog.publish(available);
      const account = await connectors.connectManualGrant(
        actor,
        "retired-connector",
        "api-token",
        {
          credential: "retired-connector-secret",
        },
      );
      const accountId = account.id;
      catalog.onCleanup(async () => {
        await catalog.publish(available);
        await connectors.deleteDefaultBuiltinConnectorAccount(
          actor,
          "retired-connector",
        );
      });
      await catalog.publish(API_TEST_CONNECTOR_CATALOG);

      const summary = await accept(
        accountClient().summaries({ headers: authHeaders() }),
        [200],
      );
      expect(summary.body.summaries).not.toContainEqual(
        expect.objectContaining({
          target: { kind: "builtin", connectorSlug: "retired-connector" },
        }),
      );
      await accept(
        accountClient().connections({
          headers: authHeaders(),
          query: {
            kind: "builtin",
            connectorSlug: "retired-connector",
            limit: 100,
          },
        }),
        [404],
      );
      await accept(
        accountClient().connection({
          headers: authHeaders(),
          params: { connectionId: accountId },
          query: {
            kind: "builtin",
            connectorSlug: "retired-connector",
          },
        }),
        [404],
      );
      await accept(
        accountClient().rename({
          headers: authHeaders(),
          params: { connectionId: accountId },
          body: {
            target: { kind: "builtin", connectorSlug: "retired-connector" },
            displayName: "Must remain absent",
          },
        }),
        [404],
      );
      await catalog.cleanup();
    });
  });
});
