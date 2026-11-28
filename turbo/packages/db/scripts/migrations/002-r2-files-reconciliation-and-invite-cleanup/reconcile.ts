import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

export interface UnclaimedInviteCounts {
  readonly hostedSiteSharesUnclaimed: number;
  readonly artifactFileSharesUnclaimed: number;
}

export interface FilesParityAudit {
  readonly missingRealFilesInFilesCount: number;
  readonly emptyOrgFilesCount: number;
  readonly sitePseudoRowsInFilesCount: number;
  readonly orphanImageArtifactsShadowCount: number;
  readonly orphanImageArtifactsOtherCount: number;
  readonly legacyVideoArtifactsCount: number;
  readonly claimedSharesMissingInArtifactUserSharesCount: number;
}

export interface ReconciliationRepository {
  countUnclaimedInvites(): Promise<UnclaimedInviteCounts>;
  deleteUnclaimedHostedSiteSharesBatch(limit: number): Promise<number>;
  deleteUnclaimedArtifactFileSharesBatch(limit: number): Promise<number>;
  auditFilesParity(): Promise<FilesParityAudit>;
}

export interface ReconciliationOptions {
  readonly migrate: boolean;
  readonly batchSize?: number;
}

export interface ReconciliationSummary {
  readonly mode: "dry-run" | "migrate";
  readonly beforeUnclaimedInvites: UnclaimedInviteCounts;
  readonly deletedHostedSiteShares: number;
  readonly deletedArtifactFileShares: number;
  readonly afterUnclaimedInvites: UnclaimedInviteCounts;
  readonly parityAudit: FilesParityAudit;
  readonly hasStrictFailures: boolean;
}

export async function runR2FilesReconciliationAndInviteCleanup(
  repo: ReconciliationRepository,
  options: ReconciliationOptions,
): Promise<ReconciliationSummary> {
  const batchSize = options.batchSize ?? 1000;
  const beforeUnclaimedInvites = await repo.countUnclaimedInvites();

  let deletedHostedSiteShares = 0;
  let deletedArtifactFileShares = 0;

  if (options.migrate) {
    while (true) {
      const removed =
        await repo.deleteUnclaimedHostedSiteSharesBatch(batchSize);
      deletedHostedSiteShares += removed;
      if (removed < batchSize) {
        break;
      }
    }
    while (true) {
      const removed =
        await repo.deleteUnclaimedArtifactFileSharesBatch(batchSize);
      deletedArtifactFileShares += removed;
      if (removed < batchSize) {
        break;
      }
    }
  }

  const afterUnclaimedInvites = options.migrate
    ? await repo.countUnclaimedInvites()
    : beforeUnclaimedInvites;
  const parityAudit = await repo.auditFilesParity();

  const hasStrictFailures =
    parityAudit.missingRealFilesInFilesCount > 0 ||
    parityAudit.emptyOrgFilesCount > 0 ||
    parityAudit.sitePseudoRowsInFilesCount > 0 ||
    parityAudit.claimedSharesMissingInArtifactUserSharesCount > 0 ||
    (options.migrate &&
      (afterUnclaimedInvites.hostedSiteSharesUnclaimed > 0 ||
        afterUnclaimedInvites.artifactFileSharesUnclaimed > 0));

  return {
    mode: options.migrate ? "migrate" : "dry-run",
    beforeUnclaimedInvites,
    deletedHostedSiteShares,
    deletedArtifactFileShares,
    afterUnclaimedInvites,
    parityAudit,
    hasStrictFailures,
  };
}

function createPgRepository(sql: postgres.Sql): ReconciliationRepository {
  return {
    async countUnclaimedInvites() {
      const [siteRow] = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count
        FROM hosted_site_shares
        WHERE user_id IS NULL
      `;
      const [fileRow] = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count
        FROM artifact_file_shares
        WHERE user_id IS NULL
      `;
      return {
        hostedSiteSharesUnclaimed: Number(siteRow?.count ?? 0),
        artifactFileSharesUnclaimed: Number(fileRow?.count ?? 0),
      };
    },
    async deleteUnclaimedHostedSiteSharesBatch(limit: number) {
      const deleted = await sql<{ id: string }[]>`
        WITH doomed AS (
          SELECT id
          FROM hosted_site_shares
          WHERE user_id IS NULL
          ORDER BY id
          LIMIT ${limit}
        )
        DELETE FROM hosted_site_shares h
        USING doomed
        WHERE h.id = doomed.id
        RETURNING h.id
      `;
      return deleted.length;
    },
    async deleteUnclaimedArtifactFileSharesBatch(limit: number) {
      const deleted = await sql<{ id: string }[]>`
        WITH doomed AS (
          SELECT id
          FROM artifact_file_shares
          WHERE user_id IS NULL
          ORDER BY id
          LIMIT ${limit}
        )
        DELETE FROM artifact_file_shares a
        USING doomed
        WHERE a.id = doomed.id
        RETURNING a.id
      `;
      return deleted.length;
    },
    async auditFilesParity() {
      const [missingReal] = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count
        FROM run_uploaded_files ruf
        LEFT JOIN chat_threads ct ON ct.id = ruf.chat_thread_id
        LEFT JOIN agent_runs ar ON ar.id = ruf.run_id
        WHERE NOT (ruf.metadata ? 'siteId')
          AND COALESCE(ruf.metadata->>'generatedBy', '') <> 'zero-official-website'
          AND NOT (
            NULLIF(ruf.storage_key, '') IS NULL
            AND EXISTS (
              SELECT 1
              FROM run_uploaded_files real_file
              WHERE real_file.id = CASE
                  WHEN ruf.external_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  THEN ruf.external_id::uuid
                  ELSE NULL
                END
                AND real_file.id <> ruf.id
                AND NULLIF(real_file.storage_key, '') IS NOT NULL
            )
          )
          AND COALESCE(NULLIF(ruf.org_id, ''), NULLIF(ct.org_id, ''), NULLIF(ar.org_id, '')) IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM files f WHERE f.id = ruf.id
          )
      `;
      const [emptyOrg] = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count
        FROM files
        WHERE length(org_id) = 0
      `;
      const [sitePseudo] = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count
        FROM files f
        INNER JOIN run_uploaded_files ruf ON ruf.id = f.id
        WHERE (ruf.metadata ? 'siteId')
          OR COALESCE(ruf.metadata->>'generatedBy', '') = 'zero-official-website'
      `;
      const [orphanImages] = await sql<
        { shadow_count: string; other_count: string }[]
      >`
        SELECT
          count(*) FILTER (
            WHERE ruf.id IS NOT NULL
              AND NULLIF(ruf.storage_key, '') IS NULL
              AND ruf.external_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          )::text AS shadow_count,
          count(*) FILTER (
            WHERE NOT (
              ruf.id IS NOT NULL
              AND NULLIF(ruf.storage_key, '') IS NULL
              AND ruf.external_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            )
          )::text AS other_count
        FROM image_artifacts ia
        LEFT JOIN run_uploaded_files ruf ON ruf.id = ia.file_id
        WHERE NOT EXISTS (
          SELECT 1 FROM files f WHERE f.id = ia.file_id
        )
      `;
      const [legacyVideos] = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count
        FROM artifacts
        WHERE kind = 'video' OR display_kind = 'video'
      `;
      const [sharesGap] = await sql<{ count: string }[]>`
        SELECT (
          (
            SELECT count(*)
            FROM artifact_file_shares afs
            INNER JOIN artifacts a
              ON a.deleted_at IS NULL
              AND (
                a.projection_file_id = afs.file_id
                OR (a.kind = 'file' AND a.entity_id = afs.file_id)
                OR (
                  a.kind = 'image'
                  AND EXISTS (
                    SELECT 1 FROM image_artifacts ia
                    WHERE ia.id = a.entity_id AND ia.file_id = afs.file_id
                  )
                )
              )
            WHERE afs.user_id IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM artifact_user_shares aus
                WHERE aus.user_id = afs.user_id
                  AND aus.org_id = a.org_id
                  AND aus.artifact_id = a.id
              )
          ) + (
            SELECT count(*)
            FROM hosted_site_shares hss
            INNER JOIN artifacts a
              ON a.deleted_at IS NULL
              AND (
                (a.kind = 'hosted-site' AND a.entity_id = hss.site_id)
                OR (
                  a.kind = 'presentation'
                  AND EXISTS (
                    SELECT 1 FROM presentation_artifacts pa
                    WHERE pa.id = a.entity_id AND pa.hosted_site_id = hss.site_id
                  )
                )
                OR a.logical_key = 'site:' || hss.site_id::text
              )
            WHERE hss.user_id IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM artifact_user_shares aus
                WHERE aus.user_id = hss.user_id
                  AND aus.org_id = a.org_id
                  AND aus.artifact_id = a.id
              )
          )
        )::text AS count
      `;
      return {
        missingRealFilesInFilesCount: Number(missingReal?.count ?? 0),
        emptyOrgFilesCount: Number(emptyOrg?.count ?? 0),
        sitePseudoRowsInFilesCount: Number(sitePseudo?.count ?? 0),
        orphanImageArtifactsShadowCount: Number(
          orphanImages?.shadow_count ?? 0,
        ),
        orphanImageArtifactsOtherCount: Number(orphanImages?.other_count ?? 0),
        legacyVideoArtifactsCount: Number(legacyVideos?.count ?? 0),
        claimedSharesMissingInArtifactUserSharesCount: Number(
          sharesGap?.count ?? 0,
        ),
      };
    },
  };
}

function parseCliArgs(argv: readonly string[]): {
  migrate: boolean;
  strict: boolean;
} {
  let migrate = false;
  let strict = false;
  for (const arg of argv) {
    if (arg === "--migrate") {
      migrate = true;
    } else if (arg === "--dry-run") {
      migrate = false;
    } else if (arg === "--strict") {
      strict = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { migrate, strict };
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  const args = parseCliArgs(process.argv.slice(2));
  const sql = postgres(databaseUrl, { max: 2, onnotice: () => {} });
  try {
    const summary = await runR2FilesReconciliationAndInviteCleanup(
      createPgRepository(sql),
      { migrate: args.migrate },
    );
    console.log(JSON.stringify(summary, null, 2));
    if (args.strict && summary.hasStrictFailures) {
      process.exitCode = 1;
    }
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
