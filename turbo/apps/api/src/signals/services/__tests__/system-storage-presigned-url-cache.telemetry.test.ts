import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { beforeEach, describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { now, withMockNowForTest } from "../../../lib/time";
import {
  ApiDispatchTimingCollector,
  measureApiDispatchTiming,
  measureApiDispatchTimingSync,
  type ApiDispatchTimingActionType,
  type ApiDispatchTimingDimensions,
  type ApiDispatchTimingDimensionsInput,
} from "../api-dispatch-timing.service";
import {
  prefetchStorageManifestPresignedUrlCacheRows,
  readOnlyStoragePresignedUrlCacheKey,
  resolveReadOnlyStoragePresignedUrls,
  resolveSystemStoragePresignedUrls,
  resolveWorkflowSkillStoragePresignedUrls,
  systemStoragePresignedUrlCacheKey,
  STORAGE_MANIFEST_PRESIGNED_URL_MIXED_LOOKUP_MAX_PAIRS,
  workflowSkillStoragePresignedUrlCacheKey,
  type ReadOnlyStoragePresignedUrlRequest,
  type StorageManifestCacheBranch,
  type StorageManifestCacheEntryKind,
  type StorageManifestPresignedUrlCacheScope,
  type StorageManifestPresignedUrlCacheSnapshot,
  type SystemStoragePresignedUrlRequest,
  type WorkflowSkillStoragePresignedUrlRequest,
} from "../system-storage-presigned-url-cache.service";

/**
 * Narrow internal-boundary exception: storage-manifest timing dimensions are
 * deliberately absent from every HTTP response. Route suites own observable
 * cache/results behavior; this suite pins only the finite collector contract.
 */

const context = testContext();
const CACHE_ACTIONS = [
  "api_dispatch_prepare_storage_manifest_cache_prepare_requests",
  "api_dispatch_prepare_storage_manifest_cache_lookup",
  "api_dispatch_prepare_storage_manifest_cache_classify",
  "api_dispatch_prepare_storage_manifest_cache_sign_misses",
  "api_dispatch_prepare_storage_manifest_cache_upsert_misses",
] as const satisfies readonly ApiDispatchTimingActionType[];
const MANIFEST_DIMENSION_KEYS = [
  "storage_manifest_branch",
  "storage_manifest_cache_fresh_count_bucket",
  "storage_manifest_cache_hard_expired_count_bucket",
  "storage_manifest_cache_hit_count_bucket",
  "storage_manifest_cache_missing_count_bucket",
  "storage_manifest_cache_requested_count_bucket",
  "storage_manifest_cache_scope",
  "storage_manifest_cache_unique_key_count_bucket",
  "storage_manifest_entry_kind",
] as const;

interface SelectedCacheRow {
  readonly cacheKey: string;
  readonly presignedUrl: string;
  readonly expiresAt: Date;
}

interface MixedSelectedCacheRow extends SelectedCacheRow {
  readonly scope: StorageManifestPresignedUrlCacheScope;
}

interface TimingRecord {
  readonly actionType: ApiDispatchTimingActionType;
  readonly dimensions: ApiDispatchTimingDimensions | undefined;
}

class RecordingTimingCollector extends ApiDispatchTimingCollector {
  readonly recorded: TimingRecord[] = [];

  override recordElapsed(
    actionType: ApiDispatchTimingActionType,
    _spanKind: "top_level" | "nested",
    _startedAt: number,
    _finishedAt?: number,
    dimensions?: ApiDispatchTimingDimensionsInput,
  ): void {
    this.recorded.push({
      actionType,
      dimensions: typeof dimensions === "function" ? dimensions() : dimensions,
    });
  }

  override recordDuration(
    actionType: ApiDispatchTimingActionType,
    _spanKind: "top_level" | "nested",
    _durationMs: number,
    _finishedAt: number,
    dimensions?: ApiDispatchTimingDimensionsInput,
  ): void {
    this.recorded.push({
      actionType,
      dimensions: typeof dimensions === "function" ? dimensions() : dimensions,
    });
  }
}

function fakeCacheDb(rows: readonly SelectedCacheRow[]): {
  readonly db: never;
  readonly upserted: unknown[][];
} {
  const upserted: unknown[][] = [];
  const db = {
    select() {
      return {
        from() {
          return {
            where() {
              return Promise.resolve(rows);
            },
          };
        },
      };
    },
    insert() {
      return {
        values(values: unknown[]) {
          upserted.push(values);
          return {
            onConflictDoUpdate() {
              return Promise.resolve();
            },
          };
        },
      };
    },
  };
  return { db: db as never, upserted };
}

function failingLookupDb(error: Error): never {
  return {
    select() {
      return {
        from() {
          return {
            where() {
              return Promise.reject(error);
            },
          };
        },
      };
    },
  } as never;
}

function fakeMixedCacheDb(
  rows: readonly MixedSelectedCacheRow[],
  error?: Error,
): {
  readonly db: never;
  readonly selectCount: () => number;
  readonly upserted: unknown[][];
} {
  let selects = 0;
  const upserted: unknown[][] = [];
  const db = {
    select() {
      return {
        from() {
          return {
            innerJoin() {
              selects += 1;
              return error ? Promise.reject(error) : Promise.resolve(rows);
            },
          };
        },
      };
    },
    insert() {
      return {
        values(values: unknown[]) {
          upserted.push(values);
          return {
            onConflictDoUpdate() {
              return Promise.resolve();
            },
          };
        },
      };
    },
  };
  return {
    db: db as never,
    selectCount: () => {
      return selects;
    },
    upserted,
  };
}

function observation(
  timing: ApiDispatchTimingCollector,
  branch: StorageManifestCacheBranch,
  entryKind: StorageManifestCacheEntryKind,
) {
  return { timing, branch, entryKind } as const;
}

function systemRequest(label: string): SystemStoragePresignedUrlRequest {
  const suffix = randomUUID().replaceAll("-", "");
  return {
    bucket: "manifest-telemetry-test",
    objectKey: `${label}/${suffix}/archive.tar.gz`,
    storageVersionId: suffix.padEnd(64, "0"),
    publicEndpoint: true,
  };
}

function scopedRequests(label: string): {
  readonly workflow: WorkflowSkillStoragePresignedUrlRequest;
  readonly readOnly: ReadOnlyStoragePresignedUrlRequest;
} {
  const suffix = randomUUID().replaceAll("-", "");
  const common = {
    bucket: "manifest-telemetry-test",
    objectKey: `${label}/${suffix}/archive.tar.gz`,
    storageVersionId: suffix.padEnd(64, "0"),
    resolvedOrgId: randomUUID(),
    publicEndpoint: true,
  };
  return { workflow: common, readOnly: common };
}

function expectSnapshot(
  timing: RecordingTimingCollector,
  expected: Record<string, string>,
): void {
  expect(
    timing.recorded
      .map((record) => {
        return record.actionType;
      })
      .sort(),
  ).toStrictEqual([...CACHE_ACTIONS].sort());
  for (const record of timing.recorded) {
    expect(record.dimensions).toStrictEqual(expected);
    expect(Object.keys(record.dimensions ?? {}).sort()).toStrictEqual(
      [...MANIFEST_DIMENSION_KEYS].sort(),
    );
  }
}

beforeEach(() => {
  let signature = 0;
  context.mocks.s3.getSignedUrl.mockImplementation(
    (_client: unknown, command: unknown) => {
      signature += 1;
      const key = (command as { readonly input?: { readonly Key?: string } })
        .input?.Key;
      return Promise.resolve(
        `https://r2.example.com/${encodeURIComponent(key ?? "unknown")}?sig=${signature}`,
      );
    },
  );
});

describe("storage manifest presigned URL cache telemetry", () => {
  it("records caller-side join and synchronous construction dimensions", async () => {
    const timing = new RecordingTimingCollector();
    const dimensions = {
      storage_manifest_branch: "requested",
      storage_manifest_entry_kind: "additional",
      storage_manifest_entry_count_bucket: "2_4",
    } as const;

    await expect(
      measureApiDispatchTiming(
        timing,
        "api_dispatch_prepare_storage_manifest_cache_join_results",
        "nested",
        () => {
          return Promise.resolve("joined");
        },
        dimensions,
      ),
    ).resolves.toBe("joined");
    expect(
      measureApiDispatchTimingSync(
        timing,
        "api_dispatch_prepare_storage_manifest_construct_entries",
        "nested",
        () => {
          return "constructed";
        },
        dimensions,
      ),
    ).toBe("constructed");
    expect(timing.recorded).toStrictEqual([
      {
        actionType: "api_dispatch_prepare_storage_manifest_cache_join_results",
        dimensions,
      },
      {
        actionType: "api_dispatch_prepare_storage_manifest_construct_entries",
        dimensions,
      },
    ]);
  });

  it("uses one final all-hit snapshot for every internal phase", async () => {
    const request = systemRequest("all-hit");
    const cacheKey = systemStoragePresignedUrlCacheKey(request);
    const { db, upserted } = fakeCacheDb([
      {
        cacheKey,
        presignedUrl: "https://r2.example.com/cached",
        expiresAt: new Date(now() + 60_000),
      },
    ]);
    const timing = new RecordingTimingCollector();

    const results = await createStore().get(
      resolveSystemStoragePresignedUrls({
        db,
        requests: [request, request],
        observation: observation(timing, "requested", "compose"),
      }),
    );

    expect(results.get(cacheKey)).toStrictEqual(
      expect.objectContaining({
        status: "hit",
        url: "https://r2.example.com/cached",
      }),
    );
    expect(upserted).toStrictEqual([]);
    expectSnapshot(timing, {
      storage_manifest_branch: "requested",
      storage_manifest_entry_kind: "compose",
      storage_manifest_cache_scope: "system_storage",
      storage_manifest_cache_requested_count_bucket: "2_4",
      storage_manifest_cache_unique_key_count_bucket: "1",
      storage_manifest_cache_hit_count_bucket: "1",
      storage_manifest_cache_hard_expired_count_bucket: "0",
      storage_manifest_cache_missing_count_bucket: "0",
      storage_manifest_cache_fresh_count_bucket: "0",
    });
  });

  it.each([
    {
      label: "missing",
      rows: [],
      branch: "session_writeback" as const,
      entryKind: "artifact" as const,
      hardExpired: "0",
      missing: "1",
    },
    {
      label: "hard-expired",
      rows: "expired" as const,
      branch: "captured" as const,
      entryKind: "additional" as const,
      hardExpired: "1",
      missing: "0",
    },
  ])(
    "attributes a $label request without changing its refreshed result",
    async ({
      label,
      rows: rowFixture,
      branch,
      entryKind,
      hardExpired,
      missing,
    }) => {
      const request = systemRequest(label);
      const cacheKey = systemStoragePresignedUrlCacheKey(request);
      const rows =
        rowFixture === "expired"
          ? [
              {
                cacheKey,
                presignedUrl: "https://r2.example.com/expired",
                expiresAt: new Date(now() - 60_000),
              },
            ]
          : rowFixture;
      const { db, upserted } = fakeCacheDb(rows);
      const timing = new RecordingTimingCollector();

      const results = await createStore().get(
        resolveSystemStoragePresignedUrls({
          db,
          requests: [request],
          observation: observation(timing, branch, entryKind),
        }),
      );

      expect(results.get(cacheKey)).toStrictEqual(
        expect.objectContaining({ status: "miss" }),
      );
      expect(upserted).toHaveLength(1);
      expectSnapshot(timing, {
        storage_manifest_branch: branch,
        storage_manifest_entry_kind: entryKind,
        storage_manifest_cache_scope: "system_storage",
        storage_manifest_cache_requested_count_bucket: "1",
        storage_manifest_cache_unique_key_count_bucket: "1",
        storage_manifest_cache_hit_count_bucket: "0",
        storage_manifest_cache_hard_expired_count_bucket: hardExpired,
        storage_manifest_cache_missing_count_bucket: missing,
        storage_manifest_cache_fresh_count_bucket: "1",
      });
    },
  );

  it("keeps same-shaped ownership scopes isolated", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const common = {
      bucket: "manifest-telemetry-test",
      objectKey: `scope/${suffix}/archive.tar.gz`,
      storageVersionId: suffix.padEnd(64, "0"),
      resolvedOrgId: randomUUID(),
      publicEndpoint: true,
    };
    const workflowRequest: WorkflowSkillStoragePresignedUrlRequest = common;
    const readOnlyRequest: ReadOnlyStoragePresignedUrlRequest = common;
    const workflowKey =
      workflowSkillStoragePresignedUrlCacheKey(workflowRequest);
    const readOnlyKey = readOnlyStoragePresignedUrlCacheKey(readOnlyRequest);
    const workflowTiming = new RecordingTimingCollector();
    const readOnlyTiming = new RecordingTimingCollector();

    const [workflowResults, readOnlyResults] = await Promise.all([
      createStore().get(
        resolveWorkflowSkillStoragePresignedUrls({
          db: fakeCacheDb([]).db,
          requests: [workflowRequest],
          observation: observation(workflowTiming, "requested", "additional"),
        }),
      ),
      createStore().get(
        resolveReadOnlyStoragePresignedUrls({
          db: fakeCacheDb([]).db,
          requests: [readOnlyRequest],
          observation: observation(readOnlyTiming, "requested", "additional"),
        }),
      ),
    ]);

    expect(workflowKey).not.toBe(readOnlyKey);
    expect(workflowResults.get(workflowKey)?.status).toBe("miss");
    expect(readOnlyResults.get(readOnlyKey)?.status).toBe("miss");
    expect(
      workflowTiming.recorded.every((record) => {
        return (
          record.dimensions?.storage_manifest_cache_scope ===
          "workflow_skill_storage"
        );
      }),
    ).toBeTruthy();
    expect(
      readOnlyTiming.recorded.every((record) => {
        return (
          record.dimensions?.storage_manifest_cache_scope === "readonly_storage"
        );
      }),
    ).toBeTruthy();
  });

  it("flushes one partial snapshot without fabricating later phases", async () => {
    const request = systemRequest("lookup-failure");
    const timing = new RecordingTimingCollector();

    await expect(
      createStore().get(
        resolveSystemStoragePresignedUrls({
          db: failingLookupDb(new Error("lookup failed")),
          requests: [request],
          observation: observation(timing, "requested", "compose"),
        }),
      ),
    ).rejects.toThrow("lookup failed");

    expect(timing.recorded).toStrictEqual([
      {
        actionType:
          "api_dispatch_prepare_storage_manifest_cache_prepare_requests",
        dimensions: {
          storage_manifest_branch: "requested",
          storage_manifest_entry_kind: "compose",
          storage_manifest_cache_scope: "system_storage",
          storage_manifest_cache_requested_count_bucket: "1",
          storage_manifest_cache_unique_key_count_bucket: "1",
          storage_manifest_cache_hit_count_bucket: "0",
          storage_manifest_cache_hard_expired_count_bucket: "0",
          storage_manifest_cache_missing_count_bucket: "0",
          storage_manifest_cache_fresh_count_bucket: "0",
        },
      },
      {
        actionType: "api_dispatch_prepare_storage_manifest_cache_lookup",
        dimensions: {
          storage_manifest_branch: "requested",
          storage_manifest_entry_kind: "compose",
          storage_manifest_cache_scope: "system_storage",
          storage_manifest_cache_requested_count_bucket: "1",
          storage_manifest_cache_unique_key_count_bucket: "1",
          storage_manifest_cache_hit_count_bucket: "0",
          storage_manifest_cache_hard_expired_count_bucket: "0",
          storage_manifest_cache_missing_count_bucket: "0",
          storage_manifest_cache_fresh_count_bucket: "0",
        },
      },
    ]);
  });

  it("retains partial unique-key progress when request preparation fails", async () => {
    const request = systemRequest("prepare-failure");
    const invalidRequest = {
      get bucket(): string {
        throw new Error("cache key failed");
      },
      objectKey: "unreachable",
      storageVersionId: "0".repeat(64),
      publicEndpoint: true,
    } satisfies SystemStoragePresignedUrlRequest;
    const timing = new RecordingTimingCollector();

    await expect(
      createStore().get(
        resolveSystemStoragePresignedUrls({
          db: fakeCacheDb([]).db,
          requests: [request, invalidRequest],
          observation: observation(timing, "requested", "compose"),
        }),
      ),
    ).rejects.toThrow("cache key failed");

    expect(timing.recorded).toStrictEqual([
      {
        actionType:
          "api_dispatch_prepare_storage_manifest_cache_prepare_requests",
        dimensions: {
          storage_manifest_branch: "requested",
          storage_manifest_entry_kind: "compose",
          storage_manifest_cache_scope: "system_storage",
          storage_manifest_cache_requested_count_bucket: "2_4",
          storage_manifest_cache_unique_key_count_bucket: "1",
          storage_manifest_cache_hit_count_bucket: "0",
          storage_manifest_cache_hard_expired_count_bucket: "0",
          storage_manifest_cache_missing_count_bucket: "0",
          storage_manifest_cache_fresh_count_bucket: "0",
        },
      },
    ]);
  });

  it("uses one mixed lookup without duplicating per-scope lookup telemetry", async () => {
    const systemRequests = Array.from({ length: 17 }, (_, index) => {
      return systemRequest(`mixed-hit-system-${index}`);
    });
    const scoped = Array.from({ length: 17 }, (_, index) => {
      return scopedRequests(`mixed-hit-scoped-${index}`);
    });
    const workflowSkillRequests = scoped.map((requests) => {
      return requests.workflow;
    });
    const readOnlyRequests = scoped.map((requests) => {
      return requests.readOnly;
    });
    const expiresAt = new Date(now() + 60_000);
    const mixedDb = fakeMixedCacheDb([
      ...systemRequests.map((request, index) => {
        return {
          scope: "system_storage" as const,
          cacheKey: systemStoragePresignedUrlCacheKey(request),
          presignedUrl: `https://r2.example.com/system-cached-${index}`,
          expiresAt,
        };
      }),
      ...workflowSkillRequests.map((request, index) => {
        return {
          scope: "workflow_skill_storage" as const,
          cacheKey: workflowSkillStoragePresignedUrlCacheKey(request),
          presignedUrl: `https://r2.example.com/workflow-cached-${index}`,
          expiresAt,
        };
      }),
      ...readOnlyRequests.map((request, index) => {
        return {
          scope: "readonly_storage" as const,
          cacheKey: readOnlyStoragePresignedUrlCacheKey(request),
          presignedUrl: `https://r2.example.com/readonly-cached-${index}`,
          expiresAt,
        };
      }),
    ]);
    const timing = new RecordingTimingCollector();
    const store = createStore();
    const prefetchedRows = await store.get(
      prefetchStorageManifestPresignedUrlCacheRows({
        db: mixedDb.db,
        input: {
          systemRequests,
          workflowSkillRequests,
          readOnlyRequests,
          logicalLookupCount: 3,
        },
        observation: { timing, branch: "requested" },
      }),
    );
    if (!prefetchedRows) {
      throw new Error("Expected an eligible mixed lookup snapshot");
    }

    const [systemResults, workflowResults, readOnlyResults] = await Promise.all(
      [
        store.get(
          resolveSystemStoragePresignedUrls({
            db: mixedDb.db,
            requests: systemRequests,
            prefetchedRows,
            observation: observation(timing, "requested", "compose"),
          }),
        ),
        store.get(
          resolveWorkflowSkillStoragePresignedUrls({
            db: mixedDb.db,
            requests: workflowSkillRequests,
            prefetchedRows,
            observation: observation(timing, "requested", "additional"),
          }),
        ),
        store.get(
          resolveReadOnlyStoragePresignedUrls({
            db: mixedDb.db,
            requests: readOnlyRequests,
            prefetchedRows,
            observation: observation(timing, "requested", "artifact"),
          }),
        ),
      ],
    );

    expect(mixedDb.selectCount()).toBe(1);
    expect(
      [...systemResults.values()].every((result) => {
        return result.status === "hit";
      }),
    ).toBeTruthy();
    expect(
      [...workflowResults.values()].every((result) => {
        return result.status === "hit";
      }),
    ).toBeTruthy();
    expect(
      [...readOnlyResults.values()].every((result) => {
        return result.status === "hit";
      }),
    ).toBeTruthy();
    expect(
      timing.recorded.filter((record) => {
        return (
          record.actionType ===
          "api_dispatch_prepare_storage_manifest_cache_mixed_lookup"
        );
      }),
    ).toStrictEqual([
      {
        actionType: "api_dispatch_prepare_storage_manifest_cache_mixed_lookup",
        dimensions: {
          storage_manifest_branch: "requested",
          storage_manifest_cache_requested_count_bucket: "17_plus",
          storage_manifest_cache_unique_key_count_bucket: "17_plus",
          storage_manifest_cache_logical_lookup_count_bucket: "2_4",
        },
      },
    ]);
    expect(
      timing.recorded.some((record) => {
        return (
          record.actionType ===
          "api_dispatch_prepare_storage_manifest_cache_lookup"
        );
      }),
    ).toBeFalsy();
  });

  it("deduplicates mixed pairs and never rereads an empty snapshot", async () => {
    const system = systemRequest("mixed-empty");
    const { workflow } = scopedRequests("mixed-empty");
    const mixedDb = fakeMixedCacheDb([]);
    const store = createStore();
    const prefetchedRows = await store.get(
      prefetchStorageManifestPresignedUrlCacheRows({
        db: mixedDb.db,
        input: {
          systemRequests: [system, system],
          workflowSkillRequests: [workflow],
          readOnlyRequests: [],
          logicalLookupCount: 2,
        },
      }),
    );
    if (!prefetchedRows) {
      throw new Error("Expected an empty mixed lookup snapshot");
    }

    const [systemResults, workflowResults] = await Promise.all([
      store.get(
        resolveSystemStoragePresignedUrls({
          db: mixedDb.db,
          requests: [system, system],
          prefetchedRows,
        }),
      ),
      store.get(
        resolveWorkflowSkillStoragePresignedUrls({
          db: mixedDb.db,
          requests: [workflow],
          prefetchedRows,
        }),
      ),
    ]);

    expect(mixedDb.selectCount()).toBe(1);
    expect(systemResults.size).toBe(1);
    expect(workflowResults.size).toBe(1);
    expect([...systemResults.values()][0]?.status).toBe("miss");
    expect([...workflowResults.values()][0]?.status).toBe("miss");
    expect(mixedDb.upserted).toHaveLength(2);
  });

  it("does not dispatch a prefetched row across ownership scopes", async () => {
    const request = systemRequest("wrong-scope");
    const cacheKey = systemStoragePresignedUrlCacheKey(request);
    const prefetchedRows: StorageManifestPresignedUrlCacheSnapshot = {
      rowsByScope: new Map([
        [
          "workflow_skill_storage",
          new Map([
            [
              cacheKey,
              {
                cacheKey,
                presignedUrl: "https://r2.example.com/wrong-scope",
                expiresAt: new Date(now() + 60_000),
              },
            ],
          ]),
        ],
      ]),
    };
    const mixedDb = fakeMixedCacheDb([]);

    const results = await createStore().get(
      resolveSystemStoragePresignedUrls({
        db: mixedDb.db,
        requests: [request],
        prefetchedRows,
      }),
    );

    expect(mixedDb.selectCount()).toBe(0);
    expect(results.get(cacheKey)?.status).toBe("miss");
    expect(results.get(cacheKey)?.url).not.toBe(
      "https://r2.example.com/wrong-scope",
    );
    expect(mixedDb.upserted).toHaveLength(1);
  });

  it("keeps the strict hard-expiry boundary with prefetched rows", async () => {
    const issuedAt = new Date("2026-09-22T12:00:00.000Z");
    const request = systemRequest("expiry-boundary");
    const cacheKey = systemStoragePresignedUrlCacheKey(request);
    const prefetchedRows: StorageManifestPresignedUrlCacheSnapshot = {
      rowsByScope: new Map([
        [
          "system_storage",
          new Map([
            [
              cacheKey,
              {
                cacheKey,
                presignedUrl: "https://r2.example.com/expires-at-issued-at",
                expiresAt: issuedAt,
              },
            ],
          ]),
        ],
      ]),
    };
    const mixedDb = fakeMixedCacheDb([]);

    const results = await withMockNowForTest(issuedAt, async () => {
      return await createStore().get(
        resolveSystemStoragePresignedUrls({
          db: mixedDb.db,
          requests: [request],
          prefetchedRows,
        }),
      );
    });

    expect(results.get(cacheKey)?.status).toBe("miss");
    expect(mixedDb.selectCount()).toBe(0);
    expect(mixedDb.upserted).toHaveLength(1);
  });

  it("uses the mixed lookup only inside its hard cardinality bound", async () => {
    const systemRequests = Array.from(
      {
        length: STORAGE_MANIFEST_PRESIGNED_URL_MIXED_LOOKUP_MAX_PAIRS - 1,
      },
      (_, index): SystemStoragePresignedUrlRequest => {
        return {
          bucket: "manifest-telemetry-test",
          objectKey: `bounded/${index}/archive.tar.gz`,
          storageVersionId: index.toString(16).padStart(64, "0"),
          publicEndpoint: true,
        };
      },
    );
    const { workflow } = scopedRequests("bounded");
    const atCapDb = fakeMixedCacheDb([]);
    const store = createStore();

    await expect(
      store.get(
        prefetchStorageManifestPresignedUrlCacheRows({
          db: atCapDb.db,
          input: {
            systemRequests,
            workflowSkillRequests: [workflow],
            readOnlyRequests: [],
            logicalLookupCount: 2,
          },
        }),
      ),
    ).resolves.toBeDefined();
    expect(atCapDb.selectCount()).toBe(1);

    const aboveCapDb = fakeMixedCacheDb([]);
    await expect(
      store.get(
        prefetchStorageManifestPresignedUrlCacheRows({
          db: aboveCapDb.db,
          input: {
            systemRequests: [
              ...systemRequests,
              systemRequest("bounded-overflow"),
            ],
            workflowSkillRequests: [workflow],
            readOnlyRequests: [],
            logicalLookupCount: 2,
          },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(aboveCapDb.selectCount()).toBe(0);

    const singleGroupDb = fakeMixedCacheDb([]);
    await expect(
      store.get(
        prefetchStorageManifestPresignedUrlCacheRows({
          db: singleGroupDb.db,
          input: {
            systemRequests: [systemRequest("single-group")],
            workflowSkillRequests: [],
            readOnlyRequests: [],
            logicalLookupCount: 1,
          },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(singleGroupDb.selectCount()).toBe(0);
  });

  it("records one failed mixed lookup without starting logical work", async () => {
    const system = systemRequest("mixed-failure");
    const { workflow } = scopedRequests("mixed-failure");
    const failure = new Error("mixed lookup failed");
    const mixedDb = fakeMixedCacheDb([], failure);
    const timing = new RecordingTimingCollector();

    await expect(
      createStore().get(
        prefetchStorageManifestPresignedUrlCacheRows({
          db: mixedDb.db,
          input: {
            systemRequests: [system],
            workflowSkillRequests: [workflow],
            readOnlyRequests: [],
            logicalLookupCount: 2,
          },
          observation: { timing, branch: "session_writeback" },
        }),
      ),
    ).rejects.toThrow("mixed lookup failed");

    expect(mixedDb.selectCount()).toBe(1);
    expect(mixedDb.upserted).toStrictEqual([]);
    expect(context.mocks.s3.getSignedUrl).not.toHaveBeenCalled();
    expect(timing.recorded).toStrictEqual([
      {
        actionType: "api_dispatch_prepare_storage_manifest_cache_mixed_lookup",
        dimensions: {
          storage_manifest_branch: "session_writeback",
          storage_manifest_cache_requested_count_bucket: "2_4",
          storage_manifest_cache_unique_key_count_bucket: "2_4",
          storage_manifest_cache_logical_lookup_count_bucket: "2_4",
        },
      },
    ]);
  });
});
