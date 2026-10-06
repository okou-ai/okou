/* eslint-disable no-restricted-imports, api/no-package-variable, api/no-test-vi-mocks -- Only this N lifecycle process binds the existing DB module to per-case real PGlite; all ordinary suites retain node-postgres (target-state v5). */
import { eq } from "drizzle-orm";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { connectorCatalog } from "@okouai/db/schema/connector-catalog";
import {
  immutableCatalogValues,
  prepareImmutableCatalogEntries$,
} from "../../services/connector-catalog-immutable.service";
import { piStableContextHeads } from "@okouai/db/schema/pi-stable-context";
import { readFile, readdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { connectorCatalogSource } from "../../services/connector-catalog-source";
import { mcpConnectorsContract } from "@okouai/api-contracts/contracts/mcp-connectors";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { mcpConnectorsRoutes } from "../mcp-connectors";
import {
  immutableConnectorRuntimeSelection,
  type ImmutableConnectorRuntimeSelection,
} from "../../services/connector-catalog-entries.service";
import {
  resolveConnectorRuntimeTargets$,
  resolveConnectorRuntimeDiagnosticTargets$,
} from "../../services/connector-runtime-sync.service";
import { builtinConnectorsSearchContract } from "@okouai/api-contracts/contracts/connectors";
import { SYSTEM_ORG_ID, VOLUME_ORG_USER_ID } from "@okouai/core/storage-names";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { btree_gin } from "@electric-sql/pglite/contrib/btree_gin";
import { drizzle } from "drizzle-orm/pglite";
import {
  afterAll,
  afterEach,
  onTestFinished,
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
  SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
} from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import { API_TEST_CONNECTOR_CATALOG_ARTIFACT } from "../../../test-fixtures/connector-catalog-artifact";
import { getApiTestMocks, resetApiTestMocks } from "../../../__tests__/mocks";
import { setupApp } from "../../../__tests__/test-helpers";
import { testContext } from "../../../__tests__/test-context";
import { clearMockedEnv, env } from "../../../lib/env";
import { now } from "../../../lib/time";
import { cronConnectorCatalogRoutes } from "../cron-connector-catalog";
import { flushWaitUntilForTest, waitUntil } from "../../context/wait-until";
import { db$, writeDb$ } from "../../external/db";
import type {
  ClerkOrganizationMembership,
  ClerkPaginated,
} from "../../external/clerk";
import { createStore } from "ccstate";
import { runnersRoutes } from "../runners";
import {
  runnersJobClaimContract,
  storedExecutionContextSchema,
} from "@okouai/api-contracts/contracts/runners";
import { withSecretKmsClientForTest } from "../../../lib/secret-kms-client";
import { encryptSecretForTests } from "./helpers/encrypt-secret";
import {
  createDeferredPromise,
  settle,
  settleIncludingAbort,
} from "../../utils";
import { builtinConnectorsRoutes } from "../connectors";
import { createRouteMocks } from "./helpers/route-test";
import { createExecutionStorageObjects } from "../../services/execution-storage.service";
import { mockApiTestConnectorProviderConfiguration } from "../../../test-fixtures/connector-catalog";
import {
  preparePiStableContext,
  piStableContextVariantDigest,
  piStableContextProjectionFromInput,
  piStableContextArtifactDigest,
} from "../../services/pi-stable-context.service";
import { piStableContextInputDigest } from "../../services/pi-stable-context-digest.service";
import { buildAgentIdentityPrompt } from "../../services/agent-identity-prompt.service";
import {
  buildAgentToolsPrompt,
  buildAgentToolsPromptInputs,
} from "../../services/agent-tools-prompt.service";
/* oxlint-disable vitest/warn-todo -- N1 belongs to the later publisher pointer stage. */

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
  assert.equal(engineTraces.length, 5);
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
  return {
    userId,
    orgId,
    agentId,
    runId,
    connectionId,
    connectorSlug: connector.slug,
  };
}

function runtimeArgs(actor: Awaited<ReturnType<typeof ownedMcpRun>>) {
  return {
    scope: { orgId: actor.orgId, userId: actor.userId, agentId: actor.agentId },
    targets: [
      {
        kind: "builtin" as const,
        connectorSlug: actor.connectorSlug,
        sourceId: actor.connectionId,
      },
    ],
  };
}

async function assertEarlyClaimSecretBoundary(
  actor: Awaited<ReturnType<typeof ownedMcpRun>>,
  mode:
    | "failure"
    | "abort"
    | "policy-control"
    | "dual-failure"
    | "joined-abort",
) {
  if (!engine) {
    throw new Error("Missing claim case engine");
  }
  const resumeHash = createHash("sha256").update(actor.runId).digest("hex");
  const ownsResume = mode === "dual-failure" || mode === "joined-abort";
  // Canonical owned Agent grant, not a policy/cache injection. The queued
  // target and request resolve the same real org/user/Agent/account identity.
  await engine.query(
    "INSERT INTO user_connectors (org_id, user_id, agent_id, connector_slug) VALUES ($1, $2, $3, $4)",
    [actor.orgId, actor.userId, actor.agentId, actor.connectorSlug],
  );
  if (ownsResume) {
    await engine.query(
      "INSERT INTO blobs (hash, raw_size, encoded_size, encoding) VALUES ($1, 0, 0, 'identity')",
      [resumeHash],
    );
  }
  const stored = storedExecutionContextSchema.parse({
    storageMounts: [],
    environment: { LEGACY_MASKED: "masking-secret" },
    platformEnvironment: {},
    secretValueEnvironmentKeys: ["retired-key"],
    resumeSession: ownsResume
      ? {
          sessionId: `owned-resume-${actor.runId}`,
          historyRef: { kind: "blob", hash: resumeHash },
        }
      : null,
    networkPolicies: {
      [actor.connectorSlug]: {
        allow: [],
        deny: [],
        ask: [],
        unknownPolicy: "deny",
      },
    },
    encryptedSecrets: encryptSecretForTests(
      JSON.stringify({ LEGACY_MASKED: "masking-secret" }),
    ),
    cliAgentType: "claude-code",
    connectorRuntimeTargets: [
      {
        kind: "builtin",
        connectorSlug: actor.connectorSlug,
        sourceId: actor.connectionId,
      },
    ],
    firewalls: [
      {
        kind: "builtin",
        name: actor.connectorSlug,
        sourceId: actor.connectionId,
      },
    ],
  });
  await engine.query(
    "UPDATE agent_runs SET status = 'pending' WHERE id = $1 AND org_id = $2 AND user_id = $3",
    [actor.runId, actor.orgId, actor.userId],
  );
  await engine.query(
    "INSERT INTO runner_job_queue (run_id, runner_group, execution_context, expires_at) VALUES ($1, 'catalog-n4', $2::jsonb, now() + interval '1 hour')",
    [actor.runId, JSON.stringify(stored)],
  );
  const requestController = new AbortController();
  onTestFinished(() => {
    requestController.abort();
  });
  const requestSignal = AbortSignal.any([
    context.signal,
    requestController.signal,
  ]);
  const original = new Error("Controlled claim secret failure");
  const resumeError = new Error("Controlled owned resume HEAD failure");
  const abortReason = new Error(
    "Controlled abort while resume HEAD is pending",
  );
  abortReason.name = "AbortError";
  const resumeOwner = ownsResume
    ? {
        started: createDeferredPromise<void>(context.signal),
        released: createDeferredPromise<void>(context.signal),
      }
    : null;
  const previousStorage = context.mocks.s3.send.getMockImplementation();
  if (resumeOwner) {
    context.mocks.s3.send.mockImplementation(async (...args: unknown[]) => {
      const command = args[0];
      if (
        command instanceof HeadObjectCommand &&
        command.input.Bucket === env("R2_USER_STORAGES_BUCKET_NAME") &&
        command.input.Key === `blobs/${resumeHash}.blob`
      ) {
        if (!resumeOwner.started.settled()) {
          resumeOwner.started.resolve();
        }
        await resumeOwner.released.promise;
        throw resumeError;
      }
      if (!previousStorage) {
        throw new Error("Unexpected unowned resume storage request");
      }
      return await previousStorage(...args);
    });
  }
  let decryptions = 0;
  statements = [];
  const ownedOutcome = await settleIncludingAbort(
    withSecretKmsClientForTest(
      {
        generateDataKey() {
          return Promise.reject(
            new Error("Claim must not encrypt new secrets"),
          );
        },
        decrypt() {
          decryptions += 1;
          if (mode === "failure") {
            return Promise.reject(original);
          }
          if (mode === "abort") {
            requestController.abort(original);
          }
          return Promise.resolve(
            Buffer.from("0123456789abcdef0123456789abcdef", "utf8"),
          );
        },
      },
      async () => {
        let claimSettled = false;
        const outcome = settleIncludingAbort(
          setupApp({
            context,
            routes: runnersRoutes,
            signal: requestSignal,
            rethrowErrors: true,
          })(runnersJobClaimContract).claim({
            headers: {
              authorization: `Bearer vm0_official_${env("OFFICIAL_RUNNER_SECRET")}`,
            },
            params: { id: actor.runId },
            body: { capabilities: { piModelConfigGenerations: [1, 2, 3, 4] } },
          }),
        ).then((settled) => {
          claimSettled = true;
          if (resumeOwner && !resumeOwner.started.settled()) {
            // Unblock the boundary assertion: an early outcome is a failure,
            // not a hanging deferred or a swallowed claim error.
            resumeOwner.started.resolve();
          }
          return settled;
        });
        if (!resumeOwner) {
          return await outcome;
        }
        // HEAD is a real external boundary. Its controlled rejection is released
        // even when a boundary assertion fails, then the finite claim is joined.
        const boundary = await settleIncludingAbort(async () => {
          await resumeOwner.started.promise;
          if (mode === "joined-abort") {
            requestController.abort(abortReason);
          }
          if (!engine) {
            throw new Error("Missing finite claim case engine");
          }
          await engine.query("SELECT 1 AS claim_boundary_alive");
          expect(
            statements.some((query) => {
              return query.includes('from "connector_catalog"');
            }),
          ).toBeTruthy();
          expect(claimSettled).toBeFalsy();
        });
        if (!resumeOwner.released.settled()) {
          resumeOwner.released.resolve();
        }
        const settled = await outcome;
        if (!boundary.ok) {
          throw boundary.error;
        }
        return settled;
      },
    ),
  );
  if (ownsResume && previousStorage) {
    context.mocks.s3.send.mockImplementation(previousStorage);
  }
  if (!ownedOutcome.ok) {
    throw ownedOutcome.error;
  }
  const result = ownedOutcome.value;
  expect(decryptions).toBe(1);
  if (result.ok) {
    throw new Error(
      "Negative claim ownership probe unexpectedly claimed a job",
    );
  }
  const policyReads = statements.filter((query) => {
    return query.includes('from "connector_catalog"');
  });
  if (mode === "policy-control") {
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toBe(
      "Immutable connector catalog current is missing",
    );
    expect(policyReads).toHaveLength(1);
  } else if (mode === "dual-failure") {
    // Both resume HEAD and policy reject; the original resume error wins.
    expect(result.error).toBe(resumeError);
    expect(policyReads).toHaveLength(1);
  } else if (mode === "joined-abort") {
    // Assembly drains resume/policy; the public claim's final settle(signal)
    // propagates the exact caller abort rather than a policy/storage error.
    expect(result.error).toBe(requestSignal.reason);
    expect(result.error).toBe(abortReason);
    expect(policyReads).toHaveLength(1);
  } else {
    expect(result.error).toBe(
      mode === "failure" ? original : requestSignal.reason,
    );
    expect(policyReads).toStrictEqual([]);
  }
  for (const query of policyReads) {
    expect(query).not.toContain("connector_catalog_active_snapshot");
    expect(query).not.toContain("connector_catalog_runtime_projection");
    expect(query).not.toContain("connector_catalog_compatibility_evaluation");
  }
  expect(
    (
      await engine.query(
        "SELECT status FROM agent_runs WHERE id = $1 AND org_id = $2 AND user_id = $3",
        [actor.runId, actor.orgId, actor.userId],
      )
    ).rows,
  ).toStrictEqual([{ status: "pending" }]);
  expect(
    (
      await engine.query(
        "SELECT run_id FROM runner_job_queue WHERE run_id = $1",
        [actor.runId],
      )
    ).rows,
  ).toStrictEqual([{ run_id: actor.runId }]);
  requestController.abort();
}

async function runtimeSync(actor: Awaited<ReturnType<typeof ownedMcpRun>>) {
  return await createStore().set(
    resolveConnectorRuntimeTargets$,
    runtimeArgs(actor),
    context.signal,
  );
}

async function runtimeDiagnostics(
  actor: Awaited<ReturnType<typeof ownedMcpRun>>,
) {
  return await createStore().set(
    resolveConnectorRuntimeDiagnosticTargets$,
    runtimeArgs(actor),
    context.signal,
  );
}

async function seedNativePiMetadata(
  actor: Awaited<ReturnType<typeof ownedMcpRun>>,
) {
  if (!engine) {
    throw new Error("Missing Pi metadata case engine");
  }
  const customConnectorId = randomUUID();
  // Establish membership through the real authenticated consumer. N4 may
  // already have populated it; never duplicate or overwrite the cache row.
  expect((await mcpDirectory(actor)).status).toBe(200);
  await engine.query(
    "INSERT INTO org_custom_connectors (id, org_id, slug, display_name, created_by, auth_mode, permission_bundle_ref, prefix_templates) VALUES ($1, $2, '_pi_metadata', 'Pi metadata-only', $3, 'none', $4, '[\"https://pi-metadata.example.test/\"]'::jsonb)",
    [
      customConnectorId,
      actor.orgId,
      actor.userId,
      `builtin:${actor.connectorSlug}@1`,
    ],
  );
  await engine.query(
    "INSERT INTO user_custom_connectors (org_id, user_id, agent_id, custom_connector_id) VALUES ($1, $2, $3, $4)",
    [actor.orgId, actor.userId, actor.agentId, customConnectorId],
  );
  return customConnectorId;
}

function nativePiInputs(
  actor: Awaited<ReturnType<typeof ownedMcpRun>>,
  catalog: ImmutableConnectorRuntimeSelection["catalogIdentity"],
  customConnectorId: string,
) {
  const owner = {
    orgId: actor.orgId,
    userId: actor.userId,
    agentId: actor.agentId,
    resourceOwner: { orgId: actor.orgId, userId: actor.userId },
  };
  const promptInputs = buildAgentToolsPromptInputs({
    featureSwitchContext: {
      orgId: actor.orgId,
      userId: actor.userId,
      overrides: {},
    },
    triggerSource: "web",
    cloudBrowserEnabled: false,
  });
  const connectorScope = {
    allowedConnectorSlugs: [],
    allowedCustomConnectorIds: [customConnectorId],
    customConnectorGrants: [{ customConnectorId, permissionNames: [] }],
    customConnectorDefinitions: [
      {
        customConnectorId,
        connectorSlug: "_pi_metadata",
        storageVersion: 1,
        skillStorageVersionId: null,
        isMcp: false,
        permissionBundleRef: `builtin:${actor.connectorSlug}@1`,
      },
    ],
    workflows: [],
  };
  const agentIdentity =
    buildAgentIdentityPrompt({
      id: actor.agentId,
      defaultAgentId: null,
      displayName: null,
      description: null,
      sound: null,
    }) ?? "";
  return {
    owner,
    variantDigest: piStableContextVariantDigest({ native: "metadata-only" }),
    semantic: { promptInputs, connectorScope },
    source: {
      catalog,
      agentIdentityDigest: piStableContextVariantDigest(agentIdentity),
      featurePromptDigest: piStableContextVariantDigest(promptInputs),
      permissionDigest: piStableContextVariantDigest(null),
      connectorScopeDigest: piStableContextVariantDigest(connectorScope),
      validityHorizon: null,
      promptSchemaVersion: 1,
      runtimeSchemaVersion: 1,
    },
    mounts: [],
    persistedStorageMounts: [],
    eligible: true,
    checkedAt: new Date(now()),
    buildPrompt() {
      return {
        agentIdentity,
        executionLimit: "native captured limit",
        tools: buildAgentToolsPrompt(promptInputs),
      };
    },
  };
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
    // Historical JSONB is deliberately old-shaped, with the actual catalog
    // source ID (not a fabricated per-case authority). CAS must retire it too.
    const legacyInput = JSON.stringify({
      source: {
        catalogSourceId: connectorCatalogSource().sourceId,
        catalogIdentity: first.hash,
      },
    });
    // Legally persisted old pending input, not a missing/non-null fixture that
    // already violates the pre-C constraint before CAS reaches it.
    await engine.query(
      "INSERT INTO pi_stable_context_heads (org_id, user_id, agent_id, variant_digest, status, input_digest, input) VALUES ('catalog-lifecycle-org', 'catalog-lifecycle-user', $1, $2, 'pending', $3, $4::jsonb)",
      [
        agentId,
        "a".repeat(64),
        createHash("sha256").update(legacyInput).digest("hex"),
        legacyInput,
      ],
    );
    // The generated migration only permits object-shaped retained dependency
    // facts on a missing head. It does not permit a scalar or worker digest.
    await expect(
      engine.query(
        "INSERT INTO pi_stable_context_heads (org_id, user_id, agent_id, variant_digest, input) VALUES ('catalog-lifecycle-org', 'catalog-lifecycle-user', $1, $2, $3::jsonb)",
        [agentId, "b".repeat(64), JSON.stringify("not-dependency-facts")],
      ),
    ).rejects.toThrow("pi_stable_context_heads_input_check");
    await expect(
      engine.query(
        "INSERT INTO pi_stable_context_heads (org_id, user_id, agent_id, variant_digest, input, input_digest) VALUES ('catalog-lifecycle-org', 'catalog-lifecycle-user', $1, $2, $3::jsonb, $4)",
        [agentId, "b".repeat(64), legacyInput, "c".repeat(64)],
      ),
    ).rejects.toThrow("pi_stable_context_heads_input_check");
    // Unrelated owner: neither catalog-null nor an unsupported schema belongs
    // to this cutover. Persisted legacy negatives remain stored, never served.
    const unrelatedAgent = randomUUID();
    await engine.query(
      "INSERT INTO agents (id, org_id, owner, name) VALUES ($1, 'catalog-unrelated-org', 'catalog-unrelated-user', 'unrelated Pi owner')",
      [unrelatedAgent],
    );
    await engine.query(
      "INSERT INTO pi_stable_context_generations (org_id, agent_id, subject) VALUES ('catalog-unrelated-org', $1, '@agent')",
      [unrelatedAgent],
    );
    const unrelatedInputs = [
      JSON.stringify({ source: { catalog: null } }),
      JSON.stringify({ source: { catalog: { schemaVersion: 2 } } }),
    ];
    for (const [index, input] of unrelatedInputs.entries()) {
      await engine.query(
        "INSERT INTO pi_stable_context_heads (org_id, user_id, agent_id, variant_digest, status, input, input_digest) VALUES ('catalog-unrelated-org', 'catalog-unrelated-user', $1, $2, 'pending', $3::jsonb, $4)",
        [
          unrelatedAgent,
          String(index + 1).repeat(64),
          input,
          createHash("sha256").update(input).digest("hex"),
        ],
      );
    }
    const unrelatedBefore = (
      await engine.query(
        "SELECT generation, status, input_digest FROM pi_stable_context_heads WHERE org_id = 'catalog-unrelated-org' AND agent_id = $1 ORDER BY variant_digest",
        [unrelatedAgent],
      )
    ).rows;
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
          "SELECT generation FROM pi_stable_context_generations WHERE org_id = 'catalog-lifecycle-org' AND agent_id = $1 AND subject = '@agent'",
          [agentId],
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
    // C1 mechanism A: legacy/pointer accept C while immutable current is B.
    // Prepare real B bytes before constructing this divergent fixture. A
    // successful B->C CAS must revoke leased demand and notify only its winner.
    const divergent = release(
      "2099-01-01.divergent",
      "Divergent serving B",
      true,
    );
    await createStore().set(
      prepareImmutableCatalogEntries$,
      {
        artifact: divergent.artifact,
        hash: divergent.hash,
      },
      context.signal,
    );
    await createStore()
      .set(writeDb$)
      .update(connectorCatalog)
      .set(
        immutableCatalogValues(
          divergent.artifact,
          divergent.hash,
          new Date(now()),
        ),
      )
      .where(
        eq(
          connectorCatalog.schemaVersion,
          SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
        ),
      );
    const primaryLease = randomUUID();
    await engine.query(
      "UPDATE pi_stable_context_heads SET status = 'running', input_digest = $1, lease_id = $2, lease_expires_at = now() + interval '1 hour' WHERE org_id = 'catalog-lifecycle-org' AND agent_id = $3 AND user_id = 'catalog-lifecycle-user' AND variant_digest = $4",
      [
        createHash("sha256").update(legacyInput).digest("hex"),
        primaryLease,
        agentId,
        "a".repeat(64),
      ],
    );
    expect(
      (
        await engine.query(
          "SELECT catalog_digest FROM connector_catalog_active_snapshot",
        )
      ).rows,
    ).toStrictEqual([{ catalog_digest: first.hash }]);
    const restoredFromB = await Promise.all([sync(), sync()]);
    expect(
      restoredFromB
        .map((response) => {
          if (response.status !== 200) {
            throw new Error("Divergent mirror cron failed");
          }
          return response.body.outcome;
        })
        .sort(),
    ).toStrictEqual(["accepted", "unchanged"]);
    expect(
      (await engine.query("SELECT hash FROM connector_catalog")).rows,
    ).toStrictEqual([{ hash: first.hash }]);
    expect(
      (
        await engine.query(
          "SELECT generation FROM pi_stable_context_generations WHERE org_id = 'catalog-lifecycle-org' AND agent_id = $1 AND subject = '@agent'",
          [agentId],
        )
      ).rows,
    ).toStrictEqual([{ generation: 3 }]);
    expect(
      (
        await engine.query(
          "SELECT generation, status, input_digest, artifact_digest, lease_id, lease_expires_at FROM pi_stable_context_heads WHERE org_id = 'catalog-lifecycle-org' AND agent_id = $1 AND user_id = 'catalog-lifecycle-user' AND variant_digest = $2",
          [agentId, "a".repeat(64)],
        )
      ).rows,
    ).toStrictEqual([
      {
        generation: 3,
        status: "missing",
        input_digest: null,
        artifact_digest: null,
        lease_id: null,
        lease_expires_at: null,
      },
    ]);
    expect(context.mocks.ably.batchPublish).toHaveBeenCalledTimes(2);

    // C1 mechanism B is distinct: absent mirror restored at already accepted C
    // preserves its existing demand generation and produces no activation.
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
          "SELECT generation FROM pi_stable_context_generations WHERE org_id = 'catalog-lifecycle-org' AND agent_id = $1 AND subject = '@agent'",
          [agentId],
        )
      ).rows,
    ).toStrictEqual([{ generation: 3 }]);
    expect(
      (
        await engine.query(
          "SELECT generation, status FROM pi_stable_context_heads WHERE org_id = 'catalog-lifecycle-org' AND agent_id = $1 AND user_id = 'catalog-lifecycle-user'",
          [agentId],
        )
      ).rows,
    ).toStrictEqual([{ generation: 3, status: "missing" }]);
    expect(context.mocks.ably.batchPublish).toHaveBeenCalledTimes(2);
    expect((await sync()).body).toMatchObject({ outcome: "unchanged" });
    expect(context.mocks.ably.batchPublish).toHaveBeenCalledTimes(2);
    const concurrent = release(
      "2099-01-01.same-baseline",
      "Competing runtime update",
      true,
    );
    const piActor = await ownedMcpRun(first);
    // This second Pi owner has no active Run to notify. Its private heads are
    // tested independently below, not folded into primary owner counts.
    const piCustomId = await seedNativePiMetadata(piActor);
    await engine.query(
      "UPDATE agent_runs SET status = 'cancelled' WHERE id = $1 AND org_id = $2 AND user_id = $3",
      [piActor.runId, piActor.orgId, piActor.userId],
    );
    const piCaptured = await createStore().get(
      immutableConnectorRuntimeSelection({
        requestedConnectorSlugs: [],
        metadataConnectorSlugs: [connector.slug],
      }),
    );
    const piArgs = {
      ...nativePiInputs(piActor, piCaptured.catalogIdentity, piCustomId),
      db: createStore().set(writeDb$),
    };
    serve(concurrent);
    // Genuine competing requests plus the real Pi admission path; PGlite's
    // scheduler still cannot establish PostgreSQL row-lock race acceptance.
    const [left, right, piPrepared] = await Promise.all([
      sync(),
      sync(),
      createStore().get(preparePiStableContext(piArgs, context.signal)),
    ]);
    const competed = [left, right];
    expect(piPrepared.kind).toBe("missing");
    const [piHead] = await createStore()
      .get(db$)
      .select({
        status: piStableContextHeads.status,
        input: piStableContextHeads.input,
        artifactDigest: piStableContextHeads.artifactDigest,
      })
      .from(piStableContextHeads)
      .where(eq(piStableContextHeads.agentId, piActor.agentId));
    if (!piHead?.input) {
      throw new Error("Expected the native Pi demand input");
    }
    expect(piHead.artifactDigest).toBeNull();
    if (piHead.input.source.catalog?.hash === first.hash) {
      expect(piHead.status).toBe("missing");
    } else {
      expect(piHead.input.source.catalog?.hash).toBe(concurrent.hash);
      expect(piHead.status).toBe("pending");
    }
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
          "SELECT generation FROM pi_stable_context_generations WHERE org_id = 'catalog-lifecycle-org' AND agent_id = $1 AND subject = '@agent'",
          [agentId],
        )
      ).rows,
    ).toStrictEqual([{ generation: 4 }]);
    // Preserve the exact gen4/missing primary checkpoint independently of the
    // later rollback cutover (gen5) added after the separate divergent-C1 step.
    expect(
      (
        await engine.query(
          "SELECT generation, status FROM pi_stable_context_heads WHERE org_id = 'catalog-lifecycle-org' AND agent_id = $1 AND user_id = 'catalog-lifecycle-user'",
          [agentId],
        )
      ).rows,
    ).toStrictEqual([{ generation: 4, status: "missing" }]);
    expect(context.mocks.ably.batchPublish).toHaveBeenCalledTimes(3);
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
    // Secondary owner has a leased worker and a distinct ready variant. Their
    // revocation cannot be inferred from the primary owner's missing count.
    const secondaryDigest = piStableContextInputDigest(piHead.input);
    const secondaryLease = randomUUID();
    const projection = piStableContextProjectionFromInput(piHead.input, {
      schemaVersion: 1,
      agentsFiles: [],
      skills: [],
    });
    const secondaryArtifact = piStableContextArtifactDigest(projection);
    await engine.query(
      "INSERT INTO pi_stable_context_artifacts (digest, org_id, user_id, agent_id, projection) VALUES ($1, $2, $3, $4, $5::jsonb)",
      [
        secondaryArtifact,
        piActor.orgId,
        piActor.userId,
        piActor.agentId,
        JSON.stringify(projection),
      ],
    );
    await engine.query(
      "UPDATE pi_stable_context_heads SET status = 'running', input_digest = $1, lease_id = $2, lease_expires_at = now() + interval '1 hour' WHERE org_id = $3 AND user_id = $4 AND agent_id = $5",
      [
        secondaryDigest,
        secondaryLease,
        piActor.orgId,
        piActor.userId,
        piActor.agentId,
      ],
    );
    await engine.query(
      "INSERT INTO pi_stable_context_heads (org_id, user_id, agent_id, variant_digest, generation, agent_generation, user_generation, input, input_digest, status, artifact_digest) SELECT org_id, user_id, agent_id, $1, generation, agent_generation, user_generation, input, input_digest, 'ready', $2 FROM pi_stable_context_heads WHERE org_id = $3 AND user_id = $4 AND agent_id = $5",
      [
        "d".repeat(64),
        secondaryArtifact,
        piActor.orgId,
        piActor.userId,
        piActor.agentId,
      ],
    );
    const secondaryBefore = (
      await engine.query<{
        variant_digest: string;
        generation: number;
        status: string;
        input_digest: string | null;
        artifact_digest: string | null;
        lease_id: string | null;
      }>(
        "SELECT variant_digest, generation, status, input_digest, artifact_digest, lease_id FROM pi_stable_context_heads WHERE org_id = $1 AND user_id = $2 AND agent_id = $3 ORDER BY variant_digest",
        [piActor.orgId, piActor.userId, piActor.agentId],
      )
    ).rows;
    expect(secondaryBefore).toHaveLength(2);
    const secondaryGeneration = (
      await engine.query<{ generation: number }>(
        "SELECT generation FROM pi_stable_context_generations WHERE org_id = $1 AND agent_id = $2 AND subject = '@agent'",
        [piActor.orgId, piActor.agentId],
      )
    ).rows[0]?.generation;
    if (secondaryGeneration === undefined) {
      throw new Error("Missing secondary owner generation");
    }
    expect(secondaryGeneration).toBeGreaterThan(0);
    const next = release(
      "2099-01-01.changed",
      "Changed concurrent catalog",
      true,
    );
    serve(next);
    await engine.exec(
      "ALTER TABLE pi_stable_context_generations ADD CONSTRAINT invalidation_failure CHECK (generation <= 4)",
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
    expect(context.mocks.ably.batchPublish).toHaveBeenCalledTimes(3);
    expect(
      (
        await engine.query(
          "SELECT variant_digest, generation, status, input_digest, artifact_digest, lease_id FROM pi_stable_context_heads WHERE org_id = $1 AND user_id = $2 AND agent_id = $3 ORDER BY variant_digest",
          [piActor.orgId, piActor.userId, piActor.agentId],
        )
      ).rows,
    ).toStrictEqual(secondaryBefore);
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
          "SELECT generation FROM pi_stable_context_generations WHERE org_id = 'catalog-lifecycle-org' AND agent_id = $1 AND subject = '@agent'",
          [agentId],
        )
      ).rows,
    ).toStrictEqual([{ generation: 5 }]);
    expect(context.mocks.ably.batchPublish).toHaveBeenCalledTimes(4);
    expect(
      (
        await engine.query(
          "SELECT generation, status FROM pi_stable_context_heads WHERE org_id = 'catalog-lifecycle-org' AND agent_id = $1 AND user_id = 'catalog-lifecycle-user'",
          [agentId],
        )
      ).rows,
    ).toStrictEqual([{ generation: 5, status: "missing" }]);
    expect(
      (
        await engine.query<{ generation: number }>(
          "SELECT generation FROM pi_stable_context_generations WHERE org_id = $1 AND agent_id = $2 AND subject = '@agent'",
          [piActor.orgId, piActor.agentId],
        )
      ).rows,
    ).toStrictEqual([{ generation: secondaryGeneration + 1 }]);
    expect(
      (
        await engine.query(
          "SELECT status, input_digest, artifact_digest, lease_id, lease_expires_at FROM pi_stable_context_heads WHERE org_id = $1 AND user_id = $2 AND agent_id = $3 ORDER BY variant_digest",
          [piActor.orgId, piActor.userId, piActor.agentId],
        )
      ).rows,
    ).toStrictEqual(
      Array.from({ length: 2 }, () => {
        return {
          status: "missing",
          input_digest: null,
          artifact_digest: null,
          lease_id: null,
          lease_expires_at: null,
        };
      }),
    );
    expect(
      (
        await engine.query(
          "SELECT digest FROM pi_stable_context_artifacts WHERE digest = $1 AND org_id = $2 AND user_id = $3 AND agent_id = $4",
          [secondaryArtifact, piActor.orgId, piActor.userId, piActor.agentId],
        )
      ).rows,
    ).toStrictEqual([{ digest: secondaryArtifact }]);
    expect(
      (
        await engine.query(
          "SELECT variant_digest, generation FROM pi_stable_context_heads WHERE org_id = $1 AND user_id = $2 AND agent_id = $3 ORDER BY variant_digest",
          [piActor.orgId, piActor.userId, piActor.agentId],
        )
      ).rows,
    ).toStrictEqual(
      secondaryBefore.map((head) => {
        return {
          variant_digest: head.variant_digest,
          generation: head.generation + 1,
        };
      }),
    );
    expect(
      (
        await engine.query(
          "SELECT generation, status, input_digest FROM pi_stable_context_heads WHERE org_id = 'catalog-unrelated-org' AND agent_id = $1 ORDER BY variant_digest",
          [unrelatedAgent],
        )
      ).rows,
    ).toStrictEqual(unrelatedBefore);
    expect(
      (
        await engine.query(
          "SELECT generation FROM pi_stable_context_generations WHERE org_id = 'catalog-unrelated-org' AND agent_id = $1 AND subject = '@agent'",
          [unrelatedAgent],
        )
      ).rows,
    ).toStrictEqual([{ generation: 1 }]);
    expect((await sync()).body).toMatchObject({ outcome: "unchanged" });
    expect(context.mocks.ably.batchPublish).toHaveBeenCalledTimes(4);
  });
  it("n4: real MCP and runtime consumers follow hash switches while captured entries retain their hash", async () => {
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
    statements = [];
    for (const runtime of [
      await runtimeSync(actor),
      await runtimeDiagnostics(actor),
    ]) {
      expect(runtime).toMatchObject([
        {
          target: { kind: "builtin", connectorSlug: actor.connectorSlug },
          state: "available",
        },
      ]);
    }
    expect(
      statements.filter((query) => {
        return query.includes("connector_catalog");
      }),
    ).toHaveLength(2);
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
    if (!engine || !binding.database) {
      throw new Error("Missing Pi case database");
    }
    const customConnectorId = await seedNativePiMetadata(actor);
    const piInputs = nativePiInputs(
      actor,
      captured.catalogIdentity,
      customConnectorId,
    );
    statements = [];
    const undeclared = {
      ...piInputs,
      variantDigest: "0".repeat(64),
      source: { ...piInputs.source, catalog: null },
      semantic: {
        ...piInputs.semantic,
        connectorScope: {
          allowedConnectorSlugs: [],
          allowedCustomConnectorIds: [],
          customConnectorGrants: [],
          customConnectorDefinitions: [],
          workflows: [],
        },
      },
    };
    await expect(
      createStore().get(
        preparePiStableContext(
          { ...undeclared, db: createStore().set(writeDb$) },
          context.signal,
        ),
      ),
    ).resolves.toMatchObject({ kind: "missing" });
    expect(
      statements.some((query) => {
        return (
          query.includes('from "connector_catalog"') &&
          /for share\b/u.test(query)
        );
      }),
    ).toBeFalsy();
    await expect(
      createStore()
        .get(db$)
        .select({ id: piStableContextHeads.id })
        .from(piStableContextHeads)
        .where(eq(piStableContextHeads.agentId, actor.agentId)),
    ).resolves.toStrictEqual([]);
    statements = [];
    await createStore().get(
      preparePiStableContext(
        { ...piInputs, db: createStore().set(writeDb$) },
        context.signal,
      ),
    );
    const share = statements.findIndex((query) => {
      return (
        query.includes('from "connector_catalog"') && /for share\b/u.test(query)
      );
    });
    const ownerLock = statements.findIndex((query, index) => {
      return (
        index > share &&
        query.includes('from "org_members_cache"') &&
        /for key share\b/u.test(query)
      );
    });
    const generations = statements.findIndex((query, index) => {
      return (
        index > ownerLock &&
        query.includes('from "pi_stable_context_generations"') &&
        /for update\b/u.test(query)
      );
    });
    expect(share).toBeGreaterThanOrEqual(0);
    expect(ownerLock).toBeGreaterThan(share);
    expect(generations).toBeGreaterThan(ownerLock);
    expect(
      (
        await engine.query(
          "SELECT status, input -> 'source' -> 'catalog' AS catalog, input -> 'semantic' -> 'connectorScope' -> 'customConnectorDefinitions' AS definitions FROM pi_stable_context_heads WHERE agent_id = $1",
          [actor.agentId],
        )
      ).rows,
    ).toMatchObject([
      {
        status: "ready",
        catalog: captured.catalogIdentity,
        definitions: [
          {
            permissionBundleRef: `builtin:${slug}@1`,
            storageVersion: 1,
            isMcp: false,
          },
        ],
      },
    ]);
    serve(next);
    expect((await sync()).body).toMatchObject({ outcome: "accepted" });
    expect((await mcpDirectory(actor)).body).toMatchObject({
      connectors: [
        { displayName: "New MCP catalog", connectionId: actor.connectionId },
      ],
    });
    // A stale canonical caller keeps its normal miss path. Registration captures
    // the new fixed hash, but may not bind the old caller's canonical snapshot.
    await expect(
      createStore().get(
        preparePiStableContext(
          { ...piInputs, db: createStore().set(writeDb$) },
          context.signal,
        ),
      ),
    ).resolves.toMatchObject({ kind: "missing" });
    expect(
      (
        await engine.query(
          "SELECT status, artifact_digest, input -> 'source' -> 'catalog' ->> 'hash' AS hash FROM pi_stable_context_heads WHERE agent_id = $1",
          [actor.agentId],
        )
      ).rows,
    ).toStrictEqual([
      {
        status: "pending",
        artifact_digest: null,
        hash: next.hash,
      },
    ]);
    statements = [];
    await expect(runtimeSync(actor)).resolves.toMatchObject([
      { state: "available" },
    ]);
    expect(
      statements.filter((query) => {
        return query.includes("connector_catalog");
      }),
    ).toHaveLength(1);
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
  it("n5: real MCP and runtime consumers distinguish unknown from missing rows without legacy or R2 fallback", async () => {
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
    expect((await mcpDirectory(actor)).status).toBe(500);
    await expect(runtimeSync(actor)).rejects.toThrow(
      "Immutable connector catalog manifest entry is missing",
    );
    expect((await mcpDirectory(unknownActor)).body).toStrictEqual({
      connectors: [],
    });
    await expect(runtimeSync(unknownActor)).resolves.toStrictEqual([
      {
        target: { kind: "builtin", connectorSlug: unknown },
        state: "absent",
        reason: "connector-unavailable",
      },
    ]);
    // A manifest-listed but malformed immutable payload is also a hard error,
    // not an absent connector or recovery through legacy compatibility bytes.
    await engine.query(
      "INSERT INTO connector_catalog_entries (hash, slug, payload) VALUES ($1, $2, $3::jsonb)",
      [candidate.hash, slug, JSON.stringify({ slug, authMethods: null })],
    );
    expect((await mcpDirectory(actor)).status).toBe(500);
    await expect(runtimeSync(actor)).rejects.toThrow(TypeError);
    await engine.query(
      "DELETE FROM connector_catalog_entries WHERE hash = $1 AND slug = $2",
      [candidate.hash, slug],
    );
    await engine.exec("DELETE FROM connector_catalog");
    expect((await mcpDirectory(unknownActor)).status).toBe(500);
    await expect(runtimeDiagnostics(unknownActor)).rejects.toThrow(
      "Immutable connector catalog current is missing",
    );
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
    // Preserve seven missing-row/current reads plus the two malformed-payload
    // reads; none may recover from still-present legacy data.
    expect(catalogReads).toHaveLength(9);
    for (const query of catalogReads) {
      expect(query).not.toContain("connector_catalog_active_snapshot");
      expect(query).not.toContain("connector_catalog_runtime_projection");
      expect(query).not.toContain("connector_catalog_compatibility_evaluation");
    }
    // C5: missing current makes a premature refresh reject, while these real
    // claim requests fail/abort at the external secret boundary. Refresh must
    // never start; no timer, pause hook, internal command mock or extra engine.
    await assertEarlyClaimSecretBoundary(actor, "failure");
    const abortActor = await ownedMcpRun(candidate);
    await assertEarlyClaimSecretBoundary(abortActor, "abort");
    const controlActor = await ownedMcpRun(candidate);
    await assertEarlyClaimSecretBoundary(controlActor, "policy-control");
    const dualFailureActor = await ownedMcpRun(candidate);
    await assertEarlyClaimSecretBoundary(dualFailureActor, "dual-failure");
    const joinedAbortActor = await ownedMcpRun(candidate);
    await assertEarlyClaimSecretBoundary(joinedAbortActor, "joined-abort");
  });
});
