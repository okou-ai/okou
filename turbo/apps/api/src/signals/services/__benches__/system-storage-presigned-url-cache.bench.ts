import { createHash, randomUUID } from "node:crypto";

import { systemStoragePresignedUrlCache } from "@okouai/db/schema/system-storage-presigned-url-cache";
import { createStore } from "ccstate";
import { and, eq, inArray, sql } from "drizzle-orm";
import { test } from "vitest";
import { z } from "zod";

import { testContext } from "../../../__tests__/test-context";
import { executeRawRows } from "../../../lib/db-raw-rows";
import { nowDate } from "../../../lib/time";
import { writeDb$ } from "../../external/db";
import {
  prefetchStorageManifestPresignedUrlCacheRows,
  readOnlyStoragePresignedUrlCacheKey,
  resolveReadOnlyStoragePresignedUrls,
  resolveSystemStoragePresignedUrls,
  resolveWorkflowSkillStoragePresignedUrls,
  systemStoragePresignedUrlCacheKey,
  SYSTEM_STORAGE_PRESIGNED_URL_TTL_SECONDS,
  workflowSkillStoragePresignedUrlCacheKey,
  type ReadOnlyStoragePresignedUrlRequest,
  type StorageManifestPresignedUrlCacheScope,
  type SystemStoragePresignedUrlRequest,
  type WorkflowSkillStoragePresignedUrlRequest,
} from "../system-storage-presigned-url-cache.service";

testContext();
const store = createStore();
const BENCH_SIZES = [1, 17, 64, 500, 501] as const;
const BACKGROUND_ROW_COUNT = 5000;
const INSERT_CHUNK_SIZE = 500;
const benchOptions = {
  time: 2000,
  warmupIterations: 3,
  throws: true,
} as const;
const queryPlanRowSchema = z.object({ "QUERY PLAN": z.string() });

type CacheInsert = typeof systemStoragePresignedUrlCache.$inferInsert;

interface CacheLookupPair {
  readonly scope: StorageManifestPresignedUrlCacheScope;
  readonly cacheKey: string;
}

interface BenchFixture {
  readonly systemRequests: readonly SystemStoragePresignedUrlRequest[];
  readonly workflowSkillRequests: readonly WorkflowSkillStoragePresignedUrlRequest[];
  readonly readOnlyRequests: readonly ReadOnlyStoragePresignedUrlRequest[];
  readonly pairs: readonly CacheLookupPair[];
  readonly rows: readonly CacheInsert[];
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function cacheInsert(args: {
  readonly scope: StorageManifestPresignedUrlCacheScope;
  readonly cacheKey: string;
  readonly objectKey: string;
  readonly storageVersionId: string;
  readonly resolvedOrgId: string | null;
  readonly issuedAt: Date;
}): CacheInsert {
  const expiresAt = new Date(args.issuedAt.getTime() + 60 * 60_000);
  return {
    cacheKey: args.cacheKey,
    scope: args.scope,
    bucket: "storage-cache-bench",
    objectKey: args.objectKey,
    storageVersionId: args.storageVersionId,
    resolvedOrgId: args.resolvedOrgId,
    publicEndpoint: true,
    ttlSeconds: SYSTEM_STORAGE_PRESIGNED_URL_TTL_SECONDS,
    presignedUrl: `https://r2.example.com/${args.cacheKey}`,
    expiresAt,
    refreshAfter: expiresAt,
    lastRequestedAt: args.issuedAt,
    updatedAt: args.issuedAt,
  };
}

function benchFixture(size: number, label: string): BenchFixture {
  const systemRequests: SystemStoragePresignedUrlRequest[] = [];
  const workflowSkillRequests: WorkflowSkillStoragePresignedUrlRequest[] = [];
  const readOnlyRequests: ReadOnlyStoragePresignedUrlRequest[] = [];
  const pairs: CacheLookupPair[] = [];
  const rows: CacheInsert[] = [];
  const issuedAt = nowDate();
  for (let index = 0; index < size; index += 1) {
    const storageVersionId = digest(`${label}:version:${String(index)}`);
    const objectKey = `${label}/${String(index)}/archive.tar.gz`;
    const common = {
      bucket: "storage-cache-bench",
      objectKey,
      storageVersionId,
      publicEndpoint: true,
    };
    if (index % 3 === 0) {
      const request: SystemStoragePresignedUrlRequest = common;
      const cacheKey = systemStoragePresignedUrlCacheKey(request);
      systemRequests.push(request);
      pairs.push({ scope: "system_storage", cacheKey });
      rows.push(
        cacheInsert({
          scope: "system_storage",
          cacheKey,
          objectKey,
          storageVersionId,
          resolvedOrgId: null,
          issuedAt,
        }),
      );
      continue;
    }
    const resolvedOrgId = `bench-org-${label}`;
    if (index % 3 === 1) {
      const request: WorkflowSkillStoragePresignedUrlRequest = {
        ...common,
        resolvedOrgId,
      };
      const cacheKey = workflowSkillStoragePresignedUrlCacheKey(request);
      workflowSkillRequests.push(request);
      pairs.push({ scope: "workflow_skill_storage", cacheKey });
      rows.push(
        cacheInsert({
          scope: "workflow_skill_storage",
          cacheKey,
          objectKey,
          storageVersionId,
          resolvedOrgId,
          issuedAt,
        }),
      );
      continue;
    }
    const request: ReadOnlyStoragePresignedUrlRequest = {
      ...common,
      resolvedOrgId,
    };
    const cacheKey = readOnlyStoragePresignedUrlCacheKey(request);
    readOnlyRequests.push(request);
    pairs.push({ scope: "readonly_storage", cacheKey });
    rows.push(
      cacheInsert({
        scope: "readonly_storage",
        cacheKey,
        objectKey,
        storageVersionId,
        resolvedOrgId,
        issuedAt,
      }),
    );
  }
  return {
    systemRequests,
    workflowSkillRequests,
    readOnlyRequests,
    pairs,
    rows,
  };
}

async function insertChunks(rows: readonly CacheInsert[]): Promise<void> {
  const db = store.set(writeDb$);
  for (let offset = 0; offset < rows.length; offset += INSERT_CHUNK_SIZE) {
    await db
      .insert(systemStoragePresignedUrlCache)
      .values(rows.slice(offset, offset + INSERT_CHUNK_SIZE))
      .onConflictDoNothing();
  }
}

function backgroundRows(label: string): readonly CacheInsert[] {
  const issuedAt = nowDate();
  return Array.from({ length: BACKGROUND_ROW_COUNT }, (_, index) => {
    const storageVersionId = digest(
      `${label}:background-version:${String(index)}`,
    );
    const objectKey = `${label}/background/${String(index)}/archive.tar.gz`;
    return cacheInsert({
      scope: "system_storage",
      cacheKey: digest(`${label}:background-key:${String(index)}`),
      objectKey,
      storageVersionId,
      resolvedOrgId: null,
      issuedAt,
    });
  });
}

async function logQueryPlan(fixture: BenchFixture): Promise<void> {
  const db = store.set(writeDb$);
  const pairs = fixture.pairs.slice(0, 17);
  const scopes = pairs.map((pair) => {
    return pair.scope;
  });
  const cacheKeys = pairs.map((pair) => {
    return pair.cacheKey;
  });
  const plan = await executeRawRows(
    db,
    sql`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
      SELECT
        ${systemStoragePresignedUrlCache.scope},
        ${systemStoragePresignedUrlCache.cacheKey},
        ${systemStoragePresignedUrlCache.presignedUrl},
        ${systemStoragePresignedUrlCache.expiresAt}
      FROM ${systemStoragePresignedUrlCache}
      INNER JOIN unnest(
        ${sql.param(scopes)}::varchar(64)[],
        ${sql.param(cacheKeys)}::varchar(64)[]
      ) AS requested(scope, cache_key)
        ON ${and(
          eq(systemStoragePresignedUrlCache.scope, sql`requested.scope`),
          eq(systemStoragePresignedUrlCache.cacheKey, sql`requested.cache_key`),
        )}
    `,
    queryPlanRowSchema,
  );
  process.stdout.write(
    `\n[bench-explain] storage cache mixed lookup, 17 exact pairs\n${plan
      .map((row) => {
        return row["QUERY PLAN"];
      })
      .join("\n")}\n\n`,
  );
}

function logicalLookupCount(fixture: BenchFixture): number {
  return [
    fixture.systemRequests,
    fixture.workflowSkillRequests,
    fixture.readOnlyRequests,
  ].filter((requests) => {
    return requests.length > 0;
  }).length;
}

async function resolveFixture(
  fixture: BenchFixture,
  useMixedLookup: boolean,
  expectedMissCount = 0,
): Promise<void> {
  const db = store.set(writeDb$);
  const prefetchedRows = useMixedLookup
    ? await store.get(
        prefetchStorageManifestPresignedUrlCacheRows({
          db,
          input: {
            systemRequests: fixture.systemRequests,
            workflowSkillRequests: fixture.workflowSkillRequests,
            readOnlyRequests: fixture.readOnlyRequests,
            logicalLookupCount: logicalLookupCount(fixture),
          },
        }),
      )
    : undefined;
  const results = await Promise.all([
    store.get(
      resolveSystemStoragePresignedUrls({
        db,
        requests: fixture.systemRequests,
        prefetchedRows,
      }),
    ),
    store.get(
      resolveWorkflowSkillStoragePresignedUrls({
        db,
        requests: fixture.workflowSkillRequests,
        prefetchedRows,
      }),
    ),
    store.get(
      resolveReadOnlyStoragePresignedUrls({
        db,
        requests: fixture.readOnlyRequests,
        prefetchedRows,
      }),
    ),
  ]);
  const resolved = results.flatMap((entries) => {
    return [...entries.values()];
  });
  const missCount = resolved.filter((result) => {
    return result.status === "miss";
  }).length;
  if (
    resolved.length !== fixture.pairs.length ||
    missCount !== expectedMissCount
  ) {
    throw new Error("Storage cache benchmark fixture status count changed");
  }
}

async function resolveFixtureWithExpiredRows(
  fixture: BenchFixture,
  useMixedLookup: boolean,
): Promise<void> {
  const db = store.set(writeDb$);
  const expiredCacheKeys = fixture.pairs
    .filter((_, index) => {
      return index % 10 === 0;
    })
    .map((pair) => {
      return pair.cacheKey;
    });
  const expiredAt = new Date(nowDate().getTime() - 60_000);
  await db
    .update(systemStoragePresignedUrlCache)
    .set({
      expiresAt: expiredAt,
      refreshAfter: expiredAt,
      updatedAt: expiredAt,
    })
    .where(inArray(systemStoragePresignedUrlCache.cacheKey, expiredCacheKeys));
  await resolveFixture(fixture, useMixedLookup, expiredCacheKeys.length);
}

const ensureSeeded: () => Promise<ReadonlyMap<number, BenchFixture>> = (() => {
  let cached: Promise<ReadonlyMap<number, BenchFixture>> | undefined;
  return () => {
    cached ??= (async () => {
      const label = `storage-cache-bench-${randomUUID()}`;
      const fixtures = new Map(
        BENCH_SIZES.map((size) => {
          return [size, benchFixture(size, `${label}-${String(size)}`)];
        }),
      );
      await insertChunks([
        ...backgroundRows(label),
        ...[...fixtures.values()].flatMap((fixture) => {
          return fixture.rows;
        }),
      ]);
      const db = store.set(writeDb$);
      await db.execute(sql`ANALYZE ${systemStoragePresignedUrlCache}`);
      const planFixture = fixtures.get(17);
      if (!planFixture) {
        throw new Error("Missing 17-pair storage cache benchmark fixture");
      }
      await logQueryPlan(planFixture);
      return fixtures;
    })();
    return cached;
  };
})();

function fixtureAt(
  fixtures: ReadonlyMap<number, BenchFixture>,
  size: number,
): BenchFixture {
  const fixture = fixtures.get(size);
  if (!fixture) {
    throw new Error(`Missing storage cache benchmark fixture ${String(size)}`);
  }
  return fixture;
}

test(
  "bench storage manifest cache lookup consolidation",
  { timeout: 180_000 },
  async ({ bench }) => {
    const fixtures = await ensureSeeded();
    for (const size of BENCH_SIZES) {
      const fixture = fixtureAt(fixtures, size);
      await bench(`current per-scope lookup ${String(size)}`, async () => {
        await resolveFixture(fixture, false);
      }).run(benchOptions);
      await bench(`bounded mixed lookup ${String(size)}`, async () => {
        await resolveFixture(fixture, true);
      }).run(benchOptions);
    }

    const concurrentFixture = fixtureAt(fixtures, 17);
    await bench("current per-scope lookup 17 with expired rows", async () => {
      await resolveFixtureWithExpiredRows(concurrentFixture, false);
    }).run(benchOptions);
    await bench("bounded mixed lookup 17 with expired rows", async () => {
      await resolveFixtureWithExpiredRows(concurrentFixture, true);
    }).run(benchOptions);

    await bench("current per-scope lookup 17 x32", async () => {
      await Promise.all(
        Array.from({ length: 32 }, async () => {
          await resolveFixture(concurrentFixture, false);
        }),
      );
    }).run(benchOptions);
    await bench("bounded mixed lookup 17 x32", async () => {
      await Promise.all(
        Array.from({ length: 32 }, async () => {
          await resolveFixture(concurrentFixture, true);
        }),
      );
    }).run(benchOptions);
  },
);
