import { cronPruneStoragePresignedUrlsContract } from "@okouai/api-contracts/contracts/cron";
import type {
  TestSystemStoragePresignedUrlCacheStateActionBody,
  TestSystemStoragePresignedUrlCacheStateActionResponse,
} from "@okouai/api-contracts/contracts/test-system-storage-presigned-url-cache-state";
import {
  getCustomConnectorSkillStorageName,
  getCustomSkillStorageName,
  SYSTEM_ORG_ID,
  VOLUME_ORG_USER_ID,
} from "@okouai/core/storage-names";
import { testWorkflowSkillStoragePresignedUrlCacheStateContract } from "@okouai/api-contracts/contracts/test-workflow-skill-storage-presigned-url-cache-state";
import { createHash, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createAppWithRoutes } from "../../../app-factory-core";
import { mockEnv } from "../../../lib/env";
import { mockNow, nowDate } from "../../../lib/time";
import { readStorageS3PrefixFixture } from "../../../test-fixtures/storage";
import { cronPruneStoragePresignedUrlsRoutes } from "../cron-prune-storage-presigned-urls";
import { testSystemStoragePresignedUrlCacheStateRoutes } from "../test-system-storage-presigned-url-cache-state";
import { testWorkflowSkillStoragePresignedUrlCacheStateRoutes } from "../test-workflow-skill-storage-presigned-url-cache-state";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import {
  createRunsApi,
  expectCanonicalStorageManifest,
} from "./helpers/api-bdd-runs";
import { storageTextFile } from "./helpers/api-bdd-storage-files";
import { createStoragesBddApi } from "./helpers/api-bdd-storages";

const context = testContext({ connectorCatalog: true });
const BUCKET = "test-user-storages";
const CACHE_TTL_SECONDS = 2 * 24 * 60 * 60;

interface CacheRow {
  readonly cache_key: string;
  readonly bucket: string;
  readonly object_key: string;
  readonly storage_version_id: string;
  readonly public_endpoint: boolean;
  readonly ttl_seconds: number;
  readonly presigned_url: string;
  readonly expires_at: string;
  readonly refresh_after: string;
  readonly last_requested_at: string;
}

interface CacheRowSnapshot {
  readonly cache_key: string;
  readonly bucket: string;
  readonly object_key: string;
  readonly storage_version_id: string;
  readonly public_endpoint: boolean;
  readonly ttl_seconds: number;
  readonly presigned_url: string;
}

interface StorageState {
  readonly s3_prefix: string;
  readonly size: number;
  readonly file_count: number;
  readonly head_version_id: string | null;
}

interface OwnedSystemStorageFixture {
  readonly storageId: string;
  readonly storageName: string;
  readonly s3Prefix: string;
  readonly mountPath: string;
}

interface ClaimedStorageMount {
  readonly name: string;
  readonly mountPath: string;
  readonly versionId: string;
  readonly archiveSize: number;
  readonly archiveUrl: string;
}

function stateRequest(
  body: TestSystemStoragePresignedUrlCacheStateActionBody,
): Promise<Response> {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: testSystemStoragePresignedUrlCacheStateRoutes,
  });
  return Promise.resolve(
    app.request("/api/test/system-storage-presigned-url-cache-state/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function stateAction(
  body: TestSystemStoragePresignedUrlCacheStateActionBody,
): Promise<TestSystemStoragePresignedUrlCacheStateActionResponse> {
  const response = await stateRequest(body);
  if (!response.ok) {
    throw new Error(`Cache state action ${body.action} failed`);
  }
  return (await response.json()) as TestSystemStoragePresignedUrlCacheStateActionResponse;
}

/**
 * Every run mounts the seed system skills from the system organization. The
 * request-owned resolution points one seed skill at the synthetic storage.
 */
const SYSTEM_SKILL = "gen";
const SYSTEM_SKILL_MOUNT_PATH = `/home/user/.claude/skills/${SYSTEM_SKILL}`;

function createOwnedSystemStorageFixture(
  label: string,
): OwnedSystemStorageFixture {
  const storageId = randomUUID();
  const suffix = storageId.replaceAll("-", "");
  return {
    storageId,
    storageName: `system-cache-${label}-${suffix}`,
    s3Prefix: `${SYSTEM_ORG_ID}/${storageId}`,
    mountPath: SYSTEM_SKILL_MOUNT_PATH,
  };
}

function createVersionId(label: string): string {
  return createHash("sha256").update(`${label}:${randomUUID()}`).digest("hex");
}

function storageVersionKey(
  fixture: OwnedSystemStorageFixture,
  versionId: string,
): string {
  return `${fixture.s3Prefix}/${versionId}`;
}

function storageArchiveKey(
  fixture: OwnedSystemStorageFixture,
  versionId: string,
): string {
  return `${storageVersionKey(fixture, versionId)}/archive.tar.gz`;
}

async function claimOwnedStorage(
  fixture: OwnedSystemStorageFixture,
): Promise<void> {
  await stateAction({
    action: "claim-owned-storages",
    storages: [
      {
        storage_id: fixture.storageId,
        org_id: SYSTEM_ORG_ID,
        user_id: VOLUME_ORG_USER_ID,
        storage_name: fixture.storageName,
        s3_prefix: fixture.s3Prefix,
      },
    ],
  });
}

async function cleanupOwnedStorage(
  fixture: OwnedSystemStorageFixture,
): Promise<void> {
  await stateAction({
    action: "cleanup-owned-storage-cache",
    storage_id: fixture.storageId,
  });
  await stateAction({
    action: "cleanup-owned-storages",
    storage_ids: [fixture.storageId],
  });
}

function registerOwnedStorageCleanup(fixture: OwnedSystemStorageFixture): void {
  onTestFinished(async () => {
    await cleanupOwnedStorage(fixture);
  });
}

async function readOwnedStorageState(
  fixture: OwnedSystemStorageFixture,
): Promise<StorageState | null> {
  const response = await stateAction({
    action: "read-owned-storage-state",
    storage_id: fixture.storageId,
  });
  return response.storage_state ?? null;
}

async function seedOwnedStorageVersion(args: {
  readonly fixture: OwnedSystemStorageFixture;
  readonly versionId: string;
  readonly archiveSize: number;
}): Promise<void> {
  await stateAction({
    action: "seed-owned-storage-version",
    storage_id: args.fixture.storageId,
    version_id: args.versionId,
    s3_key: storageVersionKey(args.fixture, args.versionId),
    archive_size: args.archiveSize,
  });
}

async function readOwnedStorageCache(
  fixture: OwnedSystemStorageFixture,
): Promise<readonly CacheRow[]> {
  const response = await stateAction({
    action: "read-owned-storage-cache",
    storage_id: fixture.storageId,
  });
  return response.rows ?? [];
}

async function seedOwnedStorageCacheRow(args: {
  readonly fixture: OwnedSystemStorageFixture;
  readonly versionId: string;
  readonly presignedUrl: string;
  readonly expiresAt: Date;
  readonly refreshAfter: Date;
  readonly lastRequestedAt?: Date;
}): Promise<void> {
  await stateAction({
    action: "seed-owned-storage-cache-row",
    storage_id: args.fixture.storageId,
    storage_version_id: args.versionId,
    bucket: BUCKET,
    public_endpoint: true,
    ttl_seconds: CACHE_TTL_SECONDS,
    presigned_url: args.presignedUrl,
    expires_at: args.expiresAt.toISOString(),
    refresh_after: args.refreshAfter.toISOString(),
    ...(args.lastRequestedAt
      ? { last_requested_at: args.lastRequestedAt.toISOString() }
      : {}),
  });
}

async function pruneOwnedStorageCache(
  fixture: OwnedSystemStorageFixture,
): Promise<{
  readonly pruned: number;
}> {
  const response = await stateAction({
    action: "prune-owned-storage-cache",
    storage_id: fixture.storageId,
  });
  if (!response.cache_prune) {
    throw new Error("Owned system storage cache prune result is missing");
  }
  return response.cache_prune;
}

function cacheKey(objectKey: string, storageVersionId: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "system-storage-url-v1",
        BUCKET,
        objectKey,
        storageVersionId,
        "public",
        CACHE_TTL_SECONDS,
      ]),
    )
    .digest("hex");
}

function cacheRowSnapshot(row: CacheRow): CacheRowSnapshot {
  return {
    cache_key: row.cache_key,
    bucket: row.bucket,
    object_key: row.object_key,
    storage_version_id: row.storage_version_id,
    public_endpoint: row.public_endpoint,
    ttl_seconds: row.ttl_seconds,
    presigned_url: row.presigned_url,
  };
}

function expectedCacheRow(args: {
  readonly fixture: OwnedSystemStorageFixture;
  readonly versionId: string;
  readonly presignedUrl: string;
}): CacheRowSnapshot {
  const objectKey = storageArchiveKey(args.fixture, args.versionId);
  return {
    cache_key: cacheKey(objectKey, args.versionId),
    bucket: BUCKET,
    object_key: objectKey,
    storage_version_id: args.versionId,
    public_endpoint: true,
    ttl_seconds: CACHE_TTL_SECONDS,
    presigned_url: args.presignedUrl,
  };
}

function sortedCacheSnapshots(
  rows: readonly CacheRow[],
): readonly CacheRowSnapshot[] {
  return rows.map(cacheRowSnapshot).sort((left, right) => {
    return left.object_key.localeCompare(right.object_key);
  });
}

async function entitledDirectRunActor(): Promise<{
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly runnerGroup: string;
}> {
  const bdd = createBddApi(context);
  const api = createRunsApi(context);
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  const runnerGroup = api.configureRunnerGroup();
  await api.grantProEntitlement(actor);
  // The Claude Code route mounts skills under /home/user/.claude/skills.
  await api.ensurePersonalSubscriptionModel(actor, {
    model: "claude-fable-5-1",
  });
  const agent = await bdd.createAgent(actor, {
    displayName: "System storage cache agent",
    visibility: "private",
  });
  return { actor, agentId: agent.agentId, runnerGroup };
}

async function createAndClaimOwnedSystemStorage(args: {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly runnerGroup: string;
  readonly fixture: OwnedSystemStorageFixture;
  readonly prompt: string;
}): Promise<{
  readonly mount: ClaimedStorageMount;
}> {
  const api = createRunsApi(context, {
    [SYSTEM_SKILL]: args.fixture.storageName,
  });
  const run = await api.createThreadRun(args.actor, {
    agentId: args.agentId,
    prompt: args.prompt,
  });
  onTestFinished(async () => {
    await api.requestCancelRun(args.actor, run.runId, [200, 404]);
  });
  await api.heartbeatRunner(args.runnerGroup);
  const claim = await api.claimRunnerJob(run.runId);
  const mounts =
    expectCanonicalStorageManifest(claim.storageManifest)?.storageMounts.filter(
      (storage) => {
        return storage.name === args.fixture.storageName;
      },
    ) ?? [];
  if (mounts.length !== 1) {
    throw new Error("Expected one owned system storage mount");
  }
  const mount = mounts[0];
  if (!mount?.archiveUrl || mount.archiveSize === undefined) {
    throw new Error("Owned system storage mount is incomplete");
  }
  await api.requestCancelRun(args.actor, run.runId, [200]);
  return {
    mount: {
      name: mount.name,
      mountPath: mount.mountPath,
      versionId: mount.versionId,
      archiveSize: mount.archiveSize,
      archiveUrl: mount.archiveUrl,
    },
  };
}

function expectedPresignedUrl(objectKey: string, count: number): string {
  return `https://r2.example.com/${encodeURIComponent(objectKey)}?sig=${count}`;
}

function mockUniquePresignedUrls(): (objectKey: string) => number {
  const counts = new Map<string, number>();
  context.mocks.s3.getSignedUrl.mockImplementation(
    (_client: unknown, command: unknown) => {
      const input = (command as { readonly input?: { readonly Key?: string } })
        .input;
      const objectKey = input?.Key ?? "unknown";
      const count = (counts.get(objectKey) ?? 0) + 1;
      counts.set(objectKey, count);
      return Promise.resolve(expectedPresignedUrl(objectKey, count));
    },
  );
  return (objectKey: string) => {
    return counts.get(objectKey) ?? 0;
  };
}

beforeEach(() => {
  mockEnv("R2_USER_STORAGES_BUCKET_NAME", BUCKET);
});

describe("system storage presigned URL cache", () => {
  it.each([undefined, "Bearer wrong"])(
    "rejects cache pruning with invalid authorization %s",
    async (authorization) => {
      mockEnv("CRON_SECRET", "test-storage-cache-cron-secret");
      const client = setupApp({
        context,
        routes: cronPruneStoragePresignedUrlsRoutes,
      })(cronPruneStoragePresignedUrlsContract);
      const response = await accept(
        client.prune({ headers: authorization ? { authorization } : {} }),
        [401],
      );
      expect(response.body.error.code).toBe("UNAUTHORIZED");
    },
  );

  it("reuses one exact cached URL for a synthetic system storage", async () => {
    const fixture = createOwnedSystemStorageFixture("reuse");
    const versionId = createVersionId("reuse");
    await claimOwnedStorage(fixture);
    registerOwnedStorageCleanup(fixture);
    await seedOwnedStorageVersion({
      fixture,
      versionId,
      archiveSize: 1024,
    });
    await expect(readOwnedStorageState(fixture)).resolves.toStrictEqual({
      s3_prefix: fixture.s3Prefix,
      size: 1,
      file_count: 1,
      head_version_id: versionId,
    });

    const runFixture = await entitledDirectRunActor();
    const signedCount = mockUniquePresignedUrls();
    const objectKey = storageArchiveKey(fixture, versionId);
    const archiveUrl = expectedPresignedUrl(objectKey, 1);
    const expectedMount: ClaimedStorageMount = {
      name: fixture.storageName,
      mountPath: fixture.mountPath,
      versionId,
      archiveSize: 1024,
      archiveUrl,
    };

    await seedOwnedStorageCacheRow({
      fixture,
      versionId,
      presignedUrl: archiveUrl,
      expiresAt: new Date(nowDate().getTime() + 2 * 24 * 60 * 60 * 1000),
      refreshAfter: new Date(nowDate().getTime() + 24 * 60 * 60 * 1000),
    });
    const first = await createAndClaimOwnedSystemStorage({
      ...runFixture,
      fixture,
      prompt: "use the owned system storage URL cache",
    });
    expect(first.mount).toStrictEqual(expectedMount);
    expect(signedCount(objectKey)).toBe(0);
    expect(
      sortedCacheSnapshots(await readOwnedStorageCache(fixture)),
    ).toStrictEqual([
      expectedCacheRow({ fixture, versionId, presignedUrl: archiveUrl }),
    ]);

    const second = await createAndClaimOwnedSystemStorage({
      ...runFixture,
      fixture,
      prompt: "reuse the owned system storage URL cache",
    });
    expect(second.mount).toStrictEqual(expectedMount);
    expect(signedCount(objectKey)).toBe(0);
    expect(
      sortedCacheSnapshots(await readOwnedStorageCache(fixture)),
    ).toStrictEqual([
      expectedCacheRow({ fixture, versionId, presignedUrl: archiveUrl }),
    ]);
  });

  it.each([
    { remainingMs: 4 * 60 * 60 * 1000 - 1, refresh: true },
    { remainingMs: 4 * 60 * 60 * 1000, refresh: false },
    { remainingMs: 4 * 60 * 60 * 1000 + 1, refresh: false },
  ])(
    "enforces the four-hour system archive margin at $remainingMs ms remaining",
    async ({ remainingMs, refresh }) => {
      const fixture = createOwnedSystemStorageFixture("lifetime-margin");
      const versionId = createVersionId("lifetime-margin");
      await claimOwnedStorage(fixture);
      registerOwnedStorageCleanup(fixture);
      await seedOwnedStorageVersion({ fixture, versionId, archiveSize: 1024 });
      const runFixture = await entitledDirectRunActor();
      mockUniquePresignedUrls();
      const issuedAt = nowDate();
      mockNow(issuedAt);
      const cachedUrl = `https://r2.example.com/cached-${fixture.storageId}`;
      // Only signing infrastructure controls a cached URL's expiration; no
      // production API lets a caller choose it. Seed this owned deadline to
      // test the Runner-visible boundary without aging unrelated run leases.
      await seedOwnedStorageCacheRow({
        fixture,
        versionId,
        presignedUrl: cachedUrl,
        expiresAt: new Date(issuedAt.getTime() + remainingMs),
        refreshAfter: new Date(issuedAt.getTime() + remainingMs),
      });

      const first = await createAndClaimOwnedSystemStorage({
        ...runFixture,
        fixture,
        prompt: "select a cached system archive near the lifetime boundary",
      });
      const objectKey = storageArchiveKey(fixture, versionId);
      expect(first.mount.archiveUrl).toBe(
        refresh ? expectedPresignedUrl(objectKey, 1) : cachedUrl,
      );
      if (refresh) {
        expect(context.mocks.s3.getSignedUrl).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            input: expect.objectContaining({ Key: objectKey }),
          }),
          expect.objectContaining({ expiresIn: CACHE_TTL_SECONDS }),
        );
      }
      await flushWaitUntilForTest();
      const second = await createAndClaimOwnedSystemStorage({
        ...runFixture,
        fixture,
        prompt: "reuse the selected system archive URL",
      });
      expect(second.mount.archiveUrl).toBe(first.mount.archiveUrl);
    },
  );

  it("preserves a 52-mount manifest across mixed-scope cache reuse", async () => {
    const fixture = createOwnedSystemStorageFixture("mixed-batch");
    const versionId = createVersionId("mixed-batch");
    await claimOwnedStorage(fixture);
    registerOwnedStorageCleanup(fixture);
    await seedOwnedStorageVersion({ fixture, versionId, archiveSize: 1024 });

    const runFixture = await entitledDirectRunActor();
    const { actor } = runFixture;
    if (!actor.orgId) {
      throw new Error("Expected an organization-scoped cache actor");
    }
    const storages = createStoragesBddApi(context);
    storages.mockStorageObjectsExist(2048);
    // 50 Agent workflow skills (workflow_skill_storage scope), one custom
    // connector skill (readonly_storage scope) and the seed system skill
    // (system_storage scope) make 52 mounts across the three cache scopes.
    const misc = createMiscRoutesApi(context);
    const storageNames: string[] = [];
    const workflowMountPaths = new Map<string, string>();
    for (let index = 0; index < 50; index += 1) {
      const workflowName = `mixed-batch-${String(index)}-${randomUUID().slice(0, 8)}`;
      const workflow = await misc.createWorkflow(
        actor,
        runFixture.agentId,
        workflowName,
        { content: `# Mixed batch ${String(index)}\nUse for cache tests.` },
        [201],
      );
      if (workflow.status !== 201) {
        throw new Error("Expected workflow creation to succeed");
      }
      storageNames.push(getCustomSkillStorageName(workflow.body.id));
      workflowMountPaths.set(
        getCustomSkillStorageName(workflow.body.id),
        `/home/user/.claude/skills/${workflowName}`,
      );
    }
    const connectors = createConnectorBddApi(context);
    const custom = await connectors.createCustomConnector(actor, {
      displayName: "Mixed batch connector",
      prefixTemplates: [
        `https://mixed-batch-${randomUUID().slice(0, 8)}.example.test/api/`,
      ],
      fields: [
        { key: "secret", label: "API token", kind: "secret", required: true },
      ],
      headerInjections: [
        { name: "Authorization", valueTemplate: "Bearer {{secrets.secret}}" },
      ],
      queryInjections: [],
      authMode: "manual",
      skillMarkdown: "Use the mixed batch connector.",
    });
    onTestFinished(async () => {
      await connectors.deleteCustomConnector(actor, custom.id);
    });
    await connectors.updateAgentCustomConnectors(actor, runFixture.agentId, [
      custom.id,
    ]);
    const readOnlyStorageName = getCustomConnectorSkillStorageName(custom.id);
    // Every non-system archive key, by Storage name: org-owned skills live
    // under the organization volume user.
    const objectKeyPrefixes = new Map<string, string>();
    for (const name of [...storageNames, readOnlyStorageName]) {
      objectKeyPrefixes.set(
        name,
        await readStorageS3PrefixFixture({
          orgId: actor.orgId,
          userId: VOLUME_ORG_USER_ID,
          name,
        }),
      );
    }
    onTestFinished(async () => {
      for (const [name, prefix] of objectKeyPrefixes) {
        await accept(
          setupApp({
            context,
            routes: testWorkflowSkillStoragePresignedUrlCacheStateRoutes,
          })(testWorkflowSkillStoragePresignedUrlCacheStateContract).action({
            body: {
              action: "cleanup",
              object_key_prefix: prefix,
              scope:
                name === readOnlyStorageName
                  ? "readonly_storage"
                  : "workflow_skill_storage",
            },
          }),
          [200],
        );
      }
    });
    const systemObjectKey = storageArchiveKey(fixture, versionId);
    const signedCount = mockUniquePresignedUrls();
    await seedOwnedStorageCacheRow({
      fixture,
      versionId,
      presignedUrl: expectedPresignedUrl(systemObjectKey, 1),
      expiresAt: new Date(nowDate().getTime() + 2 * 24 * 60 * 60 * 1000),
      refreshAfter: new Date(nowDate().getTime() + 24 * 60 * 60 * 1000),
    });
    const api = createRunsApi(context, {
      [SYSTEM_SKILL]: fixture.storageName,
    });
    const createAndClaim = async (prompt: string) => {
      const run = await api.createThreadRun(actor, {
        agentId: runFixture.agentId,
        prompt,
      });
      onTestFinished(async () => {
        await api.requestCancelRun(actor, run.runId, [200, 404]);
      });
      await api.heartbeatRunner(runFixture.runnerGroup);
      const claim = await api.claimRunnerJob(run.runId);
      // The post-commit cache write completes before the run is cancelled.
      await flushWaitUntilForTest();
      const mounts =
        expectCanonicalStorageManifest(
          claim.storageManifest,
        )?.storageMounts.filter((mount) => {
          return (
            objectKeyPrefixes.has(mount.name) ||
            mount.name === fixture.storageName
          );
        }) ?? [];
      await api.requestCancelRun(actor, run.runId, [200]);
      return mounts
        .map((mount) => {
          return {
            name: mount.name,
            mountPath: mount.mountPath,
            versionId: mount.versionId,
            archiveUrl: mount.archiveUrl,
          };
        })
        .sort((left, right) => {
          return left.name.localeCompare(right.name);
        });
    };

    // The first run signs each workflow and read-only archive once and its
    // post-commit write caches the exact URLs; the system row is pre-cached.
    const warmed = await createAndClaim(
      "warm the mixed-scope storage URL cache",
    );
    expect(warmed).toHaveLength(52);
    const objectKeys = warmed.flatMap((mount) => {
      const prefix = objectKeyPrefixes.get(mount.name);
      return prefix ? [`${prefix}/${mount.versionId}/archive.tar.gz`] : [];
    });
    expect(objectKeys).toHaveLength(51);
    const expected = warmed.map((mount) => {
      const prefix = objectKeyPrefixes.get(mount.name);
      return {
        ...mount,
        archiveUrl: prefix
          ? expectedPresignedUrl(
              `${prefix}/${mount.versionId}/archive.tar.gz`,
              1,
            )
          : expectedPresignedUrl(systemObjectKey, 1),
      };
    });
    expect(warmed).toStrictEqual(expected);
    // Workflow skills mount exactly at their slug, the connector skill and
    // the seed system skill at their skill directories.
    expect(
      warmed
        .filter((mount) => {
          return workflowMountPaths.has(mount.name);
        })
        .map((mount) => {
          return mount.mountPath;
        }),
    ).toStrictEqual(
      warmed
        .filter((mount) => {
          return workflowMountPaths.has(mount.name);
        })
        .map((mount) => {
          return workflowMountPaths.get(mount.name);
        }),
    );
    expect(
      new Set(
        warmed.map((mount) => {
          return mount.mountPath;
        }),
      ).size,
    ).toBe(52);
    for (const mount of warmed) {
      expect(mount.mountPath).toMatch(
        /^\/home\/user\/\.claude\/skills\/[^/]+$/,
      );
    }
    expect(
      warmed.find((mount) => {
        return mount.name === fixture.storageName;
      })?.mountPath,
    ).toBe(SYSTEM_SKILL_MOUNT_PATH);
    expect(
      objectKeys.map((objectKey) => {
        return signedCount(objectKey);
      }),
    ).toStrictEqual(
      objectKeys.map(() => {
        return 1;
      }),
    );
    expect(signedCount(systemObjectKey)).toBe(0);

    // Every later run hits the cache in all three scopes: the exact cached
    // URLs return and nothing is signed again.
    for (const prompt of [
      "use the mixed-scope storage URL cache",
      "reuse the mixed-scope storage URL cache",
    ]) {
      await expect(createAndClaim(prompt)).resolves.toStrictEqual(expected);
    }
    expect(
      objectKeys.map((objectKey) => {
        return signedCount(objectKey);
      }),
    ).toStrictEqual(
      objectKeys.map(() => {
        return 1;
      }),
    );
    expect(signedCount(systemObjectKey)).toBe(0);
  });

  it("refreshes a hard-expired row with a new exact URL", async () => {
    const fixture = createOwnedSystemStorageFixture("hard-expired");
    const versionId = createVersionId("hard-expired");
    await claimOwnedStorage(fixture);
    registerOwnedStorageCleanup(fixture);
    await seedOwnedStorageVersion({ fixture, versionId, archiveSize: 1024 });
    await seedOwnedStorageCacheRow({
      fixture,
      versionId,
      presignedUrl: "https://r2.example.com/hard-expired",
      expiresAt: new Date(nowDate().getTime() - 60_000),
      refreshAfter: new Date(nowDate().getTime() - 60_000),
    });
    const runFixture = await entitledDirectRunActor();
    const signedCount = mockUniquePresignedUrls();
    const objectKey = storageArchiveKey(fixture, versionId);

    const refreshed = await createAndClaimOwnedSystemStorage({
      ...runFixture,
      fixture,
      prompt: "refresh the hard-expired owned system storage URL",
    });

    expect(refreshed.mount.archiveUrl).toBe(expectedPresignedUrl(objectKey, 1));
    expect(signedCount(objectKey)).toBe(1);
  });

  it("prefers owned system storage and falls back to the primary organization", async () => {
    const storages = createStoragesBddApi(context);
    const runFixture = await entitledDirectRunActor();
    const fixture = createOwnedSystemStorageFixture("fallback");
    const versionId = createVersionId("system-fallback");
    await claimOwnedStorage(fixture);
    registerOwnedStorageCleanup(fixture);
    await seedOwnedStorageVersion({
      fixture,
      versionId,
      archiveSize: 1024,
    });

    storages.mockStorageObjectsExist(2048);
    const primaryFile = storageTextFile(
      "primary.txt",
      `primary fallback ${randomUUID()}`,
    );
    const primary = await storages.prepareStorage(runFixture.actor, {
      storageName: fixture.storageName,
      storageOwner: "organization",
      files: [primaryFile],
    });
    await storages.commitStorage(runFixture.actor, {
      storageName: fixture.storageName,
      storageOwner: "organization",
      versionId: primary.versionId,
      files: [primaryFile],
    });
    if (!runFixture.actor.orgId) {
      throw new Error("Expected an organization-scoped cache actor");
    }
    const primaryPrefix = await readStorageS3PrefixFixture({
      orgId: runFixture.actor.orgId,
      userId: VOLUME_ORG_USER_ID,
      name: fixture.storageName,
    });
    const signedCount = mockUniquePresignedUrls();
    const systemObjectKey = storageArchiveKey(fixture, versionId);
    const systemArchiveUrl = expectedPresignedUrl(systemObjectKey, 1);
    await seedOwnedStorageCacheRow({
      fixture,
      versionId,
      presignedUrl: systemArchiveUrl,
      expiresAt: new Date(nowDate().getTime() + 2 * 24 * 60 * 60 * 1000),
      refreshAfter: new Date(nowDate().getTime() + 24 * 60 * 60 * 1000),
    });

    const systemRun = await createAndClaimOwnedSystemStorage({
      ...runFixture,
      fixture,
      prompt: "prefer the owned system storage candidate",
    });
    expect(systemRun.mount).toStrictEqual({
      name: fixture.storageName,
      mountPath: fixture.mountPath,
      versionId,
      archiveSize: 1024,
      archiveUrl: systemArchiveUrl,
    });
    expect(signedCount(systemObjectKey)).toBe(0);

    await stateAction({
      action: "cleanup-owned-storages",
      storage_ids: [fixture.storageId],
    });
    await claimOwnedStorage(fixture);
    await expect(readOwnedStorageState(fixture)).resolves.toStrictEqual({
      s3_prefix: fixture.s3Prefix,
      size: 0,
      file_count: 0,
      head_version_id: null,
    });

    const primaryObjectKey = `${primaryPrefix}/${primary.versionId}/archive.tar.gz`;
    const fallbackRun = await createAndClaimOwnedSystemStorage({
      ...runFixture,
      fixture,
      prompt: "fall back to the primary storage candidate",
    });
    expect(fallbackRun.mount).toStrictEqual({
      name: fixture.storageName,
      mountPath: fixture.mountPath,
      versionId: primary.versionId,
      archiveSize: 2048,
      archiveUrl: expectedPresignedUrl(primaryObjectKey, 1),
    });
    expect(signedCount(primaryObjectKey)).toBe(1);
    expect(
      sortedCacheSnapshots(await readOwnedStorageCache(fixture)),
    ).toStrictEqual([
      expectedCacheRow({
        fixture,
        versionId,
        presignedUrl: systemArchiveUrl,
      }),
    ]);
  });

  it("prunes expired owned cache rows", async () => {
    const fixture = createOwnedSystemStorageFixture("cron-prune");
    await claimOwnedStorage(fixture);
    registerOwnedStorageCleanup(fixture);
    mockUniquePresignedUrls();
    const now = nowDate();
    const expiredAt = new Date(now.getTime() - 60 * 60 * 1000);
    const futureExpiresAt = new Date(now.getTime() + 60 * 60 * 1000);
    const refreshAfter = new Date(now.getTime() - 60 * 1000);
    const inactiveRequestedAt = new Date(now.getTime() - 48 * 60 * 60 * 1000);

    for (let index = 0; index < 2; index += 1) {
      const versionId = createVersionId(`cron-prune-${index}`);
      await seedOwnedStorageVersion({
        fixture,
        versionId,
        archiveSize: 300 + index,
      });
      await seedOwnedStorageCacheRow({
        fixture,
        versionId,
        presignedUrl: `https://r2.example.com/expired-inactive-${index}`,
        expiresAt: expiredAt,
        refreshAfter,
        lastRequestedAt: inactiveRequestedAt,
      });
    }

    const inactiveFreshVersionId = createVersionId("cron-prune-fresh");
    await seedOwnedStorageVersion({
      fixture,
      versionId: inactiveFreshVersionId,
      archiveSize: 399,
    });
    await seedOwnedStorageCacheRow({
      fixture,
      versionId: inactiveFreshVersionId,
      presignedUrl: "https://r2.example.com/fresh-inactive",
      expiresAt: futureExpiresAt,
      refreshAfter,
      lastRequestedAt: inactiveRequestedAt,
    });

    await expect(pruneOwnedStorageCache(fixture)).resolves.toStrictEqual({
      pruned: 2,
    });
    expect(
      sortedCacheSnapshots(await readOwnedStorageCache(fixture)),
    ).toStrictEqual([
      expectedCacheRow({
        fixture,
        versionId: inactiveFreshVersionId,
        presignedUrl: "https://r2.example.com/fresh-inactive",
      }),
    ]);
    await expect(readOwnedStorageState(fixture)).resolves.toStrictEqual({
      s3_prefix: fixture.s3Prefix,
      size: 1,
      file_count: 1,
      head_version_id: inactiveFreshVersionId,
    });
  });
});
