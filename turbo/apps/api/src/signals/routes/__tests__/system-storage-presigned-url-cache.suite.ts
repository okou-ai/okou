import { publicChatActor } from "./helpers/public-chat-actor";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
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
import { createHash, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createAppWithRoutes } from "../../../app-factory-core";
import { mockEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { cronPruneStoragePresignedUrlsRoutes } from "../cron-prune-storage-presigned-urls";
import { testSystemStoragePresignedUrlCacheStateRoutes } from "../test-system-storage-presigned-url-cache-state";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import {
  createRunsApi,
  expectCanonicalStorageManifest,
} from "./helpers/api-bdd-runs";

describe("system storage presigned URL cache", () => {
  const context = testContext();
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
   * The remaining private pruning fixture owns a synthetic system storage.
   * Public cache lifetime scenarios below use a normal custom connector.
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
    return createHash("sha256")
      .update(`${label}:${randomUUID()}`)
      .digest("hex");
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

  function registerOwnedStorageCleanup(
    fixture: OwnedSystemStorageFixture,
  ): void {
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

  async function readonlyCacheScenario() {
    let clockTime = nowDate().getTime();
    const owned = await publicChatActor(context, {
      clockTime: () => {
        return clockTime;
      },
    });
    const fixture = createChatEventsFixture(context);
    const connectors = createConnectorBddApi(context);
    const api = createRunsApi(context);
    await owned.run(() => {
      return api.updateUserModelPreference(owned.actor, "claude-fable-5-1");
    });
    context.mocks.s3.send.mockResolvedValue({ ContentLength: 2048 });
    const connector = await owned.run(() => {
      return connectors.createCustomConnector(owned.actor, {
        displayName: "Readonly lifetime cache connector",
        prefixTemplates: [`https://cache-${randomUUID()}.example.test/`],
        fields: [
          { key: "secret", label: "Token", kind: "secret", required: true },
        ],
        headerInjections: [
          { name: "Authorization", valueTemplate: "Bearer {{secrets.secret}}" },
        ],
        queryInjections: [],
        authMode: "manual",
        skillMarkdown: "Use this readonly skill archive.",
      });
    });
    await owned.run(() => {
      return connectors.updateAgentCustomConnectors(
        owned.actor,
        owned.agentId,
        [connector.id],
      );
    });
    const storageName = getCustomConnectorSkillStorageName(connector.id);
    const signedCount = mockUniquePresignedUrls();
    return {
      advance(milliseconds: number) {
        clockTime += milliseconds;
      },
      signedCount,
      async claim(prompt: string) {
        const run = await owned.sendChatRun(owned.actor, {
          agentId: owned.agentId,
          prompt,
        });
        const claimed = await owned.claimChatRun(owned.runnerGroup, run.runId);
        const matchingMounts = expectCanonicalStorageManifest(
          claimed.claim.storageManifest,
        )?.storageMounts.filter((entry) => {
          return entry.name === storageName;
        });
        expect(matchingMounts).toHaveLength(1);
        const mount = matchingMounts?.[0];
        if (!mount?.archiveUrl || mount.archiveSize === undefined) {
          throw new Error("Expected a complete readonly connector mount");
        }
        expect(mount.mountPath).toBe(
          `/home/user/.claude/skills/custom-${connector.slug.slice(1, 49)}-${connector.id.replaceAll("-", "").slice(0, 8)}`,
        );
        expect(claimed.claim.connectorRuntimeTargets).not.toContainEqual(
          expect.objectContaining({
            kind: "custom",
            customConnectorId: connector.id,
          }),
        );
        // Settle the real claimed Run before advancing application time. A failed
        // Runner completion has no unfinished output upload or expired live token.
        await owned.run(() => {
          return fixture.failChatRun(
            run.runId,
            claimed.sandboxHeaders,
            "Cache inspection finished",
          );
        });
        await owned.run(flushWaitUntilForTest);
        await expect(
          owned.run(() => {
            return api.readRun(owned.actor, run.runId);
          }),
        ).resolves.toMatchObject({ status: "failed" });
        return {
          name: mount.name,
          mountPath: mount.mountPath,
          versionId: mount.versionId,
          archiveSize: mount.archiveSize,
          archiveUrl: mount.archiveUrl,
        };
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
        const input = (
          command as { readonly input?: { readonly Key?: string } }
        ).input;
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

  it("reuses one exact cached URL for an ordinary readonly connector storage", async () => {
    const scenario = await readonlyCacheScenario();
    const first = await scenario.claim("issue the readonly storage URL");
    const second = await scenario.claim("reuse the readonly storage URL");
    expect(second).toStrictEqual(first);
    const objectKey = decodeURIComponent(
      new URL(first.archiveUrl).pathname.slice(1),
    );
    expect(scenario.signedCount(objectKey)).toBe(1);
  });

  it.each([
    { remainingMs: 4 * 60 * 60 * 1000 - 1, refresh: true },
    { remainingMs: 4 * 60 * 60 * 1000, refresh: false },
    { remainingMs: 4 * 60 * 60 * 1000 + 1, refresh: false },
  ])(
    "enforces the four-hour readonly archive margin at $remainingMs ms remaining",
    async ({ remainingMs, refresh }) => {
      const scenario = await readonlyCacheScenario();
      const first = await scenario.claim("issue the readonly archive URL");
      const objectKey = decodeURIComponent(
        new URL(first.archiveUrl).pathname.slice(1),
      );
      scenario.advance(CACHE_TTL_SECONDS * 1000 - remainingMs);
      const second = await scenario.claim(
        "select the archive near its lifetime boundary",
      );
      expect(second).toStrictEqual({
        ...first,
        archiveUrl: refresh
          ? expectedPresignedUrl(objectKey, 2)
          : first.archiveUrl,
      });
      expect(scenario.signedCount(objectKey)).toBe(refresh ? 2 : 1);
      if (refresh) {
        expect(context.mocks.s3.getSignedUrl).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            input: expect.objectContaining({ Key: objectKey }),
          }),
          expect.objectContaining({ expiresIn: CACHE_TTL_SECONDS }),
        );
      }
      const third = await scenario.claim(
        "reuse the selected readonly archive URL",
      );
      expect(third).toStrictEqual(second);
    },
  );

  it("preserves 51 workflow and connector mounts across Runner claims", async () => {
    const runFixture = await entitledDirectRunActor();
    const { actor } = runFixture;
    if (!actor.orgId) {
      throw new Error("Expected an organization-scoped cache actor");
    }
    context.mocks.s3.send.mockResolvedValue({ ContentLength: 2048 });
    // All selected mounts come from normal workflow and connector creation.
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
    const expectedStorageNames = [...storageNames, readOnlyStorageName].sort();
    const signedCount = mockUniquePresignedUrls();
    const api = createRunsApi(context);
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
          return expectedStorageNames.includes(mount.name);
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

    const expected = await createAndClaim(
      "request all workflow and connector skills",
    );
    expect(expected).toHaveLength(51);
    expect(
      expected.map((mount) => {
        return mount.name;
      }),
    ).toStrictEqual(expectedStorageNames);
    // Keys are observed in the provider URLs delivered to the Runner, not read
    // from private Storage rows. Each returned archive was signed once.
    const objectKeys = expected.map((mount) => {
      if (!mount.archiveUrl) {
        throw new Error("Expected a Runner archive URL");
      }
      const url = new URL(mount.archiveUrl);
      expect(url.origin).toBe("https://r2.example.com");
      expect(url.searchParams.get("sig")).toBe("1");
      const objectKey = decodeURIComponent(url.pathname.slice(1));
      expect(
        objectKey.endsWith(`/${mount.versionId}/archive.tar.gz`),
      ).toBeTruthy();
      return objectKey;
    });
    // Workflow skills mount exactly at their slug; all paths remain distinct.
    expect(
      expected
        .filter((mount) => {
          return workflowMountPaths.has(mount.name);
        })
        .map((mount) => {
          return mount.mountPath;
        }),
    ).toStrictEqual(
      expected
        .filter((mount) => {
          return workflowMountPaths.has(mount.name);
        })
        .map((mount) => {
          return workflowMountPaths.get(mount.name);
        }),
    );
    expect(
      new Set(
        expected.map((mount) => {
          return mount.mountPath;
        }),
      ).size,
    ).toBe(51);
    for (const mount of expected) {
      expect(mount.mountPath).toMatch(
        /^\/home\/user\/\.claude\/skills\/[^/]+$/,
      );
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

    // Later Runner claims return the complete same manifest and signed URLs.
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
  });

  it("refreshes a hard-expired readonly archive with a new exact URL", async () => {
    const scenario = await readonlyCacheScenario();
    const first = await scenario.claim("issue the readonly archive URL");
    const objectKey = decodeURIComponent(
      new URL(first.archiveUrl).pathname.slice(1),
    );
    scenario.advance(CACHE_TTL_SECONDS * 1000 + 60_000);
    const refreshed = await scenario.claim(
      "refresh the hard-expired readonly URL",
    );
    expect(refreshed).toStrictEqual({
      ...first,
      archiveUrl: expectedPresignedUrl(objectKey, 2),
    });
    expect(scenario.signedCount(objectKey)).toBe(2);
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
