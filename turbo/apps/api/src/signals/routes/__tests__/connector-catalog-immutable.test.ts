/* eslint-disable no-restricted-imports, api/no-package-variable, api/no-test-vi-mocks -- Only this N lifecycle process binds the existing DB module to per-case real PGlite; all ordinary suites retain node-postgres (target-state v5). */
/* oxlint-disable vitest/warn-todo -- N1/N4/N5 belong to later pointer/reader stages. */
import { readFile, readdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { builtinConnectorsSearchContract } from "@okouai/api-contracts/contracts/connectors";
import { SYSTEM_ORG_ID, VOLUME_ORG_USER_ID } from "@okouai/core/storage-names";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { btree_gin } from "@electric-sql/pglite/contrib/btree_gin";
import { drizzle } from "drizzle-orm/pglite";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { cronConnectorCatalogContract } from "@okouai/api-contracts/contracts/cron";
import {
  connectorCatalogArtifactSchema,
  CONNECTOR_CATALOG_ACTIVE_KEY,
} from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import { API_TEST_CONNECTOR_CATALOG_ARTIFACT } from "../../../test-fixtures/connector-catalog-artifact";
import { getApiTestMocks, resetApiTestMocks } from "../../../__tests__/mocks";
import { setupApp } from "../../../__tests__/test-helpers";
import { testContext } from "../../../__tests__/test-context";
import { clearMockedEnv } from "../../../lib/env";
import { cronConnectorCatalogRoutes } from "../cron-connector-catalog";
import { flushWaitUntilForTest, waitUntil } from "../../context/wait-until";
import { db$, writeDb$ } from "../../external/db";
import { createStore } from "ccstate";
import { createDeferredPromise, settle } from "../../utils";
import { builtinConnectorsRoutes } from "../connectors";
import { createRouteMocks } from "./helpers/route-test";
import { createExecutionStorageObjects } from "../../services/execution-storage.service";
import { mockApiTestConnectorProviderConfiguration } from "../../../test-fixtures/connector-catalog";

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
      if (trace) {
        assert.equal(trace.signal.aborted, true);
        assert.deepEqual(trace.events, ["owner-aborted", "native-drained"]);
      }
      await flushWaitUntilForTest();
      trace?.events.push("waitUntil-drained");
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

beforeEach(async () => {
  resetApiTestMocks();
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
  assert.equal(engineTraces.length, 3);
  for (const trace of engineTraces) {
    assert.deepEqual(trace.events, [
      "owner-aborted",
      "native-drained",
      "waitUntil-drained",
      "closed",
    ]);
    assert.equal(trace.engine.closed, true);
  }
  assert.equal(
    engineTraces.find((trace) => {
      return trace.name.endsWith("engine closes after initial SQL failure");
    })?.setupFailureObserved,
    true,
  );
});

function release(version: string, label: string, runtimeChange = false) {
  const artifact = connectorCatalogArtifactSchema.parse(
    structuredClone(API_TEST_CONNECTOR_CATALOG_ARTIFACT),
  );
  artifact.catalogVersion = version;
  const first = artifact.connectors[0];
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

describe("immutable connector catalog real-entry lifecycle", () => {
  it.fails("engine closes after initial SQL failure", () => {
    expect.unreachable(
      "The deliberately failing initial SQL must prevent the body",
    );
  });
  it.todo("n1: rejects downloaded bytes whose hash differs from the pointer");
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
    const conflicting = release(
      "2099-01-01.conflicting",
      "Conflicting preparation",
    );
    const entry = conflicting.artifact.connectors[0];
    if (!entry) {
      throw new Error("Missing conflict fixture");
    }
    await engine.query(
      "INSERT INTO connector_catalog_entries (hash, slug, payload) VALUES ($1, $2, $3)",
      [
        conflicting.hash,
        entry.slug,
        JSON.stringify({ ...entry, label: "Conflicting stored bytes" }),
      ],
    );
    serve(conflicting);
    await expect(sync()).rejects.toThrow(
      "Unknown response status 500 for GET /api/cron/sync-connector-catalog",
    );
    await directory(failed);
    expect(
      (await engine.query("SELECT hash FROM connector_catalog")).rows,
    ).toStrictEqual([{ hash: failed.hash }]);
    await engine.query(
      "DELETE FROM connector_catalog_entries WHERE hash = $1",
      [conflicting.hash],
    );
    await engine.query(
      "INSERT INTO connector_catalog_entries (hash, slug, payload) VALUES ($1, 'unexpected-slug', $2)",
      [conflicting.hash, JSON.stringify(entry)],
    );
    await expect(sync()).rejects.toThrow(
      "Unknown response status 500 for GET /api/cron/sync-connector-catalog",
    );
    await directory(failed);
    expect(
      (await engine.query("SELECT hash FROM connector_catalog")).rows,
    ).toStrictEqual([{ hash: failed.hash }]);
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
  it.todo("n4: reads old immutable entries after switching back to their hash");
  it.todo(
    "n5: distinguishes unknown slugs from missing entries without fallback",
  );
});
