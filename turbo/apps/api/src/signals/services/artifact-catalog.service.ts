import { command } from "ccstate";
import { linkLayoutFromSegment } from "@okouai/api-contracts/contracts/link-layout";
import { hostedLinkOrigin } from "../../lib/link-layout";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  ilike,
  inArray,
  isNull,
  isNotNull,
  ne,
  notExists,
  lt,
  lte,
  sql,
  type SQL,
} from "drizzle-orm";
import type {
  ArtifactCatalogKind,
  ArtifactDetail,
  ArtifactSummary,
} from "@okouai/api-contracts/contracts/artifact-catalog";
import {
  artifactCatalogPendingFiles,
  artifacts,
  imageArtifacts,
  presentationArtifacts,
  videoArtifacts,
  type ArtifactKind,
  type ArtifactThumbnail,
} from "@okouai/db/schema/artifact";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import {
  hostedDeployments,
  hostedSites,
  privateHostedDeployments,
} from "@okouai/db/runtime/hosted-site";
import {
  runUploadedFiles,
  type CanonicalAssetClassification,
} from "@okouai/db/schema/run-uploaded-file";
import * as z from "zod";

import { canonicalOkouArtifactCatalogUrl } from "../../lib/file-url";
import {
  nullableDriverValueDecoder,
  pgIntegerDecoder,
  pgTextDecoder,
} from "../../lib/db-structured-result";
import { monotonicNow, nowDate } from "../../lib/time";
import { logger } from "../../lib/log";
import {
  isSharedThreadArtifactLogicalKey,
  sharedThreadArtifactAuthorUserId,
} from "../../lib/shared-thread-artifact";
import { db$, writeDb$ } from "../external/db";
import { safeUrlParse, settle } from "../utils";
import { inferMimetype } from "./chat-event-shared.service";

const ARTIFACT_CATALOG_DEFAULT_LIMIT = 60;
const ARTIFACT_CATALOG_WORKER_BATCH_SIZE = 100;
const ARTIFACT_CATALOG_WORKER_BUDGET_MS = 20_000;
const L = logger("ArtifactCatalog");

/**
 * `generatedBy` markers written by the built-in generation pipelines. They are
 * the only signal that separates an officially generated image or video from an
 * ordinary upload that happens to share a content type.
 */
const OFFICIAL_IMAGE_MARKER = "zero-official-image";
const OFFICIAL_VIDEO_MARKER = "zero-official-video";
const AVATAR_VIDEO_MARKER = "zero-joggai-avatar-video";

const artifactCursorSchema = z.object({
  createdAt: z.string(),
  id: z.string(),
});
type ArtifactCursor = z.infer<typeof artifactCursorSchema>;

function encodeArtifactCursor(cursor: ArtifactCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeArtifactCursor(raw: string): ArtifactCursor {
  return artifactCursorSchema.parse(
    JSON.parse(Buffer.from(raw, "base64url").toString("utf8")),
  );
}

interface CatalogFileRow {
  readonly id: string;
  readonly runId: string | null;
  readonly chatThreadId: string | null;
  readonly userId: string;
  readonly orgId: string | null;
  readonly filename: string | null;
  readonly externalId: string;
  readonly contentType: string | null;
  readonly url: string | null;
  readonly previewImageUrl: string | null;
  readonly metadata: Record<string, unknown>;
  readonly classification: CanonicalAssetClassification | null;
  readonly createdAt: Date;
}

function metadataString(
  metadata: Record<string, unknown>,
  key: string,
): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Whether a stored file belongs in the catalog at all. File writers queue
 * rows that gain a URL, including attachments the user handed to the agent;
 * this is where attachments are separated from the agent's own outputs.
 *
 * An upload declaring `purpose: "artifact"` is one, and every producer of an
 * artifact output declares it — including the generation and download paths
 * that can run without a run. A chat or integration attachment is not, and
 * neither is a private upload's ownership record that no run produced and no
 * uploader claimed: a composer attachment still sitting in a draft.
 *
 * Only versioned private storage identifies that ownership record, so a row
 * without the storage marker keeps the catalog behavior it had before private
 * artifacts existed. Surface: DB versus API, for rows written by earlier API
 * versions (`docs/fallback.md` §7). Remove this clause once the historical
 * public artifact objects and their references are migrated or retired, which
 * is tracked with the matching public-object readers under #32492.
 */
function isCatalogArtifactFile(row: CatalogFileRow): boolean {
  if (metadataString(row.metadata, "purpose") === "artifact") {
    return true;
  }
  if (row.classification === "input") {
    return false;
  }
  return metadataString(row.metadata, "storage") === null || row.runId !== null;
}

/**
 * The catalog kind a stored file maps to. Ordinary uploads of every media type
 * stay `file`; only the official generation pipelines produce `image`/`video`.
 */
function fileArtifactKind(row: CatalogFileRow): "file" | "image" | "video" {
  const generatedBy = metadataString(row.metadata, "generatedBy");
  if (generatedBy === OFFICIAL_IMAGE_MARKER) {
    return "image";
  }
  if (
    generatedBy === OFFICIAL_VIDEO_MARKER ||
    generatedBy === AVATAR_VIDEO_MARKER
  ) {
    return "video";
  }
  return "file";
}

/**
 * Avatar is a catalog projection over the existing video storage kind. Keeping
 * the persisted kind readable as `video` lets the previous API version keep
 * serving during rollout, while generated JoggAI videos appear in the
 * dedicated category on the new API.
 */
function catalogArtifactKind(
  kind: ArtifactKind,
  metadata: Record<string, unknown> | null,
  logicalKey: string,
): ArtifactCatalogKind {
  if (kind === "file" && isSharedThreadArtifactLogicalKey(logicalKey)) {
    return "shared-thread";
  }
  return metadata &&
    metadataString(metadata, "generatedBy") === AVATAR_VIDEO_MARKER
    ? "avatar"
    : kind;
}

function artifactCatalogKindFilter(kind: ArtifactCatalogKind): SQL {
  // Summary metadata is optional independently of creating-thread ownership.
  // An absent display projection retains the base kind (or the shared snapshot
  // kind encoded in its logical key), exactly as toArtifactSummary does.
  return eq(
    sql`coalesce(${artifacts.displayKind}, case
      when ${artifacts.kind} = 'file'
        and ${artifacts.logicalKey} like 'shared-thread:%'
      then 'shared-thread'
      else ${artifacts.kind}
    end)`,
    kind,
  );
}

function hostedArtifactKind(
  row: CatalogFileRow,
): "hosted-site" | "presentation" | null {
  const artifactKind = metadataString(row.metadata, "artifactKind");
  if (artifactKind === "hosted-site") {
    return "hosted-site";
  }
  if (artifactKind === "presentation-html") {
    return "presentation";
  }
  return null;
}

function videoSourceUrl(row: CatalogFileRow, title: string): string | null {
  const contentType = row.contentType ?? inferMimetype(title);
  return row.url && contentType.startsWith("video/") ? row.url : null;
}

function fileThumbnail(row: CatalogFileRow): ArtifactThumbnail | null {
  if (row.previewImageUrl) {
    return { url: row.previewImageUrl };
  }
  const filename = row.filename ?? row.externalId;
  const contentType = row.contentType ?? inferMimetype(filename);
  if (row.url && contentType.startsWith("image/")) {
    return { url: row.url };
  }
  return null;
}

/**
 * Resolve the artifact author from the file's persisted thread, so integration
 * files are filed under the thread's Okou account rather than the external
 * sender.
 */
const resolveArtifactOwnership$ = command(
  async (
    { get },
    row: CatalogFileRow,
    signal: AbortSignal,
  ): Promise<{ authorUserId: string; chatThreadId: string | null }> => {
    const db = get(db$);

    // A source thread can disappear while its integration file survives. Its
    // external sender must not replace the catalog's already-established owner
    // on a delayed preview/sync and cause deletion/reinsertion under a new key.
    if (row.orgId) {
      const [existing] = await db
        .select({
          authorUserId: artifacts.authorUserId,
          chatThreadId: artifacts.chatThreadId,
        })
        .from(artifacts)
        .where(
          and(
            eq(artifacts.orgId, row.orgId),
            eq(artifacts.projectionFileId, row.id),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      if (existing) {
        return existing;
      }
    }

    if (!row.chatThreadId) {
      return { authorUserId: row.userId, chatThreadId: null };
    }

    const [thread] = await db
      .select({ userId: chatThreads.userId })
      .from(chatThreads)
      .where(eq(chatThreads.id, row.chatThreadId))
      .limit(1);
    signal.throwIfAborted();
    return {
      authorUserId: thread?.userId ?? row.userId,
      chatThreadId: thread ? row.chatThreadId : null,
    };
  },
);

const readCatalogFileRow$ = command(
  async (
    { get },
    fileId: string,
    signal: AbortSignal,
  ): Promise<CatalogFileRow | null> => {
    const db = get(db$);
    const [row] = await db
      .select({
        id: runUploadedFiles.id,
        runId: runUploadedFiles.runId,
        chatThreadId: runUploadedFiles.chatThreadId,
        userId: runUploadedFiles.userId,
        orgId: runUploadedFiles.orgId,
        filename: runUploadedFiles.filename,
        externalId: runUploadedFiles.externalId,
        contentType: runUploadedFiles.contentType,
        url: runUploadedFiles.url,
        previewImageUrl: runUploadedFiles.previewImageUrl,
        metadata: runUploadedFiles.metadata,
        classification: runUploadedFiles.classification,
        createdAt: runUploadedFiles.createdAt,
      })
      .from(runUploadedFiles)
      .where(eq(runUploadedFiles.id, fileId))
      .limit(1);
    signal.throwIfAborted();
    return row ?? null;
  },
);

/**
 * SQL-only handoff, executed by the command that owns the file mutation.
 * An optional mutation must return id, org_id, user_id, chat_thread_id and url.
 * Its RETURNING rows supply the handoff's current file values because a sibling
 * CTE cannot see the mutation by rereading the base table.
 * `if-mutated` also gates ineligible cleanup on a returned row; the default
 * retains cleanup for a missing file, including an empty mutation result.
 */
export function queueArtifactCatalogFileSql(
  fileId: string,
  fileMutation?: SQL,
): SQL;
export function queueArtifactCatalogFileSql(
  fileId: string,
  fileMutation: SQL,
  handoff: "if-mutated",
): SQL;
export function queueArtifactCatalogFileSql(
  fileId: string,
  fileMutation?: SQL,
  handoff?: "if-mutated",
): SQL {
  const { ctes, queue } = artifactCatalogFileHandoffSql(
    sql`${sql.param(fileId, runUploadedFiles.id)}`,
    fileMutation
      ? eq(sql`mutated_file.id`, fileId)
      : eq(runUploadedFiles.id, fileId),
    fileMutation,
    handoff,
  );
  return sql`${ctes}${queue}`;
}

/** Skip all handoff work for an unchanged file and return the mutation outcome. */
export function queueChangedArtifactCatalogFileSql(
  fileId: string,
  fileMutation: SQL,
): SQL {
  const { ctes, queue } = artifactCatalogFileHandoffSql(
    sql`${sql.param(fileId, runUploadedFiles.id)}`,
    eq(sql`mutated_file.id`, fileId),
    fileMutation,
    "if-mutated",
  );
  return sql`${ctes}, queued_file AS (${queue})
    SELECT EXISTS(SELECT 1 FROM mutated_file) AS changed
  `;
}

/** Return an upsert's identity and preview after admitting its durable handoff. */
export function queueRecordedArtifactCatalogFileSql(fileMutation: SQL): SQL {
  const fileId = sql`(SELECT id FROM mutated_file)`;
  const { ctes, queue } = artifactCatalogFileHandoffSql(
    fileId,
    eq(sql`mutated_file.id`, fileId),
    fileMutation,
    "if-mutated",
  );
  return sql`${ctes}, queued_file AS (${queue})
    SELECT id, preview_image_url AS "previewImageUrl" FROM mutated_file
  `;
}

function artifactCatalogFileHandoffSql(
  fileId: SQL,
  identityCondition: SQL,
  fileMutation?: SQL,
  handoff?: "if-mutated",
) {
  const file = fileMutation
    ? {
        id: sql`mutated_file.id`,
        orgId: sql`mutated_file.org_id`,
        userId: sql`mutated_file.user_id`,
        chatThreadId: sql`mutated_file.chat_thread_id`,
        url: sql`mutated_file.url`,
      }
    : runUploadedFiles;
  const source = fileMutation ? sql`mutated_file` : sql`${runUploadedFiles}`;
  const mutationCte = fileMutation
    ? sql`mutated_file AS (${fileMutation}),`
    : sql.empty();
  const nonEmptyUrl = fileMutation
    ? ne(sql`mutated_file.url`, "")
    : ne(runUploadedFiles.url, "");
  const nonEmptyOrg = fileMutation
    ? ne(sql`mutated_file.org_id`, "")
    : ne(runUploadedFiles.orgId, "");
  const cleanupCondition =
    handoff === "if-mutated"
      ? sql`${exists(sql`(SELECT 1 FROM mutated_file)`)} AND ${notExists(sql`(SELECT 1 FROM eligible_file)`)}`
      : notExists(sql`(SELECT 1 FROM eligible_file)`);
  const ctes = sql`
    WITH ${mutationCte}eligible_file AS (
      SELECT ${file.id} AS file_id,
             ${file.orgId} AS org_id,
             COALESCE((
               SELECT ${chatThreads.userId}
               FROM ${chatThreads}
               WHERE ${eq(chatThreads.id, file.chatThreadId)}
               LIMIT 1
             ), ${file.userId}) AS author_user_id
      FROM ${source}
      WHERE ${identityCondition}
        AND ${isNotNull(file.url)} AND ${nonEmptyUrl}
        AND ${isNotNull(file.orgId)} AND ${nonEmptyOrg}
    ), removed_artifacts AS (
      DELETE FROM ${artifacts}
      WHERE ${eq(artifacts.projectionFileId, fileId)}
        AND ${cleanupCondition}
    ), removed_pending AS (
      DELETE FROM ${artifactCatalogPendingFiles}
      WHERE ${eq(artifactCatalogPendingFiles.fileId, fileId)}
        AND ${cleanupCondition}
    )`;
  const queue = sql`
    INSERT INTO ${artifactCatalogPendingFiles} (file_id, org_id, author_user_id, queued_at)
    SELECT file_id, org_id, author_user_id, clock_timestamp() FROM eligible_file
    ON CONFLICT (file_id) DO UPDATE SET
      org_id = excluded.org_id,
      author_user_id = excluded.author_user_id,
      queued_at = clock_timestamp()
  `;
  return { ctes, queue };
}

interface UpsertArtifactArgs {
  readonly kind: ArtifactKind;
  readonly displayKind: ArtifactCatalogKind;
  readonly sourceUrl: string | null;
  readonly aliasUrl: string | null;
  readonly videoSourceUrl: string | null;
  readonly chatThreadId: string | null;
  readonly entityId: string;
  readonly logicalKey: string;
  readonly projectionFileId: string;
  readonly projectionCreatedAt: Date;
  readonly orgId: string;
  readonly authorUserId: string;
  readonly title: string;
  readonly thumbnail: ArtifactThumbnail | null;
  readonly createdAt: Date;
}

/**
 * Idempotent registry write. `created_at` is never updated, so re-running the
 * sync (redeploy, preview render, backfill replay) keeps the artifact in its
 * original list position. Thread ownership is also insert-only: a replacement
 * projection cannot move the artifact, including after deletion clears its FK.
 */
function artifactUpsertPlan(args: UpsertArtifactArgs) {
  return {
    values: {
      kind: args.kind,
      displayKind: args.displayKind,
      sourceUrl: args.sourceUrl,
      aliasUrl: args.aliasUrl,
      videoSourceUrl: args.videoSourceUrl,
      chatThreadId: args.chatThreadId,
      entityId: args.entityId,
      logicalKey: args.logicalKey,
      projectionFileId: args.projectionFileId,
      projectionCreatedAt: args.projectionCreatedAt,
      orgId: args.orgId,
      authorUserId: args.authorUserId,
      title: args.title,
      thumbnail: args.thumbnail,
      createdAt: args.createdAt,
    },
    conflict: {
      target: [artifacts.orgId, artifacts.authorUserId, artifacts.logicalKey],
      set: {
        kind: args.kind,
        displayKind: args.displayKind,
        sourceUrl: args.sourceUrl,
        aliasUrl: args.aliasUrl,
        videoSourceUrl: args.videoSourceUrl,
        entityId: args.entityId,
        projectionFileId: args.projectionFileId,
        projectionCreatedAt: args.projectionCreatedAt,
        orgId: args.orgId,
        authorUserId: args.authorUserId,
        title: args.title,
        thumbnail: args.thumbnail,
        updatedAt: nowDate(),
      },
      setWhere: lte(
        sql`(${artifacts.projectionCreatedAt}, ${artifacts.projectionFileId})`,
        sql`(excluded.projection_created_at, excluded.projection_file_id)`,
      ),
    },
  };
}

const upsertGeneratedMediaEntity$ = command(
  async (
    { set },
    args: {
      readonly kind: "image" | "video";
      readonly row: CatalogFileRow;
    },
    signal: AbortSignal,
  ): Promise<string | null> => {
    const db = set(writeDb$);

    const model = metadataString(args.row.metadata, "model");
    if (args.kind === "image") {
      const [entity] = await db
        .insert(imageArtifacts)
        .values({
          fileId: args.row.id,
          model,
          provider: metadataString(args.row.metadata, "provider"),
        })
        .onConflictDoUpdate({
          target: [imageArtifacts.fileId],
          set: {
            model,
            provider: metadataString(args.row.metadata, "provider"),
            updatedAt: nowDate(),
          },
        })
        .returning({ id: imageArtifacts.id });
      signal.throwIfAborted();
      return entity?.id ?? null;
    }

    const durationSeconds = args.row.metadata.durationSeconds;
    const [entity] = await db
      .insert(videoArtifacts)
      .values({
        fileId: args.row.id,
        model,
        durationSeconds:
          typeof durationSeconds === "number"
            ? Math.round(durationSeconds)
            : null,
      })
      .onConflictDoUpdate({
        target: [videoArtifacts.fileId],
        set: {
          model,
          durationSeconds:
            typeof durationSeconds === "number"
              ? Math.round(durationSeconds)
              : null,
          updatedAt: nowDate(),
        },
      })
      .returning({ id: videoArtifacts.id });
    signal.throwIfAborted();
    return entity?.id ?? null;
  },
);

/** Catalog titles survive redeploys and preview refreshes after a rename. */
function hostedArtifactTitle(
  site: { readonly requestedSlug: string | null; readonly slug: string },
  metadata: CatalogFileRow["metadata"],
  existing: { readonly title: string } | undefined,
): string {
  return (
    existing?.title ??
    metadataString(metadata, "title") ??
    site.requestedSlug ??
    site.slug
  );
}

const syncHostedArtifact$ = command(
  async (
    { set },
    args: {
      readonly kind: "hosted-site" | "presentation";
      readonly chatThreadId: string | null;
      readonly row: CatalogFileRow;
      readonly orgId: string;
      readonly authorUserId: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);

    const siteId = metadataString(args.row.metadata, "siteId");
    if (!siteId) {
      return true;
    }

    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0056; new non-billing transactions are prohibited.
    return await db.transaction(async (tx) => {
      // A hosted site is shared by every member of its organization. Lock that
      // product before reading or writing its registry row so concurrent first
      // deployments cannot create competing author-scoped entries.
      const [site] = await tx
        .select({
          id: hostedSites.id,
          slug: hostedSites.slug,
          requestedSlug: hostedSites.requestedSlug,
          createdAt: hostedSites.createdAt,
          activeDeploymentId: hostedSites.activeDeploymentId,
        })
        .from(hostedSites)
        .where(
          and(eq(hostedSites.id, siteId), eq(hostedSites.orgId, args.orgId)),
        )
        .for("update")
        .limit(1);
      signal.throwIfAborted();
      if (!site) {
        return false;
      }

      const privateSnapshot = args.row.metadata.access === "owner-private-v1";
      // A late completion/preview for an older publication must not replace
      // the active site's cover, even if its file row was inserted later.
      if (
        !privateSnapshot &&
        metadataString(args.row.metadata, "deploymentId") !==
          site.activeDeploymentId
      ) {
        return true;
      }

      const logicalKey = `site:${site.id}`;
      const [existingArtifact] = await tx
        .select({ id: artifacts.id, title: artifacts.title })
        .from(artifacts)
        .where(
          and(
            eq(artifacts.orgId, args.orgId),
            eq(artifacts.logicalKey, logicalKey),
          ),
        )
        .orderBy(
          desc(artifacts.projectionCreatedAt),
          desc(artifacts.projectionFileId),
        )
        .for("update")
        .limit(1);
      signal.throwIfAborted();

      let entityId: string | null = site.id;
      if (args.kind === "presentation") {
        const [entity] = await tx
          .insert(presentationArtifacts)
          .values({ hostedSiteId: site.id })
          .onConflictDoUpdate({
            target: [presentationArtifacts.hostedSiteId],
            set: { updatedAt: nowDate() },
          })
          .returning({ id: presentationArtifacts.id });
        signal.throwIfAborted();
        entityId = entity?.id ?? null;
      }
      if (!entityId) {
        return false;
      }

      const values = {
        kind: args.kind,
        displayKind: args.kind,
        sourceUrl: args.row.url,
        aliasUrl: metadataString(args.row.metadata, "aliasUrl"),
        videoSourceUrl: videoSourceUrl(
          args.row,
          site.requestedSlug ?? site.slug,
        ),
        entityId,
        projectionFileId: args.row.id,
        projectionCreatedAt: args.row.createdAt,
        orgId: args.orgId,
        title: hostedArtifactTitle(site, args.row.metadata, existingArtifact),
        thumbnail: args.row.previewImageUrl
          ? { url: args.row.previewImageUrl }
          : null,
      };

      if (!existingArtifact) {
        const plan = artifactUpsertPlan({
          ...values,
          authorUserId: args.authorUserId,
          chatThreadId: args.chatThreadId,
          logicalKey,
          createdAt: site.createdAt,
        });
        await tx
          .insert(artifacts)
          .values(plan.values)
          .onConflictDoUpdate(plan.conflict);
        signal.throwIfAborted();
        return true;
      }

      await tx
        .update(artifacts)
        .set({ ...values, updatedAt: nowDate() })
        .where(
          and(
            eq(artifacts.id, existingArtifact.id),
            privateSnapshot
              ? lte(
                  sql`(${artifacts.projectionCreatedAt}, ${artifacts.projectionFileId})`,
                  sql`(${args.row.createdAt}::timestamp, ${args.row.id}::uuid)`,
                )
              : undefined,
          ),
        );
      signal.throwIfAborted();
      return true;
    });
  },
);

const finishPendingArtifactFile$ = command(
  async (
    { set },
    fileId: string,
    pendingRevision: string | null,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);

    if (pendingRevision === null) {
      return;
    }
    await db
      .delete(artifactCatalogPendingFiles)
      .where(
        and(
          eq(artifactCatalogPendingFiles.fileId, fileId),
          sql`xmin::text = ${pendingRevision}`,
        ),
      );
    signal.throwIfAborted();
  },
);

const syncFileArtifact$ = command(
  async (
    { set },
    args: {
      readonly row: CatalogFileRow;
      readonly orgId: string;
      readonly authorUserId: string;
      readonly logicalKey: string;
      readonly chatThreadId: string | null;
      readonly kind: "file" | "image" | "video";
      readonly entityId: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const { row, orgId, authorUserId, logicalKey, kind, entityId } = args;
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0057; new non-billing transactions are prohibited.
    return await db.transaction(async (tx) => {
      // Serialize retries for one file before touching either artifact key.
      const [lockedFile] = await tx
        .select({ id: runUploadedFiles.id })
        .from(runUploadedFiles)
        .where(eq(runUploadedFiles.id, row.id))
        .for("update")
        .limit(1);
      signal.throwIfAborted();
      if (!lockedFile) {
        return false;
      }

      await tx
        .delete(artifacts)
        .where(
          and(
            eq(artifacts.projectionFileId, row.id),
            sql`(${artifacts.orgId}, ${artifacts.authorUserId}, ${artifacts.logicalKey}) IS DISTINCT FROM (${orgId}, ${authorUserId}, ${logicalKey})`,
          ),
        );

      const plan = artifactUpsertPlan({
        kind,
        displayKind: catalogArtifactKind(kind, row.metadata, logicalKey),
        sourceUrl: row.url,
        aliasUrl: metadataString(row.metadata, "aliasUrl"),
        videoSourceUrl: videoSourceUrl(row, row.filename ?? row.externalId),
        chatThreadId: args.chatThreadId,
        entityId,
        logicalKey,
        projectionFileId: row.id,
        projectionCreatedAt: row.createdAt,
        orgId,
        authorUserId,
        title: row.filename ?? row.externalId,
        thumbnail: fileThumbnail(row),
        createdAt: row.createdAt,
      });
      await tx
        .insert(artifacts)
        .values(plan.values)
        .onConflictDoUpdate(plan.conflict);
      return true;
    });
  },
);

/**
 * Maintain the catalog entry for one stored file. Safe to call repeatedly: the
 * upload path, the deploy path, and the deferred preview render all funnel
 * through here, and each call recomputes the artifact from the file row.
 *
 * Hosted-site and presentation projections collapse onto their `hosted_sites`
 * row, so redeploying a site updates one artifact instead of adding another.
 */
export const syncArtifactCatalogForFile$ = command(
  async (
    { set },
    fileId: string | null | undefined,
    signal: AbortSignal,
  ): Promise<void> => {
    if (!fileId) {
      return;
    }
    const db = set(writeDb$);

    const [pending] = await db
      .select({
        revision: sql`xmin::text`.mapWith(pgTextDecoder),
      })
      .from(artifactCatalogPendingFiles)
      .where(eq(artifactCatalogPendingFiles.fileId, fileId))
      .limit(1);
    signal.throwIfAborted();
    const pendingRevision = pending?.revision ?? null;
    const row = await set(readCatalogFileRow$, fileId, signal);
    signal.throwIfAborted();

    if (!row?.url || !row.orgId) {
      await db.delete(artifacts).where(eq(artifacts.projectionFileId, fileId));
      signal.throwIfAborted();
      await set(finishPendingArtifactFile$, fileId, pendingRevision, signal);
      signal.throwIfAborted();
      return;
    }

    /**
     * A file can already carry a projection that the current rules refuse: every
     * attachment registered before this admission existed. Removing it here keeps
     * the catalog converging on the current classification instead of retaining
     * whatever an earlier sync observed. No current producer writes such a
     * projection, so after the accompanying cleanup migration this only repairs a
     * row an older API registered while it was still draining.
     */
    if (!isCatalogArtifactFile(row)) {
      await db.delete(artifacts).where(eq(artifacts.projectionFileId, fileId));
      signal.throwIfAborted();
      await set(finishPendingArtifactFile$, fileId, pendingRevision, signal);
      signal.throwIfAborted();
      return;
    }

    const parsedFileUrl = safeUrlParse(row.url);
    const logicalFileUrl = parsedFileUrl
      ? (canonicalOkouArtifactCatalogUrl(parsedFileUrl) ?? row.url)
      : row.url;
    const logicalKey = `file:${logicalFileUrl}`;

    const { authorUserId, chatThreadId } = await set(
      resolveArtifactOwnership$,
      row,
      signal,
    );
    const hostedKind = hostedArtifactKind(row);
    if (hostedKind) {
      const complete = await set(
        syncHostedArtifact$,
        {
          kind: hostedKind,
          chatThreadId,
          row,
          orgId: row.orgId,
          authorUserId,
        },
        signal,
      );
      if (!complete) {
        signal.throwIfAborted();
        return;
      }
      await set(finishPendingArtifactFile$, fileId, pendingRevision, signal);
      signal.throwIfAborted();
      return;
    }

    const kind = fileArtifactKind(row);
    const entityId =
      kind === "file"
        ? row.id
        : await set(
            upsertGeneratedMediaEntity$,
            {
              kind,
              row,
            },
            signal,
          );
    if (!entityId) {
      signal.throwIfAborted();
      return;
    }

    const synced = await set(
      syncFileArtifact$,
      {
        row,
        orgId: row.orgId,
        authorUserId,
        chatThreadId,
        logicalKey,
        kind,
        entityId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!synced) {
      return;
    }
    await set(finishPendingArtifactFile$, fileId, pendingRevision, signal);
    signal.throwIfAborted();
  },
);

interface ListArtifactCatalogArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly kind?: ArtifactCatalogKind;
  readonly chatThreadId?: string;
  readonly keyword?: string;
}

interface ListArtifactCatalogResult {
  readonly artifacts: readonly ArtifactSummary[];
  readonly nextCursor: string | null;
}

/** Bounded, explicit recovery for pending files, independent of catalog reads. */
export const reconcileArtifactCatalogFiles$ = command(
  async (
    { set },
    signal: AbortSignal,
  ): Promise<{ processed: number; failed: number }> => {
    const db = set(writeDb$);

    const pendingRows = await db
      .select({
        fileId: artifactCatalogPendingFiles.fileId,
        revision: sql`xmin::text`.mapWith(pgTextDecoder),
      })
      .from(artifactCatalogPendingFiles)
      .orderBy(
        asc(artifactCatalogPendingFiles.queuedAt),
        asc(artifactCatalogPendingFiles.fileId),
      )
      .limit(ARTIFACT_CATALOG_WORKER_BATCH_SIZE);
    signal.throwIfAborted();
    const deadline = monotonicNow() + ARTIFACT_CATALOG_WORKER_BUDGET_MS;
    let processed = 0;
    let failed = 0;
    for (const pending of pendingRows) {
      if (monotonicNow() >= deadline) {
        break;
      }
      signal.throwIfAborted();
      const result = await settle(
        set(syncArtifactCatalogForFile$, pending.fileId, signal),
        signal,
      );
      signal.throwIfAborted();
      if (result.ok) {
        processed += 1;
      } else {
        failed += 1;
        L.warn("Artifact catalog reconciliation failed", {
          fileId: pending.fileId,
          error: result.error,
        });
      }
      // A missing hosted-site dependency keeps the task durable. Move that
      // task behind the rest of the queue so it cannot starve valid files.
      await db
        .update(artifactCatalogPendingFiles)
        .set({ queuedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(artifactCatalogPendingFiles.fileId, pending.fileId),
            sql`xmin::text = ${pending.revision}`,
          ),
        );
      signal.throwIfAborted();
    }
    return { processed, failed };
  },
);

function toArtifactSummary(row: {
  readonly id: string;
  readonly kind: ArtifactKind;
  readonly logicalKey: string;
  readonly displayKind: ArtifactCatalogKind | null;
  readonly sourceUrl: string | null;
  readonly aliasUrl: string | null;
  readonly videoSourceUrl: string | null;
  readonly title: string;
  readonly thumbnail: ArtifactThumbnail | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): ArtifactSummary {
  const kind =
    row.displayKind ?? catalogArtifactKind(row.kind, null, row.logicalKey);
  return {
    id: row.id,
    kind,
    title: row.title,
    thumbnail: row.thumbnail,
    ...(row.sourceUrl ? { sourceUrl: row.sourceUrl } : {}),
    ...(row.aliasUrl ? { aliasUrl: row.aliasUrl } : {}),
    ...(row.videoSourceUrl ? { videoSourceUrl: row.videoSourceUrl } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function artifactCatalogOwnerFilter(userId: string): SQL {
  return inArray(artifacts.authorUserId, [
    userId,
    sharedThreadArtifactAuthorUserId(userId),
  ]);
}

export const listArtifactCatalog$ = command(
  async (
    { get },
    args: ListArtifactCatalogArgs,
    signal: AbortSignal,
  ): Promise<ListArtifactCatalogResult> => {
    const db = get(db$);
    const limit = args.limit ?? ARTIFACT_CATALOG_DEFAULT_LIMIT;
    const cursor = args.cursor ? decodeArtifactCursor(args.cursor) : null;
    const keywordPattern = args.keyword
      ? `%${args.keyword
          .replaceAll("\\", String.raw`\\`)
          .replaceAll("%", String.raw`\%`)
          .replaceAll("_", String.raw`\_`)}%`
      : undefined;
    const rows = await db
      .select({
        id: artifacts.id,
        kind: artifacts.kind,
        logicalKey: artifacts.logicalKey,
        displayKind: artifacts.displayKind,
        aliasUrl: artifacts.aliasUrl,
        sourceUrl: artifacts.sourceUrl,
        videoSourceUrl: artifacts.videoSourceUrl,
        title: artifacts.title,
        thumbnail: artifacts.thumbnail,
        createdAt: artifacts.createdAt,
        updatedAt: artifacts.updatedAt,
      })
      .from(artifacts)
      .where(
        and(
          eq(artifacts.orgId, args.orgId),
          artifactCatalogOwnerFilter(args.userId),
          args.kind ? artifactCatalogKindFilter(args.kind) : undefined,
          args.chatThreadId
            ? eq(artifacts.chatThreadId, args.chatThreadId)
            : undefined,
          keywordPattern ? ilike(artifacts.title, keywordPattern) : undefined,
          cursor
            ? lt(
                sql`(${artifacts.createdAt}, ${artifacts.id})`,
                sql`(${cursor.createdAt}::timestamptz AT TIME ZONE 'UTC', ${cursor.id}::uuid)`,
              )
            : undefined,
        ),
      )
      .orderBy(desc(artifacts.createdAt), desc(artifacts.id))
      .limit(limit + 1);
    signal.throwIfAborted();

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const lastRow = pageRows.at(-1);
    return {
      artifacts: pageRows.map(toArtifactSummary),
      nextCursor:
        hasMore && lastRow
          ? encodeArtifactCursor({
              createdAt: lastRow.createdAt.toISOString(),
              id: lastRow.id,
            })
          : null,
    };
  },
);

interface GetArtifactCatalogEntryArgs {
  readonly artifactId: string;
  readonly orgId: string;
  readonly userId: string;
}

const fileDetail$ = command(
  async (
    { get },
    fileId: string,
    signal: AbortSignal,
  ): Promise<{
    readonly id: string;
    readonly filename: string;
    readonly contentType: string;
    readonly size: number;
    readonly url: string;
    readonly previewImageUrl: string | null;
  } | null> => {
    const db = get(db$);

    const [row] = await db
      .select({
        id: runUploadedFiles.id,
        externalId: runUploadedFiles.externalId,
        filename: runUploadedFiles.filename,
        contentType: runUploadedFiles.contentType,
        sizeBytes: runUploadedFiles.sizeBytes,
        url: runUploadedFiles.url,
        previewImageUrl: runUploadedFiles.previewImageUrl,
      })
      .from(runUploadedFiles)
      .where(eq(runUploadedFiles.id, fileId))
      .limit(1);
    signal.throwIfAborted();
    if (!row?.url) {
      return null;
    }
    const filename = row.filename ?? row.externalId;
    return {
      id: row.id,
      filename,
      contentType: row.contentType ?? inferMimetype(filename),
      size: row.sizeBytes ?? 0,
      url: row.url,
      previewImageUrl: row.previewImageUrl,
    };
  },
);

const hostedSiteDetail$ = command(
  async (
    { get },
    hostedSiteId: string,
    owner: { readonly userId: string; readonly orgId: string },
    projectionMetadata: Record<string, unknown> | null,
    signal: AbortSignal,
  ): Promise<{
    readonly id: string;
    readonly slug: string;
    readonly publicSlug: string;
    readonly url: string;
    readonly deploymentVersion: number | null;
    readonly entrypoint: string;
    readonly spaFallback: boolean;
  } | null> => {
    const db = get(db$);

    if (projectionMetadata?.access === "owner-private-v1") {
      const deploymentId = metadataString(projectionMetadata, "deploymentId");
      if (!deploymentId) {
        return null;
      }
      const [privateRow] = await db
        .select({
          id: hostedSites.id,
          slug: hostedSites.slug,
          requestedSlug: hostedSites.requestedSlug,
          publicSlug: hostedSites.publicSlug,
          url: privateHostedDeployments.url,
          deploymentVersion:
            sql`(${privateHostedDeployments.manifest}->>'deploymentVersion')::integer`.mapWith(
              pgIntegerDecoder,
            ),
          entrypoint: privateHostedDeployments.entrypoint,
          spaFallback: privateHostedDeployments.spaFallback,
        })
        .from(hostedSites)
        .innerJoin(
          privateHostedDeployments,
          eq(privateHostedDeployments.siteId, hostedSites.id),
        )
        .where(
          and(
            eq(hostedSites.id, hostedSiteId),
            eq(privateHostedDeployments.id, deploymentId),
            eq(privateHostedDeployments.userId, owner.userId),
            eq(privateHostedDeployments.orgId, owner.orgId),
            eq(privateHostedDeployments.status, "ready"),
            isNull(hostedSites.deletedAt),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      return privateRow
        ? { ...privateRow, slug: privateRow.requestedSlug ?? privateRow.slug }
        : null;
    }
    const [row] = await db
      .select({
        id: hostedSites.id,
        slug: hostedSites.slug,
        requestedSlug: hostedSites.requestedSlug,
        publicSlug: hostedSites.publicSlug,
        deploymentVersion:
          sql`(${hostedDeployments.manifest}->>'deploymentVersion')::integer`.mapWith(
            nullableDriverValueDecoder(pgIntegerDecoder),
          ),
        linkLayoutSegment: hostedSites.linkLayoutSegment,
        entrypoint: hostedDeployments.entrypoint,
        spaFallback: hostedDeployments.spaFallback,
      })
      .from(hostedSites)
      .innerJoin(
        hostedDeployments,
        eq(hostedDeployments.id, hostedSites.activeDeploymentId),
      )
      .where(eq(hostedSites.id, hostedSiteId))
      .limit(1);
    signal.throwIfAborted();
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      slug: row.requestedSlug ?? row.slug,
      publicSlug: row.publicSlug,
      url: hostedLinkOrigin(
        linkLayoutFromSegment(row.linkLayoutSegment),
        row.publicSlug,
      ),
      deploymentVersion: row.deploymentVersion,
      entrypoint: row.entrypoint,
      spaFallback: row.spaFallback,
    };
  },
);

const presentationDetail$ = command(
  async (
    { get, set },
    summary: ArtifactSummary,
    row: {
      readonly entityId: string;
      readonly projectionMetadata: Record<string, unknown> | null;
    },
    owner: { readonly userId: string; readonly orgId: string },
    signal: AbortSignal,
  ): Promise<ArtifactDetail | null> => {
    const db = get(db$);

    const [entity] = await db
      .select({ hostedSiteId: presentationArtifacts.hostedSiteId })
      .from(presentationArtifacts)
      .where(eq(presentationArtifacts.id, row.entityId))
      .limit(1);
    signal.throwIfAborted();
    if (!entity) {
      return null;
    }
    const site = await set(
      hostedSiteDetail$,
      entity.hostedSiteId,
      owner,
      row.projectionMetadata,
      signal,
    );
    return site ? { ...summary, kind: "presentation", site } : null;
  },
);

function avatarDetail(
  summary: ArtifactSummary,
  file: Extract<ArtifactDetail, { kind: "file" }>["file"] | null,
  metadata: Record<string, unknown> | null,
): ArtifactDetail | null {
  const durationSeconds = metadata?.durationSeconds;
  return file
    ? {
        ...summary,
        kind: "avatar",
        file,
        model: metadataString(metadata ?? {}, "model"),
        durationSeconds:
          typeof durationSeconds === "number"
            ? Math.round(durationSeconds)
            : null,
      }
    : null;
}

/**
 * Load one artifact together with its kind entity. The caller check runs on the
 * registry row alone, so every kind shares the same permission rule.
 */
export const getArtifactCatalogEntry$ = command(
  async (
    { get, set },
    args: GetArtifactCatalogEntryArgs,
    signal: AbortSignal,
  ): Promise<ArtifactDetail | null> => {
    const db = get(db$);
    const [row] = await db
      .select({
        id: artifacts.id,
        kind: artifacts.kind,
        logicalKey: artifacts.logicalKey,
        entityId: artifacts.entityId,
        projectionFileId: artifacts.projectionFileId,
        projectionMetadata: runUploadedFiles.metadata,
        displayKind: artifacts.displayKind,
        aliasUrl: artifacts.aliasUrl,
        sourceUrl: artifacts.sourceUrl,
        videoSourceUrl: artifacts.videoSourceUrl,
        title: artifacts.title,
        thumbnail: artifacts.thumbnail,
        createdAt: artifacts.createdAt,
        updatedAt: artifacts.updatedAt,
      })
      .from(artifacts)
      .leftJoin(
        runUploadedFiles,
        eq(runUploadedFiles.id, artifacts.projectionFileId),
      )
      .where(
        and(
          eq(artifacts.id, args.artifactId),
          eq(artifacts.orgId, args.orgId),
          artifactCatalogOwnerFilter(args.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!row) {
      return null;
    }

    const summary = toArtifactSummary(row);
    if (
      row.kind === "file" &&
      isSharedThreadArtifactLogicalKey(row.logicalKey)
    ) {
      return {
        ...summary,
        kind: "shared-thread",
        sharedThread: { id: row.entityId },
      };
    }
    if (summary.kind === "avatar") {
      if (row.projectionFileId === null) {
        return null;
      }
      const file = await set(fileDetail$, row.projectionFileId, signal);
      return avatarDetail(summary, file, row.projectionMetadata);
    }

    if (row.kind === "file") {
      const file = await set(fileDetail$, row.entityId, signal);
      return file ? { ...summary, kind: "file", file } : null;
    }

    if (row.kind === "image") {
      const [entity] = await db
        .select({
          fileId: imageArtifacts.fileId,
          model: imageArtifacts.model,
          provider: imageArtifacts.provider,
        })
        .from(imageArtifacts)
        .where(eq(imageArtifacts.id, row.entityId))
        .limit(1);
      signal.throwIfAborted();
      if (!entity) {
        return null;
      }
      const file = await set(fileDetail$, entity.fileId, signal);
      return file
        ? {
            ...summary,
            kind: "image",
            file,
            model: entity.model,
            provider: entity.provider,
          }
        : null;
    }

    if (row.kind === "video") {
      const [entity] = await db
        .select({
          fileId: videoArtifacts.fileId,
          model: videoArtifacts.model,
          durationSeconds: videoArtifacts.durationSeconds,
        })
        .from(videoArtifacts)
        .where(eq(videoArtifacts.id, row.entityId))
        .limit(1);
      signal.throwIfAborted();
      if (!entity) {
        return null;
      }
      const file = await set(fileDetail$, entity.fileId, signal);
      return file
        ? {
            ...summary,
            kind: "video",
            file,
            model: entity.model,
            durationSeconds: entity.durationSeconds,
          }
        : null;
    }

    if (row.kind === "hosted-site") {
      const site = await set(
        hostedSiteDetail$,
        row.entityId,
        args,
        row.projectionMetadata,
        signal,
      );
      return site ? { ...summary, kind: "hosted-site", site } : null;
    }

    return await set(presentationDetail$, summary, row, args, signal);
  },
);
