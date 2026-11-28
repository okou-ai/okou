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
  findActiveFileArtifacts(
    fileId: string,
  ): Promise<readonly ArtifactVisibilityMatch[]>;
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

async function scanR2SharePolicies(
  store: R2PolicyObjectStore,
  segments: readonly ("okou" | "vm0")[],
  limit: number | undefined,
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

  for (const segment of segments) {
    const prefix = `artifact-shares/${segment}/`;
    for await (const key of store.listKeys(prefix)) {
      if (!key.endsWith(".json")) {
        continue;
      }
      if (limit !== undefined && scannedObjects >= limit) {
        return {
          scannedObjects,
          activeFilePolicies,
          htmlSnapshotPoliciesSkipped,
          revokedOrPrivatePolicies,
          invalidPolicies,
          desiredByFileId,
        };
      }
      scannedObjects += 1;

      const body = await store.getJsonText(key);
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

export async function runR2ArtifactVisibilityBackfill(
  store: R2PolicyObjectStore,
  repo: ArtifactVisibilityRepository,
  options: BackfillOptions,
): Promise<BackfillSummary> {
  const scan = await scanR2SharePolicies(
    store,
    options.segments ?? ["okou", "vm0"],
    options.limit,
  );

  let alreadySynced = 0;
  let plannedUpdates = 0;
  let appliedUpdates = 0;
  let concurrentSkips = 0;
  let unmatchedFilePolicies = 0;
  const sampleUnmatchedFileIds: string[] = [];

  for (const [fileId, targetVisibility] of scan.desiredByFileId.entries()) {
    const matches = await repo.findActiveFileArtifacts(fileId);
    if (matches.length === 0) {
      unmatchedFilePolicies += 1;
      if (sampleUnmatchedFileIds.length < 25) {
        sampleUnmatchedFileIds.push(fileId);
      }
      continue;
    }

    for (const match of matches) {
      if (
        VISIBILITY_RANK[match.visibility] >= VISIBILITY_RANK[targetVisibility]
      ) {
        alreadySynced += 1;
        continue;
      }

      plannedUpdates += 1;
      if (options.migrate) {
        const updated = await repo.updateVisibilityIfUnchanged(
          match.artifactId,
          match.visibility,
          targetVisibility,
        );
        if (updated) {
          appliedUpdates += 1;
        } else {
          concurrentSkips += 1;
        }
      }
    }
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

function createPgRepository(sql: postgres.Sql): ArtifactVisibilityRepository {
  return {
    async findActiveFileArtifacts(fileId: string) {
      const rows = await sql<{ id: string; visibility: BackfillVisibility }[]>`
        SELECT a.id, a.visibility
        FROM artifacts a
        WHERE a.deleted_at IS NULL
          AND (
            (a.kind = 'file' AND a.entity_id = ${fileId}::uuid)
            OR a.projection_file_id = ${fileId}::uuid
            OR (
              a.kind = 'image'
              AND EXISTS (
                SELECT 1
                FROM image_artifacts ia
                WHERE ia.id = a.entity_id
                  AND ia.file_id = ${fileId}::uuid
              )
            )
          )
      `;
      return rows.map((row) => {
        return { artifactId: row.id, visibility: row.visibility };
      });
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

function parseCliArgs(argv: readonly string[]): {
  migrate: boolean;
  bucket: string;
  limit?: number;
} {
  let migrate = false;
  let bucket = process.env.R2_HOSTED_SITES_BUCKET_NAME ?? "";
  let limit: number | undefined;

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
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!bucket) {
    throw new Error(
      "Set R2_HOSTED_SITES_BUCKET_NAME or pass --bucket <bucket-name>",
    );
  }
  return { migrate, bucket, limit };
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  const args = parseCliArgs(process.argv.slice(2));
  const store = createR2Store(args.bucket);
  const sql = postgres(databaseUrl, { max: 2, onnotice: () => {} });
  try {
    const summary = await runR2ArtifactVisibilityBackfill(
      store,
      createPgRepository(sql),
      { migrate: args.migrate, limit: args.limit },
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
