import { command } from "ccstate";
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  notLike,
  or,
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
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import {
  hostedDeployments,
  hostedSites,
  privateHostedDeployments,
} from "@okouai/db/runtime/hosted-site";
import { runUploadedFiles } from "@okouai/db/schema/run-uploaded-file";
import { sharedThreads } from "@okouai/db/schema/shared-thread";
import { z } from "zod";

import { canonicalOkouArtifactCatalogUrl } from "../../lib/file-url";
import {
  nullableDriverValueDecoder,
  pgIntegerDecoder,
} from "../../lib/db-structured-result";
import { nowDate } from "../../lib/time";
import {
  isSharedThreadArtifactLogicalKey,
  sharedThreadArtifactAuthorUserId,
  SHARED_THREAD_ARTIFACT_LOGICAL_KEY_PREFIX,
} from "../../lib/shared-thread-artifact";
import { writeDb$, type Db } from "../external/db";
import { safeUrlParse } from "../utils";
import { inferMimetype } from "./chat-event-shared.service";
import { runOwnedChatEventForRunCondition } from "./chat-event-type.service";

const ARTIFACT_CATALOG_DEFAULT_LIMIT = 60;

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

function artifactCatalogKindFilter(kind: ArtifactCatalogKind): SQL | undefined {
  const generatedBy = sql`${runUploadedFiles.metadata} ->> 'generatedBy'`;
  if (kind === "shared-thread") {
    return and(
      eq(artifacts.kind, "file"),
      like(
        artifacts.logicalKey,
        `${SHARED_THREAD_ARTIFACT_LOGICAL_KEY_PREFIX}%`,
      ),
    );
  }
  if (kind === "avatar") {
    return eq(generatedBy, AVATAR_VIDEO_MARKER);
  }
  if (kind === "file" || kind === "video") {
    return and(
      eq(artifacts.kind, kind),
      kind === "file"
        ? notLike(
            artifacts.logicalKey,
            `${SHARED_THREAD_ARTIFACT_LOGICAL_KEY_PREFIX}%`,
          )
        : undefined,
      sql`${generatedBy} IS DISTINCT FROM ${AVATAR_VIDEO_MARKER}`,
    );
  }
  return eq(artifacts.kind, kind);
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
 * The owning Okou user for an artifact. Chat-backed runs are owned by the thread
 * user, so an artifact produced from a Slack or Feishu message is filed under
 * the Okou account behind that thread rather than the external sender.
 */
async function resolveChatThreadId(
  db: Db,
  row: CatalogFileRow,
  signal: AbortSignal,
): Promise<string | null> {
  if (row.chatThreadId) {
    return row.chatThreadId;
  }
  if (!row.runId) {
    return null;
  }

  const [run] = await db
    .select({ chatThreadId: agentRuns.chatThreadId })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, row.runId), isNotNull(agentRuns.triggerSource)))
    .limit(1);
  signal.throwIfAborted();
  if (run?.chatThreadId) {
    return run.chatThreadId;
  }

  const [event] = await db
    .select({ chatThreadId: chatEvents.chatThreadId })
    .from(chatEvents)
    .where(runOwnedChatEventForRunCondition({ runId: row.runId }))
    .orderBy(asc(chatEvents.seqId))
    .limit(1);
  signal.throwIfAborted();
  return event?.chatThreadId ?? null;
}

async function resolveAuthorUserId(
  db: Db,
  row: CatalogFileRow,
  signal: AbortSignal,
): Promise<string> {
  const threadId = await resolveChatThreadId(db, row, signal);
  if (!threadId) {
    return row.userId;
  }

  const [thread] = await db
    .select({ userId: chatThreads.userId })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);
  signal.throwIfAborted();
  return thread?.userId ?? row.userId;
}

async function readCatalogFileRow(
  db: Db,
  fileId: string,
  signal: AbortSignal,
): Promise<CatalogFileRow | null> {
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
      createdAt: runUploadedFiles.createdAt,
    })
    .from(runUploadedFiles)
    .where(eq(runUploadedFiles.id, fileId))
    .limit(1);
  signal.throwIfAborted();
  return row ?? null;
}

interface UpsertArtifactArgs {
  readonly db: Pick<Db, "insert">;
  readonly kind: ArtifactKind;
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
 * original list position.
 */
async function upsertArtifact(args: UpsertArtifactArgs): Promise<void> {
  await args.db
    .insert(artifacts)
    .values({
      kind: args.kind,
      entityId: args.entityId,
      logicalKey: args.logicalKey,
      projectionFileId: args.projectionFileId,
      projectionCreatedAt: args.projectionCreatedAt,
      orgId: args.orgId,
      authorUserId: args.authorUserId,
      title: args.title,
      thumbnail: args.thumbnail,
      createdAt: args.createdAt,
    })
    .onConflictDoUpdate({
      target: [artifacts.orgId, artifacts.authorUserId, artifacts.logicalKey],
      set: {
        kind: args.kind,
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
    });
}

async function upsertGeneratedMediaEntity(
  args: {
    readonly db: Db;
    readonly kind: "image" | "video";
    readonly row: CatalogFileRow;
  },
  signal: AbortSignal,
): Promise<string | null> {
  const model = metadataString(args.row.metadata, "model");
  if (args.kind === "image") {
    const [entity] = await args.db
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
  const [entity] = await args.db
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
}

async function upsertPresentationEntity(
  args: {
    readonly db: Pick<Db, "insert">;
    readonly hostedSiteId: string;
  },
  signal: AbortSignal,
): Promise<string | null> {
  const [entity] = await args.db
    .insert(presentationArtifacts)
    .values({ hostedSiteId: args.hostedSiteId })
    .onConflictDoUpdate({
      target: [presentationArtifacts.hostedSiteId],
      set: { updatedAt: nowDate() },
    })
    .returning({ id: presentationArtifacts.id });
  signal.throwIfAborted();
  return entity?.id ?? null;
}

async function syncHostedArtifact(
  args: {
    readonly db: Db;
    readonly kind: "hosted-site" | "presentation";
    readonly row: CatalogFileRow;
    readonly orgId: string;
    readonly authorUserId: string;
  },
  signal: AbortSignal,
): Promise<boolean> {
  const siteId = metadataString(args.row.metadata, "siteId");
  if (!siteId) {
    return true;
  }

  return await args.db.transaction(async (tx) => {
    // A hosted site is shared by every member of its organization. Lock that
    // product before reading or writing its registry row so concurrent first
    // deployments cannot create competing author-scoped entries.
    const [site] = await tx
      .select({
        id: hostedSites.id,
        slug: hostedSites.slug,
        requestedSlug: hostedSites.requestedSlug,
        createdAt: hostedSites.createdAt,
      })
      .from(hostedSites)
      .where(and(eq(hostedSites.id, siteId), eq(hostedSites.orgId, args.orgId)))
      .for("update")
      .limit(1);
    signal.throwIfAborted();
    if (!site) {
      return false;
    }

    const logicalKey = `site:${site.id}`;
    const [existingArtifact] = await tx
      .select({ id: artifacts.id })
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

    const entityId =
      args.kind === "presentation"
        ? await upsertPresentationEntity(
            {
              db: tx,
              hostedSiteId: site.id,
            },
            signal,
          )
        : site.id;
    if (!entityId) {
      return false;
    }

    const values = {
      kind: args.kind,
      entityId,
      projectionFileId: args.row.id,
      projectionCreatedAt: args.row.createdAt,
      orgId: args.orgId,
      authorUserId: args.authorUserId,
      title: site.requestedSlug ?? site.slug,
      thumbnail: args.row.previewImageUrl
        ? { url: args.row.previewImageUrl }
        : null,
    };

    if (!existingArtifact) {
      await upsertArtifact({
        db: tx,
        ...values,
        logicalKey,
        createdAt: site.createdAt,
      });
      signal.throwIfAborted();
      return true;
    }

    await tx
      .update(artifacts)
      .set({ ...values, updatedAt: nowDate() })
      .where(
        and(
          eq(artifacts.id, existingArtifact.id),
          lte(
            sql`(${artifacts.projectionCreatedAt}, ${artifacts.projectionFileId})`,
            sql`(${args.row.createdAt}::timestamp, ${args.row.id}::uuid)`,
          ),
        ),
      );
    signal.throwIfAborted();
    return true;
  });
}

async function runHasHostedProjection(
  db: Db,
  runId: string | null,
  signal: AbortSignal,
): Promise<boolean> {
  if (!runId) {
    return false;
  }
  const [hosted] = await db
    .select({ id: runUploadedFiles.id })
    .from(runUploadedFiles)
    .where(
      and(
        eq(runUploadedFiles.runId, runId),
        inArray(
          sql`${runUploadedFiles.metadata} ->> 'artifactKind'`,
          sql`('hosted-site', 'presentation-html')`,
        ),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  return Boolean(hosted);
}

async function removeHostedRunShadowArtifacts(
  args: {
    readonly db: Db;
    readonly row: CatalogFileRow;
    readonly orgId: string;
    readonly authorUserId: string;
  },
  signal: AbortSignal,
): Promise<void> {
  if (!args.row.runId) {
    return;
  }
  const shadowRows = await args.db
    .select({ id: runUploadedFiles.id })
    .from(runUploadedFiles)
    .where(
      and(
        eq(runUploadedFiles.runId, args.row.runId),
        sql`${runUploadedFiles.metadata} ->> 'artifactKind' IS DISTINCT FROM 'hosted-site'`,
        sql`${runUploadedFiles.metadata} ->> 'artifactKind' IS DISTINCT FROM 'presentation-html'`,
      ),
    );
  signal.throwIfAborted();
  const shadowIds = shadowRows.map((shadow) => {
    return shadow.id;
  });
  if (shadowIds.length === 0) {
    return;
  }
  await args.db
    .delete(artifacts)
    .where(
      and(
        eq(artifacts.orgId, args.orgId),
        eq(artifacts.authorUserId, args.authorUserId),
        inArray(artifacts.projectionFileId, shadowIds),
      ),
    );
  signal.throwIfAborted();
}

async function finishPendingArtifactFile(
  db: Db,
  fileId: string,
  signal: AbortSignal,
): Promise<void> {
  await db
    .delete(artifactCatalogPendingFiles)
    .where(eq(artifactCatalogPendingFiles.fileId, fileId));
  signal.throwIfAborted();
}

async function syncArtifactCatalogFile(
  db: Db,
  fileId: string,
  signal: AbortSignal,
): Promise<void> {
  const row = await readCatalogFileRow(db, fileId, signal);
  if (!row?.url || !row.orgId) {
    await finishPendingArtifactFile(db, fileId, signal);
    return;
  }

  const parsedFileUrl = safeUrlParse(row.url);
  const logicalFileUrl = parsedFileUrl
    ? (canonicalOkouArtifactCatalogUrl(parsedFileUrl) ?? row.url)
    : row.url;
  const logicalKey = `file:${logicalFileUrl}`;

  const authorUserId = await resolveAuthorUserId(db, row, signal);
  const hostedKind = hostedArtifactKind(row);
  if (hostedKind) {
    await removeHostedRunShadowArtifacts(
      {
        db,
        row,
        orgId: row.orgId,
        authorUserId,
      },
      signal,
    );
    const complete = await syncHostedArtifact(
      {
        db,
        kind: hostedKind,
        row,
        orgId: row.orgId,
        authorUserId,
      },
      signal,
    );
    if (!complete) {
      return;
    }
    await finishPendingArtifactFile(db, fileId, signal);
    return;
  }

  if (await runHasHostedProjection(db, row.runId, signal)) {
    await db
      .delete(artifacts)
      .where(
        and(
          eq(artifacts.orgId, row.orgId),
          eq(artifacts.authorUserId, authorUserId),
          eq(artifacts.logicalKey, logicalKey),
          eq(artifacts.projectionFileId, row.id),
        ),
      );
    signal.throwIfAborted();
    await finishPendingArtifactFile(db, fileId, signal);
    return;
  }

  const kind = fileArtifactKind(row);
  const entityId =
    kind === "file"
      ? row.id
      : await upsertGeneratedMediaEntity({ db, kind, row }, signal);
  if (!entityId) {
    return;
  }

  const orgId = row.orgId;
  const synced = await db.transaction(async (tx) => {
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

    await upsertArtifact({
      db: tx,
      kind,
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
    return true;
  });
  signal.throwIfAborted();
  if (!synced) {
    return;
  }
  await finishPendingArtifactFile(db, fileId, signal);
}

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
    await syncArtifactCatalogFile(db, fileId, signal);
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

async function reconcilePendingArtifactCatalog(
  db: Db,
  args: Pick<ListArtifactCatalogArgs, "orgId" | "userId">,
  signal: AbortSignal,
): Promise<void> {
  const pendingRows = await db
    .select({ fileId: artifactCatalogPendingFiles.fileId })
    .from(artifactCatalogPendingFiles)
    .where(
      and(
        eq(artifactCatalogPendingFiles.orgId, args.orgId),
        eq(artifactCatalogPendingFiles.authorUserId, args.userId),
      ),
    )
    .orderBy(
      asc(artifactCatalogPendingFiles.queuedAt),
      asc(artifactCatalogPendingFiles.fileId),
    );
  signal.throwIfAborted();

  for (const pending of pendingRows) {
    await syncArtifactCatalogFile(db, pending.fileId, signal);
    signal.throwIfAborted();
  }
}

function toArtifactSummary(row: {
  readonly id: string;
  readonly kind: ArtifactKind;
  readonly logicalKey: string;
  readonly projectionMetadata: Record<string, unknown> | null;
  readonly sourceContentType: string | null;
  readonly sourceUrl: string | null;
  readonly title: string;
  readonly thumbnail: ArtifactThumbnail | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): ArtifactSummary {
  const kind = catalogArtifactKind(
    row.kind,
    row.projectionMetadata,
    row.logicalKey,
  );
  return {
    id: row.id,
    kind,
    title: row.title,
    thumbnail: row.thumbnail,
    ...(row.sourceUrl &&
    (row.sourceContentType ?? inferMimetype(row.title)).startsWith("video/")
      ? { videoSourceUrl: row.sourceUrl }
      : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The registry has no thread column, so a thread filter resolves through each
 * artifact kind's source association. File-backed artifacts use the projection
 * file directly or its run, while shared threads retain their nullable source
 * thread ID after snapshot creation.
 */
function fileChatThreadFilter(db: Db, chatThreadId: string): SQL {
  const runIds = db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.chatThreadId, chatThreadId),
        isNotNull(agentRuns.triggerSource),
      ),
    );
  const fileIds = db
    .select({ id: runUploadedFiles.id })
    .from(runUploadedFiles)
    .where(
      or(
        eq(runUploadedFiles.chatThreadId, chatThreadId),
        inArray(runUploadedFiles.runId, runIds),
      ),
    );
  return inArray(artifacts.projectionFileId, fileIds);
}

function sharedThreadChatThreadFilter(db: Db, chatThreadId: string): SQL {
  const sharedThreadIds = db
    .select({ id: sharedThreads.id })
    .from(sharedThreads)
    .where(eq(sharedThreads.sourceChatThreadId, chatThreadId));
  const filter = and(
    eq(artifacts.kind, "file"),
    like(artifacts.logicalKey, `${SHARED_THREAD_ARTIFACT_LOGICAL_KEY_PREFIX}%`),
    inArray(artifacts.entityId, sharedThreadIds),
  );
  if (!filter) {
    throw new Error("Shared-thread catalog filter is unavailable");
  }
  return filter;
}

function chatThreadFilter(db: Db, chatThreadId: string): SQL {
  const fileFilter = fileChatThreadFilter(db, chatThreadId);
  return sql`(${fileFilter} OR ${sharedThreadChatThreadFilter(
    db,
    chatThreadId,
  )})`;
}

function artifactCatalogOwnerFilter(userId: string): SQL {
  return inArray(artifacts.authorUserId, [
    userId,
    sharedThreadArtifactAuthorUserId(userId),
  ]);
}

export const listArtifactCatalog$ = command(
  async (
    { set },
    args: ListArtifactCatalogArgs,
    signal: AbortSignal,
  ): Promise<ListArtifactCatalogResult> => {
    const db = set(writeDb$);
    await reconcilePendingArtifactCatalog(db, args, signal);
    signal.throwIfAborted();
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
        projectionMetadata: runUploadedFiles.metadata,
        sourceContentType: runUploadedFiles.contentType,
        sourceUrl: runUploadedFiles.url,
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
          eq(artifacts.orgId, args.orgId),
          artifactCatalogOwnerFilter(args.userId),
          args.kind ? artifactCatalogKindFilter(args.kind) : undefined,
          args.chatThreadId
            ? chatThreadFilter(db, args.chatThreadId)
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

async function fileDetail(
  db: Db,
  fileId: string,
  signal: AbortSignal,
): Promise<{
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
  readonly url: string;
  readonly previewImageUrl: string | null;
} | null> {
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
}

async function hostedSiteDetail(
  db: Db,
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
} | null> {
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
      url: hostedDeployments.url,
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
    url: row.url,
    deploymentVersion: row.deploymentVersion,
    entrypoint: row.entrypoint,
    spaFallback: row.spaFallback,
  };
}

async function avatarDetail(
  db: Db,
  summary: ArtifactSummary,
  projectionFileId: string | null,
  projectionMetadata: Record<string, unknown> | null,
  signal: AbortSignal,
): Promise<ArtifactDetail | null> {
  if (projectionFileId === null) {
    return null;
  }
  const file = await fileDetail(db, projectionFileId, signal);
  const durationSeconds = projectionMetadata?.durationSeconds;
  return file
    ? {
        ...summary,
        kind: "avatar",
        file,
        model: metadataString(projectionMetadata ?? {}, "model"),
        durationSeconds:
          typeof durationSeconds === "number"
            ? Math.round(durationSeconds)
            : null,
      }
    : null;
}

async function presentationDetail(
  db: Db,
  summary: ArtifactSummary,
  row: {
    readonly entityId: string;
    readonly projectionMetadata: Record<string, unknown> | null;
  },
  owner: { readonly userId: string; readonly orgId: string },
  signal: AbortSignal,
): Promise<ArtifactDetail | null> {
  const [entity] = await db
    .select({ hostedSiteId: presentationArtifacts.hostedSiteId })
    .from(presentationArtifacts)
    .where(eq(presentationArtifacts.id, row.entityId))
    .limit(1);
  signal.throwIfAborted();
  if (!entity) {
    return null;
  }
  const site = await hostedSiteDetail(
    db,
    entity.hostedSiteId,
    owner,
    row.projectionMetadata,
    signal,
  );
  return site ? { ...summary, kind: "presentation", site } : null;
}

/**
 * Load one artifact together with its kind entity. The caller check runs on the
 * registry row alone, so every kind shares the same permission rule.
 */
export const getArtifactCatalogEntry$ = command(
  async (
    { set },
    args: GetArtifactCatalogEntryArgs,
    signal: AbortSignal,
  ): Promise<ArtifactDetail | null> => {
    const db = set(writeDb$);
    const [row] = await db
      .select({
        id: artifacts.id,
        kind: artifacts.kind,
        logicalKey: artifacts.logicalKey,
        entityId: artifacts.entityId,
        projectionFileId: artifacts.projectionFileId,
        projectionMetadata: runUploadedFiles.metadata,
        sourceContentType: runUploadedFiles.contentType,
        sourceUrl: runUploadedFiles.url,
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
      return await avatarDetail(
        db,
        summary,
        row.projectionFileId,
        row.projectionMetadata,
        signal,
      );
    }

    if (row.kind === "file") {
      const file = await fileDetail(db, row.entityId, signal);
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
      const file = await fileDetail(db, entity.fileId, signal);
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
      const file = await fileDetail(db, entity.fileId, signal);
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
      const site = await hostedSiteDetail(
        db,
        row.entityId,
        args,
        row.projectionMetadata,
        signal,
      );
      return site ? { ...summary, kind: "hosted-site", site } : null;
    }

    return await presentationDetail(db, summary, row, args, signal);
  },
);
