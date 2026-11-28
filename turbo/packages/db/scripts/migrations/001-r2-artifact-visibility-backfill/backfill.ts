import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  artifactSharePolicySchema,
  type ArtifactSharePolicy,
} from "@okouai/api-contracts/contracts/artifact-shares";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

export const DEFAULT_CONCURRENCY = 32;
const DEFAULT_DB_BATCH_SIZE = 300;

const MAX_DB_CONCURRENCY = 8;
const MAX_PG_POOL_SIZE = 16;
const UUID_PATTERN =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

export type BackfillVisibility = "private" | "organization" | "public";

export interface R2PolicyObjectStore {
  listKeys(prefix: string): AsyncIterable<string>;
  getJsonText(key: string): Promise<string | null>;
}

export interface ArtifactVisibilityMatch {
  readonly artifactId: string;
  readonly visibility: BackfillVisibility;
}

export interface ArtifactVisibilityRepository {
  findActiveFileArtifactsBatch(
    fileIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly ArtifactVisibilityMatch[]>>;
  updateVisibilityIfUnchanged(
    artifactId: string,
    previousVisibility: BackfillVisibility,
    nextVisibility: Exclude<BackfillVisibility, "private">,
  ): Promise<boolean>;
}

export interface BackfillOptions {
  readonly migrate: boolean;
  readonly segments?: readonly ("okou" | "vm0")[];
  readonly limit?: number;
  readonly concurrency?: number;
  readonly dbBatchSize?: number;
}

export interface BackfillSummary {
  readonly mode: "dry-run" | "migrate";
  readonly scannedObjects: number;
  readonly activeFilePolicies: number;
  readonly htmlSnapshotPoliciesSkipped: number;
  readonly revokedOrPrivatePolicies: number;
  readonly invalidPolicies: number;
  readonly uniqueActiveFiles: number;
  readonly alreadySynced: number;
  readonly plannedUpdates: number;
  readonly appliedUpdates: number;
  readonly concurrentSkips: number;
  readonly unmatchedFilePolicies: number;
  readonly sampleUnmatchedFileIds: readonly string[];
}

const VISIBILITY_RANK: Record<BackfillVisibility, number> = {
  private: 0,
  organization: 1,
  public: 2,
};

function higherVisibility(
  a: Exclude<BackfillVisibility, "private">,
  b: Exclude<BackfillVisibility, "private">,
): Exclude<BackfillVisibility, "private"> {
  return VISIBILITY_RANK[a] >= VISIBILITY_RANK[b] ? a : b;
}

function parsePolicy(text: string): ArtifactSharePolicy | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = artifactSharePolicySchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

interface ScanResult {
  readonly scannedObjects: number;
  readonly activeFilePolicies: number;
  readonly htmlSnapshotPoliciesSkipped: number;
  readonly revokedOrPrivatePolicies: number;
  readonly invalidPolicies: number;
  readonly desiredByFileId: ReadonlyMap<
    string,
    Exclude<BackfillVisibility, "private">
  >;
}

async function* iteratePolicyKeys(
  store: R2PolicyObjectStore,
  segments: readonly ("okou" | "vm0")[],
  limit: number | undefined,
): AsyncGenerator<string> {
  let yielded = 0;
  for (const segment of segments) {
    const prefix = `artifact-shares/${segment}/`;
    for await (const key of store.listKeys(prefix)) {
      if (!key.endsWith(".json")) {
        continue;
      }
      if (limit !== undefined && yielded >= limit) {
        return;
      }
      yielded += 1;
      yield key;
    }
  }
}

async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const workerCount = Math.min(concurrency, items.length);
  if (workerCount === 0) {
    return;
  }
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) {
          return;
        }
        const item = items[index];
        if (item !== undefined) {
          await worker(item);
        }
      }
    }),
  );
}

function chunkArray<T>(
  items: readonly T[],
  chunkSize: number,
): (readonly T[])[] {
  const chunks: (readonly T[])[] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

async function scanR2SharePolicies(
  store: R2PolicyObjectStore,
  segments: readonly ("okou" | "vm0")[],
  limit: number | undefined,
  concurrency: number,
): Promise<ScanResult> {
  let scannedObjects = 0;
  let activeFilePolicies = 0;
  let htmlSnapshotPoliciesSkipped = 0;
  let revokedOrPrivatePolicies = 0;
  let invalidPolicies = 0;
  const desiredByFileId = new Map<
    string,
    Exclude<BackfillVisibility, "private">
  >();

  const iterator = iteratePolicyKeys(store, segments, limit);
  let aborted = false;

  const worker = async (): Promise<void> => {
    while (!aborted) {
      const next = await iterator.next();
      if (next.done || aborted) {
        return;
      }
      scannedObjects += 1;

      const body = await store.getJsonText(next.value);
      const policy = body === null ? null : parsePolicy(body);
      if (!policy) {
        invalidPolicies += 1;
        continue;
      }
      if (policy.status !== "active" || policy.audience === "private") {
        revokedOrPrivatePolicies += 1;
        continue;
      }
      // Legacy private_hosted_deployments HTML snapshot shares are isolated from
      // modern live hosted sites; hosted_site_visibility was already backfilled
      // in migration 1655, so HTML policies must never mutate live site visibility.
      if (policy.target.kind === "html") {
        htmlSnapshotPoliciesSkipped += 1;
        continue;
      }

      activeFilePolicies += 1;
      const existing = desiredByFileId.get(policy.target.id);
      desiredByFileId.set(
        policy.target.id,
        existing
          ? higherVisibility(existing, policy.audience)
          : policy.audience,
      );
    }
  };

  try {
    await Promise.all(
      Array.from({ length: concurrency }, () => {
        return worker();
      }),
    );
  } catch (error) {
    aborted = true;
    throw error;
  } finally {
    await iterator.return(undefined);
  }

  return {
    scannedObjects,
    activeFilePolicies,
    htmlSnapshotPoliciesSkipped,
    revokedOrPrivatePolicies,
    invalidPolicies,
    desiredByFileId,
  };
}

interface DesiredArtifactState {
  currentVisibility: BackfillVisibility;
  targetVisibility: Exclude<BackfillVisibility, "private">;
}

function aggregateDesiredArtifacts(
  fileIds: readonly string[],
  desiredByFileId: ReadonlyMap<string, Exclude<BackfillVisibility, "private">>,
  matchesByFileId: ReadonlyMap<string, readonly ArtifactVisibilityMatch[]>,
): {
  desiredByArtifactId: Map<string, DesiredArtifactState>;
  unmatchedFilePolicies: number;
  sampleUnmatchedFileIds: string[];
} {
  let unmatchedFilePolicies = 0;
  const sampleUnmatchedFileIds: string[] = [];
  const desiredByArtifactId = new Map<string, DesiredArtifactState>();

  for (const fileId of fileIds) {
    const targetVisibility = desiredByFileId.get(fileId);
    if (!targetVisibility) {
      continue;
    }
    const matches = matchesByFileId.get(fileId) ?? [];
    if (matches.length === 0) {
      unmatchedFilePolicies += 1;
      if (sampleUnmatchedFileIds.length < 25) {
        sampleUnmatchedFileIds.push(fileId);
      }
      continue;
    }

    for (const match of matches) {
      const existing = desiredByArtifactId.get(match.artifactId);
      if (existing) {
        existing.targetVisibility = higherVisibility(
          existing.targetVisibility,
          targetVisibility,
        );
        if (
          VISIBILITY_RANK[match.visibility] >
          VISIBILITY_RANK[existing.currentVisibility]
        ) {
          existing.currentVisibility = match.visibility;
        }
      } else {
        desiredByArtifactId.set(match.artifactId, {
          currentVisibility: match.visibility,
          targetVisibility,
        });
      }
    }
  }

  return {
    desiredByArtifactId,
    unmatchedFilePolicies,
    sampleUnmatchedFileIds,
  };
}

export async function runR2ArtifactVisibilityBackfill(
  store: R2PolicyObjectStore,
  repo: ArtifactVisibilityRepository,
  options: BackfillOptions,
): Promise<BackfillSummary> {
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new Error("concurrency must be a positive integer");
  }
  const dbBatchSize = options.dbBatchSize ?? DEFAULT_DB_BATCH_SIZE;
  if (!Number.isInteger(dbBatchSize) || dbBatchSize <= 0) {
    throw new Error("dbBatchSize must be a positive integer");
  }

  const scan = await scanR2SharePolicies(
    store,
    options.segments ?? ["okou", "vm0"],
    options.limit,
    concurrency,
  );

  const fileIds = [...scan.desiredByFileId.keys()].sort();
  const dbConcurrency = Math.min(concurrency, MAX_DB_CONCURRENCY);
  const matchesByFileId = new Map<string, readonly ArtifactVisibilityMatch[]>();

  await runWithConcurrency(
    chunkArray(fileIds, dbBatchSize),
    dbConcurrency,
    async (chunk) => {
      const batchMatches = await repo.findActiveFileArtifactsBatch(chunk);
      for (const [fileId, matches] of batchMatches.entries()) {
        matchesByFileId.set(fileId, matches);
      }
    },
  );

  const { desiredByArtifactId, unmatchedFilePolicies, sampleUnmatchedFileIds } =
    aggregateDesiredArtifacts(fileIds, scan.desiredByFileId, matchesByFileId);

  let alreadySynced = 0;
  let plannedUpdates = 0;
  let appliedUpdates = 0;
  let concurrentSkips = 0;

  const updatesToApply: Array<{
    artifactId: string;
    previousVisibility: BackfillVisibility;
    nextVisibility: Exclude<BackfillVisibility, "private">;
  }> = [];

  for (const [artifactId, entry] of desiredByArtifactId.entries()) {
    if (
      VISIBILITY_RANK[entry.currentVisibility] >=
      VISIBILITY_RANK[entry.targetVisibility]
    ) {
      alreadySynced += 1;
      continue;
    }

    plannedUpdates += 1;
    if (options.migrate) {
      updatesToApply.push({
        artifactId,
        previousVisibility: entry.currentVisibility,
        nextVisibility: entry.targetVisibility,
      });
    }
  }

  if (options.migrate && updatesToApply.length > 0) {
    await runWithConcurrency(updatesToApply, dbConcurrency, async (update) => {
      const updated = await repo.updateVisibilityIfUnchanged(
        update.artifactId,
        update.previousVisibility,
        update.nextVisibility,
      );
      if (updated) {
        appliedUpdates += 1;
      } else {
        concurrentSkips += 1;
      }
    });
  }

  return {
    mode: options.migrate ? "migrate" : "dry-run",
    scannedObjects: scan.scannedObjects,
    activeFilePolicies: scan.activeFilePolicies,
    htmlSnapshotPoliciesSkipped: scan.htmlSnapshotPoliciesSkipped,
    revokedOrPrivatePolicies: scan.revokedOrPrivatePolicies,
    invalidPolicies: scan.invalidPolicies,
    uniqueActiveFiles: scan.desiredByFileId.size,
    alreadySynced,
    plannedUpdates,
    appliedUpdates,
    concurrentSkips,
    unmatchedFilePolicies,
    sampleUnmatchedFileIds,
  };
}

function createR2Store(bucket: string): R2PolicyObjectStore {
  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "R2_ENDPOINT, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY are required",
    );
  }

  const client = new S3Client({
    region: "auto",
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
  });

  return {
    async *listKeys(prefix: string) {
      let continuationToken: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }),
        );
        for (const item of page.Contents ?? []) {
          if (item.Key) {
            yield item.Key;
          }
        }
        continuationToken = page.IsTruncated
          ? page.NextContinuationToken
          : undefined;
      } while (continuationToken);
    },
    async getJsonText(key: string) {
      const response = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      );
      if (!response.Body) {
        return null;
      }
      return response.Body.transformToString("utf8");
    },
  };
}

export function createPgRepository(
  sql: postgres.Sql,
): ArtifactVisibilityRepository {
  return {
    async findActiveFileArtifactsBatch(fileIds: readonly string[]) {
      const grouped = new Map<string, ArtifactVisibilityMatch[]>();
      if (fileIds.length === 0) {
        return grouped;
      }

      const rows = await sql<
        {
          input_file_id: string;
          artifact_id: string;
          visibility: BackfillVisibility;
        }[]
      >`
        WITH input_ids AS MATERIALIZED (
          SELECT DISTINCT unnest(${[...fileIds]}::uuid[]) AS input_file_id
        ),
        direct_links AS MATERIALIZED (
          SELECT i.input_file_id, i.input_file_id AS equiv_file_id
          FROM input_ids i
          UNION
          SELECT
            i.input_file_id,
            CASE
              WHEN ruf.external_id ~* ${UUID_PATTERN} THEN ruf.external_id::uuid
            END AS equiv_file_id
          FROM input_ids i
          INNER JOIN run_uploaded_files ruf ON ruf.id = i.input_file_id
          WHERE ruf.external_id ~* ${UUID_PATTERN}
          UNION
          SELECT i.input_file_id, ruf.id AS equiv_file_id
          FROM input_ids i
          INNER JOIN run_uploaded_files ruf
            ON lower(ruf.external_id) = i.input_file_id::text
        ),
        seed_keys AS MATERIALIZED (
          SELECT DISTINCT
            dl.input_file_id,
            COALESCE(
              NULLIF(ruf.storage_key, ''),
              NULLIF(ruf.metadata->>'s3Key', '')
            ) AS storage_key
          FROM direct_links dl
          INNER JOIN run_uploaded_files ruf ON ruf.id = dl.equiv_file_id
          WHERE COALESCE(
            NULLIF(ruf.storage_key, ''),
            NULLIF(ruf.metadata->>'s3Key', '')
          ) IS NOT NULL
          UNION
          SELECT DISTINCT
            dl.input_file_id,
            NULLIF(f.storage_key, '') AS storage_key
          FROM direct_links dl
          INNER JOIN files f ON f.id = dl.equiv_file_id
          WHERE NULLIF(f.storage_key, '') IS NOT NULL
        ),
        key_siblings AS MATERIALIZED (
          SELECT sk.input_file_id, ruf.id AS equiv_file_id
          FROM seed_keys sk
          INNER JOIN run_uploaded_files ruf
            ON COALESCE(
              NULLIF(ruf.storage_key, ''),
              NULLIF(ruf.metadata->>'s3Key', '')
            ) = sk.storage_key
          UNION
          SELECT sk.input_file_id, f.id AS equiv_file_id
          FROM seed_keys sk
          INNER JOIN files f
            ON f.storage_key = sk.storage_key
        ),
        equiv_ids AS MATERIALIZED (
          SELECT input_file_id, equiv_file_id FROM direct_links
          UNION
          SELECT input_file_id, equiv_file_id FROM key_siblings
          UNION
          SELECT
            ks.input_file_id,
            CASE
              WHEN ruf.external_id ~* ${UUID_PATTERN} THEN ruf.external_id::uuid
            END AS equiv_file_id
          FROM key_siblings ks
          INNER JOIN run_uploaded_files ruf ON ruf.id = ks.equiv_file_id
          WHERE ruf.external_id ~* ${UUID_PATTERN}
          UNION
          SELECT ks.input_file_id, ruf.id AS equiv_file_id
          FROM key_siblings ks
          INNER JOIN run_uploaded_files ruf
            ON lower(ruf.external_id) = ks.equiv_file_id::text
        ),
        matched_artifacts AS (
          SELECT e.input_file_id, a.id AS artifact_id, a.visibility
          FROM equiv_ids e
          INNER JOIN artifacts a
            ON a.kind = 'file'
            AND a.entity_id = e.equiv_file_id
            AND a.deleted_at IS NULL
          UNION
          SELECT e.input_file_id, a.id AS artifact_id, a.visibility
          FROM equiv_ids e
          INNER JOIN artifacts a
            ON a.projection_file_id = e.equiv_file_id
            AND a.deleted_at IS NULL
          UNION
          SELECT e.input_file_id, a.id AS artifact_id, a.visibility
          FROM equiv_ids e
          INNER JOIN image_artifacts ia ON ia.file_id = e.equiv_file_id
          INNER JOIN artifacts a
            ON a.kind = 'image'
            AND a.entity_id = ia.id
            AND a.deleted_at IS NULL
          UNION
          SELECT e.input_file_id, a.id AS artifact_id, a.visibility
          FROM equiv_ids e
          INNER JOIN video_artifacts va ON va.file_id = e.equiv_file_id
          INNER JOIN artifacts a
            ON a.kind = 'video'
            AND a.entity_id = va.id
            AND a.deleted_at IS NULL
        )
        SELECT input_file_id, artifact_id, visibility
        FROM matched_artifacts
      `;

      for (const row of rows) {
        const list = grouped.get(row.input_file_id) ?? [];
        list.push({
          artifactId: row.artifact_id,
          visibility: row.visibility,
        });
        grouped.set(row.input_file_id, list);
      }

      return grouped;
    },
    async updateVisibilityIfUnchanged(
      artifactId: string,
      previousVisibility: BackfillVisibility,
      nextVisibility: Exclude<BackfillVisibility, "private">,
    ) {
      const updated = await sql<{ id: string }[]>`
        UPDATE artifacts
        SET visibility = ${nextVisibility},
            updated_at = now()
        WHERE id = ${artifactId}::uuid
          AND visibility = ${previousVisibility}
          AND deleted_at IS NULL
        RETURNING id
      `;
      return updated.length > 0;
    },
  };
}

export function parseCliArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): {
  migrate: boolean;
  bucket: string;
  limit?: number;
  concurrency: number;
} {
  let migrate = false;
  let bucket = env.R2_HOSTED_SITES_BUCKET_NAME ?? "";
  let limit: number | undefined;
  let concurrency = DEFAULT_CONCURRENCY;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--migrate") {
      migrate = true;
    } else if (arg === "--dry-run") {
      migrate = false;
    } else if (arg === "--bucket") {
      bucket = argv[++i] ?? "";
    } else if (arg === "--limit") {
      const raw = Number(argv[++i]);
      if (!Number.isInteger(raw) || raw <= 0) {
        throw new Error("--limit must be a positive integer");
      }
      limit = raw;
    } else if (arg === "--concurrency") {
      const raw = Number(argv[++i]);
      if (!Number.isInteger(raw) || raw <= 0) {
        throw new Error("--concurrency must be a positive integer");
      }
      concurrency = raw;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!bucket) {
    throw new Error(
      "Set R2_HOSTED_SITES_BUCKET_NAME or pass --bucket <bucket-name>",
    );
  }
  return { migrate, bucket, limit, concurrency };
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  const args = parseCliArgs(process.argv.slice(2));
  const store = createR2Store(args.bucket);
  const poolMax = Math.min(Math.max(args.concurrency, 4), MAX_PG_POOL_SIZE);
  const sql = postgres(databaseUrl, { max: poolMax, onnotice: () => {} });
  try {
    const summary = await runR2ArtifactVisibilityBackfill(
      store,
      createPgRepository(sql),
      {
        migrate: args.migrate,
        limit: args.limit,
        concurrency: args.concurrency,
      },
    );
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await sql.end();
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
