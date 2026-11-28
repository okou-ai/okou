import { createHash } from "node:crypto";
import { command } from "ccstate";
import {
  artifactReferencePath,
  parseArtifactReference,
} from "@okouai/api-contracts/contracts/artifact-references";
import { linkLayoutFromSegment } from "@okouai/api-contracts/contracts/link-layout";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  notLike,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import {
  ARTIFACT_CATALOG_CATEGORIES,
  ARTIFACT_CATALOG_KINDS,
  chatArtifactCatalogChangedEvent,
  type ArtifactCatalogCategory,
  type ArtifactCatalogDirection,
  type ArtifactCatalogKind,
  type ArtifactCatalogListQueryKind,
  type ArtifactDetail,
  type ArtifactSummary,
} from "@okouai/api-contracts/contracts/artifact-catalog";
import {
  artifacts,
  imageArtifacts,
  presentationArtifacts,
  type ArtifactKind,
  type ArtifactThumbnail,
  type ArtifactVisibility,
} from "@okouai/db/schema/artifact";
import { files } from "@okouai/db/schema/file";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import {
  hostedDeployments,
  hostedSites,
  privateHostedDeployments,
} from "@okouai/db/runtime/hosted-site";
import {
  iso,
  object,
  string,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import { env } from "../../lib/env";
import {
  buildFileUrlFromKey,
  canonicalOkouArtifactCatalogUrl,
} from "../../lib/file-url";
import { hostedLinkOrigin } from "../../lib/link-layout";
import {
  nullableDriverValueDecoder,
  pgIntegerDecoder,
  pgTextDecoder,
  zodEnumDriverValueDecoder,
} from "../../lib/db-structured-result";
import { nowDate } from "../../lib/time";
import {
  isSharedThreadArtifactLogicalKey,
  sharedThreadArtifactAuthorUserId,
  sharedThreadArtifactLogicalKey,
} from "../../lib/shared-thread-artifact";
import { db$, writeDb$, type ReadonlyDb } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import { safeJsonParse, safeUrlParse } from "../utils";
import { inferMimetype } from "./chat-event-shared.service";
import { artifactReferenceRecord$ } from "./artifact-reference.service";
import { probeLegacyArtifactSharePolicy$ } from "./artifact-share-probe.service";

const ARTIFACT_CATALOG_DEFAULT_LIMIT = 60;

const artifactCursorSchema = object({
  createdAt: iso.datetime(),
  id: uuid(),
});
type ArtifactCursor = zInfer<typeof artifactCursorSchema>;

function encodeArtifactCursor(
  cursor: ArtifactCursor | ArtifactLibraryCursor,
): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

const artifactLibraryCursorSchema = object({
  query: string(),
  value: iso.datetime({ precision: 6 }),
  id: uuid(),
});
type ArtifactLibraryCursor = zInfer<typeof artifactLibraryCursorSchema>;

function decodeArtifactCursor(
  raw: string,
): ArtifactCursor | ArtifactLibraryCursor | null {
  const result = artifactLibraryCursorSchema
    .or(artifactCursorSchema)
    .safeParse(safeJsonParse(Buffer.from(raw, "base64url").toString("utf8")));
  return result.success ? result.data : null;
}

const DIRECT_KIND_CATEGORIES: Readonly<
  Partial<Record<ArtifactCatalogKind, ArtifactCatalogCategory>>
> = {
  avatar: "other",
  "shared-thread": "other",
  presentation: "presentation",
  "hosted-site": "website",
  image: "image",
};

const FILE_CATEGORY_RULES: readonly {
  readonly category: ArtifactCatalogCategory;
  readonly mimePrefixes?: readonly string[];
  readonly mimeExact?: readonly string[];
  readonly extPattern: RegExp;
}[] = [
  {
    category: "image",
    mimePrefixes: ["image/"],
    extPattern: /\.(?:avif|bmp|gif|heic|heif|ico|jpe?g|png|svg|tiff?|webp)$/u,
  },
  {
    category: "video",
    mimePrefixes: ["video/"],
    extPattern: /\.(?:avi|m4v|mkv|mov|mp4|mpeg|mpg|ogv|webm)$/u,
  },
  {
    category: "audio",
    mimePrefixes: ["audio/"],
    extPattern: /\.(?:aac|aiff?|flac|m4a|mp3|mpga|oga|ogg|opus|wav|wma)$/u,
  },
  {
    category: "presentation",
    mimePrefixes: [
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.",
      "application/vnd.oasis.opendocument.presentation",
    ],
    extPattern: /\.(?:odp|pot|potm|potx|pps|ppsm|ppsx|ppt|pptm|pptx)$/u,
  },
  {
    category: "spreadsheet",
    mimeExact: ["text/csv", "text/tab-separated-values"],
    mimePrefixes: [
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.",
      "application/vnd.oasis.opendocument.spreadsheet",
    ],
    extPattern: /\.(?:csv|numbers|ods|tsv|xls|xlsb|xlsm|xlsx|xlt|xltm|xltx)$/u,
  },
  {
    category: "website",
    mimeExact: ["text/html", "application/xhtml+xml"],
    extPattern: /\.(?:html?|xhtml)$/u,
  },
  {
    category: "document",
    mimePrefixes: [
      "text/",
      "application/vnd.ms-word",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.",
      "application/vnd.oasis.opendocument.text",
    ],
    mimeExact: [
      "application/pdf",
      "application/msword",
      "application/rtf",
      "application/json",
      "application/xml",
      "application/yaml",
      "application/x-yaml",
    ],
    extPattern:
      /\.(?:doc|docm|docx|dot|dotm|dotx|json|markdown|md|odt|pdf|rtf|txt|xml|ya?ml)$/u,
  },
];

export function inferFileArtifactCategory(
  kind: ArtifactCatalogKind,
  contentType: string | null,
  filename: string,
): ArtifactCatalogCategory {
  const direct = DIRECT_KIND_CATEGORIES[kind];
  if (direct) {
    return direct;
  }
  const ct = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const fname = filename.toLowerCase();
  for (const rule of FILE_CATEGORY_RULES) {
    const mimeMatch =
      (rule.mimeExact?.includes(ct) ?? false) ||
      (rule.mimePrefixes?.some((prefix) => {
        return ct.startsWith(prefix);
      }) ??
        false);
    if (mimeMatch || rule.extPattern.test(fname)) {
      return rule.category;
    }
  }
  return "other";
}

function fileArtifactLogicalKey(url: string): string {
  const parsed = safeUrlParse(url);
  const canonical = parsed
    ? (canonicalOkouArtifactCatalogUrl(parsed) ?? url)
    : url;
  return `file:${canonical}`;
}

function catalogArtifactKind(
  kind: ArtifactKind,
  logicalKey: string,
): ArtifactCatalogKind {
  if (kind === "file" && isSharedThreadArtifactLogicalKey(logicalKey)) {
    return "shared-thread";
  }
  return kind;
}

function artifactCatalogEffectiveKind() {
  // Native PPTX files belong to Presentations without changing their file-backed
  // storage or detail contract. Other summaries retain their display kind.
  return sql`case
    when ${artifacts.kind} = 'file'
      and ${artifacts.logicalKey} not like 'shared-thread:%'
      and lower(${artifacts.title}) like '%.pptx'
    then 'presentation'
    else coalesce(${artifacts.displayKind}, case
      when ${artifacts.kind} = 'file'
        and ${artifacts.logicalKey} like 'shared-thread:%'
      then 'shared-thread'
      else ${artifacts.kind}
    end)
  end`.mapWith(zodEnumDriverValueDecoder(zEnum(ARTIFACT_CATALOG_KINDS)));
}

function artifactCatalogKindFilter(kind: ArtifactCatalogListQueryKind): SQL {
  if (kind === "video") {
    // Bounded iOS 0.73.0 App Review compatibility: video artifacts are stored as
    // `kind = 'file'` with `category = 'video'`.
    return and(eq(artifacts.kind, "file"), eq(artifacts.category, "video"))!;
  }
  return eq(artifactCatalogEffectiveKind(), kind);
}

const resolveAuthorAndThread$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly runId?: string | null;
      readonly chatThreadId?: string | null;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly authorUserId: string;
    readonly chatThreadId: string | null;
  }> => {
    const db = get(db$);
    let chatThreadId = args.chatThreadId ?? null;
    if (!chatThreadId && args.runId) {
      const [run] = await db
        .select({ chatThreadId: agentRuns.chatThreadId })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.id, args.runId),
            eq(agentRuns.orgId, args.orgId),
            isNotNull(agentRuns.triggerSource),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      chatThreadId = run?.chatThreadId ?? null;
    }
    if (!chatThreadId) {
      return { authorUserId: args.userId, chatThreadId: null };
    }
    const [thread] = await db
      .select({ userId: chatThreads.userId })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.id, chatThreadId),
          eq(chatThreads.orgId, args.orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return {
      authorUserId: thread?.userId ?? args.userId,
      chatThreadId: thread ? chatThreadId : null,
    };
  },
);

export const notifyArtifactCatalogChanged$ = command(
  async (
    _ctx,
    args: {
      readonly authorUserId: string;
      readonly chatThreadId: string | null;
    },
  ): Promise<void> => {
    if (args.chatThreadId) {
      await publishUserSignal(
        [args.authorUserId],
        chatArtifactCatalogChangedEvent(args.chatThreadId),
      );
    }
  },
);

/** Synchronously register or update a file deliverable in `artifacts`. */
export const upsertFileArtifact$ = command(
  async (
    { set },
    args: {
      readonly fileId: string;
      readonly orgId: string;
      readonly userId: string;
      readonly filename: string;
      readonly contentType: string | null;
      readonly sourceUrl: string;
      readonly aliasUrl?: string | null;
      readonly thumbnail?: ArtifactThumbnail | null;
      readonly displayKind?: ArtifactCatalogKind;
      readonly runId?: string | null;
      readonly chatThreadId?: string | null;
      readonly createdAt?: Date;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly id: string;
    readonly authorUserId: string;
    readonly chatThreadId: string | null;
  }> => {
    const ownership = await set(
      resolveAuthorAndThread$,
      {
        orgId: args.orgId,
        userId: args.userId,
        runId: args.runId,
        chatThreadId: args.chatThreadId,
      },
      signal,
    );
    const logicalKey = fileArtifactLogicalKey(args.sourceUrl);
    const displayKind: ArtifactCatalogKind =
      args.displayKind ??
      (args.filename.toLowerCase().endsWith(".pptx") ? "presentation" : "file");
    const effectiveContentType =
      args.contentType ?? inferMimetype(args.filename);
    const category = inferFileArtifactCategory(
      displayKind,
      effectiveContentType,
      args.filename,
    );
    const thumbnail =
      args.thumbnail !== undefined
        ? args.thumbnail
        : effectiveContentType.startsWith("image/")
          ? { url: args.sourceUrl }
          : null;
    const createdAt = args.createdAt ?? nowDate();
    const updatedAt = nowDate();
    const db = set(writeDb$);
    const [row] = await db
      .insert(artifacts)
      .values({
        orgId: args.orgId,
        authorUserId: ownership.authorUserId,
        kind: "file",
        displayKind,
        entityId: args.fileId,
        logicalKey,
        chatThreadId: ownership.chatThreadId,
        sourceUrl: args.sourceUrl,
        aliasUrl: args.aliasUrl ?? null,
        title: args.filename,
        thumbnail,
        visibility: "private",
        category,
        createdAt,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: [artifacts.orgId, artifacts.authorUserId, artifacts.logicalKey],
        set: {
          displayKind,
          entityId: args.fileId,
          sourceUrl: args.sourceUrl,
          aliasUrl: args.aliasUrl ?? null,
          title: args.filename,
          thumbnail,
          category,
          updatedAt,
        },
      })
      .returning({
        id: artifacts.id,
        authorUserId: artifacts.authorUserId,
        chatThreadId: artifacts.chatThreadId,
      });
    signal.throwIfAborted();
    if (!row) {
      throw new Error("File artifact upsert returned no row");
    }
    await set(notifyArtifactCatalogChanged$, row);
    signal.throwIfAborted();
    return row;
  },
);

/** Synchronously register a generated image in `image_artifacts` + `artifacts`. */
export const upsertGeneratedImageArtifact$ = command(
  async (
    { set },
    args: {
      readonly fileId: string;
      readonly orgId: string;
      readonly userId: string;
      readonly filename: string;
      readonly sourceUrl: string;
      readonly model: string | null;
      readonly provider: string | null;
      readonly runId?: string | null;
      readonly chatThreadId?: string | null;
      readonly createdAt?: Date;
    },
    signal: AbortSignal,
  ): Promise<{ readonly id: string }> => {
    const db = set(writeDb$);
    const updatedAt = nowDate();
    const [image] = await db
      .insert(imageArtifacts)
      .values({
        fileId: args.fileId,
        model: args.model,
        provider: args.provider,
      })
      .onConflictDoUpdate({
        target: [imageArtifacts.fileId],
        set: {
          model: args.model,
          provider: args.provider,
          updatedAt,
        },
      })
      .returning({ id: imageArtifacts.id });
    signal.throwIfAborted();
    if (!image) {
      throw new Error("Generated image entity upsert returned no row");
    }
    const ownership = await set(
      resolveAuthorAndThread$,
      {
        orgId: args.orgId,
        userId: args.userId,
        runId: args.runId,
        chatThreadId: args.chatThreadId,
      },
      signal,
    );
    const logicalKey = fileArtifactLogicalKey(args.sourceUrl);
    const createdAt = args.createdAt ?? updatedAt;
    const [row] = await db
      .insert(artifacts)
      .values({
        orgId: args.orgId,
        authorUserId: ownership.authorUserId,
        kind: "image",
        displayKind: "image",
        entityId: image.id,
        logicalKey,
        chatThreadId: ownership.chatThreadId,
        sourceUrl: args.sourceUrl,
        title: args.filename,
        thumbnail: { url: args.sourceUrl },
        visibility: "private",
        category: "image",
        createdAt,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: [artifacts.orgId, artifacts.authorUserId, artifacts.logicalKey],
        set: {
          kind: "image",
          displayKind: "image",
          entityId: image.id,
          chatThreadId: sql`COALESCE(${artifacts.chatThreadId}, ${ownership.chatThreadId})`,
          sourceUrl: args.sourceUrl,
          title: args.filename,
          thumbnail: { url: args.sourceUrl },
          category: "image",
          updatedAt,
        },
      })
      .returning({
        id: artifacts.id,
        authorUserId: artifacts.authorUserId,
        chatThreadId: artifacts.chatThreadId,
      });
    signal.throwIfAborted();
    if (!row) {
      throw new Error("Generated image artifact upsert returned no row");
    }
    await set(notifyArtifactCatalogChanged$, row);
    signal.throwIfAborted();
    return { id: row.id };
  },
);

const ensurePresentationEntityId$ = command(
  async (
    { set },
    args: {
      readonly siteId: string;
      readonly kind: "hosted-site" | "presentation";
      readonly updatedAt: Date;
    },
    signal: AbortSignal,
  ): Promise<string> => {
    if (args.kind !== "presentation") {
      return args.siteId;
    }
    const [presentation] = await set(writeDb$)
      .insert(presentationArtifacts)
      .values({ hostedSiteId: args.siteId })
      .onConflictDoUpdate({
        target: [presentationArtifacts.hostedSiteId],
        set: { updatedAt: args.updatedAt },
      })
      .returning({ id: presentationArtifacts.id });
    signal.throwIfAborted();
    if (!presentation) {
      throw new Error("Presentation artifact entity upsert returned no row");
    }
    return presentation.id;
  },
);

/** Synchronously register or update a hosted site / presentation in `artifacts`. */
export const upsertHostedSiteArtifact$ = command(
  async (
    { get, set },
    args: {
      readonly siteId: string;
      readonly orgId: string;
      readonly userId: string;
      readonly kind: "hosted-site" | "presentation";
      readonly title: string;
      readonly sourceUrl: string;
      readonly aliasUrl?: string | null;
      readonly thumbnail?: ArtifactThumbnail | null;
      readonly visibility?: ArtifactVisibility;
      readonly runId?: string | null;
      readonly chatThreadId?: string | null;
      readonly createdAt?: Date;
    },
    signal: AbortSignal,
  ): Promise<{ readonly id: string }> => {
    const db = set(writeDb$);
    const updatedAt = nowDate();
    const entityId = await set(
      ensurePresentationEntityId$,
      { siteId: args.siteId, kind: args.kind, updatedAt },
      signal,
    );

    const logicalKey = `site:${args.siteId}`;
    const [existing] = await get(db$)
      .select({
        id: artifacts.id,
        authorUserId: artifacts.authorUserId,
        chatThreadId: artifacts.chatThreadId,
        title: artifacts.title,
        visibility: artifacts.visibility,
        deletedAt: artifacts.deletedAt,
      })
      .from(artifacts)
      .where(
        and(
          eq(artifacts.orgId, args.orgId),
          eq(artifacts.logicalKey, logicalKey),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    const ownership = existing
      ? {
          authorUserId: existing.authorUserId,
          chatThreadId: existing.chatThreadId,
        }
      : await set(
          resolveAuthorAndThread$,
          {
            orgId: args.orgId,
            userId: args.userId,
            runId: args.runId,
            chatThreadId: args.chatThreadId,
          },
          signal,
        );
    const category: ArtifactCatalogCategory =
      args.kind === "presentation" ? "presentation" : "website";
    const createdAt = args.createdAt ?? updatedAt;
    const effectiveVisibility: ArtifactVisibility =
      args.visibility ?? existing?.visibility ?? "private";
    const commonFields = {
      kind: args.kind,
      displayKind: args.kind,
      entityId,
      sourceUrl: args.sourceUrl,
      aliasUrl: args.aliasUrl ?? null,
      thumbnail: args.thumbnail ?? null,
      category,
      deletedAt: null,
      updatedAt,
    };

    const [saved] = existing
      ? await db
          .update(artifacts)
          .set({
            ...commonFields,
            title: existing.deletedAt ? args.title : existing.title,
            visibility: effectiveVisibility,
          })
          .where(eq(artifacts.id, existing.id))
          .returning({
            id: artifacts.id,
            authorUserId: artifacts.authorUserId,
            chatThreadId: artifacts.chatThreadId,
          })
      : await db
          .insert(artifacts)
          .values({
            ...commonFields,
            orgId: args.orgId,
            authorUserId: ownership.authorUserId,
            logicalKey,
            chatThreadId: ownership.chatThreadId,
            title: args.title,
            visibility: effectiveVisibility,
            createdAt,
          })
          .onConflictDoUpdate({
            target: [
              artifacts.orgId,
              artifacts.authorUserId,
              artifacts.logicalKey,
            ],
            set: {
              ...commonFields,
              ...(args.visibility !== undefined
                ? { visibility: args.visibility }
                : {}),
            },
          })
          .returning({
            id: artifacts.id,
            authorUserId: artifacts.authorUserId,
            chatThreadId: artifacts.chatThreadId,
          });
    signal.throwIfAborted();
    if (!saved) {
      throw new Error("Hosted site artifact upsert returned no row");
    }
    await set(notifyArtifactCatalogChanged$, saved);
    signal.throwIfAborted();
    return { id: saved.id };
  },
);

interface ListArtifactCatalogArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly kind?: ArtifactCatalogListQueryKind;
  readonly category?: ArtifactCatalogCategory;
  readonly chatThreadId?: string;
  readonly keyword?: string;
  readonly direction?: ArtifactCatalogDirection;
}

interface ListArtifactCatalogResult {
  readonly artifacts: readonly ArtifactSummary[];
  readonly nextCursor: string | null;
}

function toArtifactSummary(row: {
  readonly id: string;
  readonly entityId: string;
  readonly kind: ArtifactKind;
  readonly logicalKey: string;
  readonly displayKind: ArtifactCatalogKind | null;
  readonly sourceUrl: string | null;
  readonly aliasUrl: string | null;
  readonly title: string;
  readonly thumbnail: ArtifactThumbnail | null;
  readonly visibility?: ArtifactVisibility;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): ArtifactSummary {
  const kind = row.displayKind ?? catalogArtifactKind(row.kind, row.logicalKey);
  const summary = {
    id: row.id,
    title: row.title,
    thumbnail: row.thumbnail,
    ...(row.sourceUrl ? { sourceUrl: row.sourceUrl } : {}),
    ...(row.aliasUrl ? { aliasUrl: row.aliasUrl } : {}),
    ...(row.visibility ? { visibility: row.visibility } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  return kind === "shared-thread"
    ? { ...summary, kind, sharedThreadId: row.entityId }
    : { ...summary, kind };
}

type ArtifactCatalogListRow = Parameters<typeof toArtifactSummary>[0] & {
  readonly cursorCreatedAt: string;
  readonly category?: ArtifactCatalogCategory;
  readonly sourceChatThread?: {
    readonly id: string;
    readonly title: string | null;
  } | null;
};

function artifactCatalogOwnerFilter(userId: string): SQL {
  return inArray(artifacts.authorUserId, [
    userId,
    sharedThreadArtifactAuthorUserId(userId),
  ]);
}

function artifactCatalogQueryHash(
  args: ListArtifactCatalogArgs,
  direction: ArtifactCatalogDirection,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        args.orgId,
        args.userId,
        args.kind ?? null,
        args.chatThreadId ?? null,
        args.keyword ?? null,
        direction,
        ...(args.category === undefined ? [] : [args.category]),
      ]),
    )
    .digest("hex");
}

function isArtifactCatalogCursorValid(
  cursor: ArtifactCursor | ArtifactLibraryCursor | null,
  libraryQuery: boolean,
  queryHash: string,
): boolean {
  if (!cursor) {
    return false;
  }
  if ("createdAt" in cursor) {
    return !libraryQuery;
  }
  return libraryQuery && cursor.query === queryHash;
}

function artifactCatalogCursorFilter(
  cursor: ArtifactCursor | ArtifactLibraryCursor | null,
  direction: ArtifactCatalogDirection,
): SQL | undefined {
  if (!cursor) {
    return undefined;
  }
  if ("createdAt" in cursor) {
    return lt(
      sql`(${artifacts.createdAt}, ${artifacts.id})`,
      sql`(${cursor.createdAt}::timestamptz AT TIME ZONE 'UTC', ${cursor.id}::uuid)`,
    );
  }
  return direction === "asc"
    ? gt(
        sql`(${artifacts.createdAt}, ${artifacts.id})`,
        sql`(${cursor.value}::timestamp, ${cursor.id}::uuid)`,
      )
    : lt(
        sql`(${artifacts.createdAt}, ${artifacts.id})`,
        sql`(${cursor.value}::timestamp, ${cursor.id}::uuid)`,
      );
}

function artifactCatalogKeywordFilter(
  keyword: string | undefined,
): SQL | undefined {
  if (!keyword) {
    return undefined;
  }
  const pattern = `%${keyword
    .replaceAll("\\", String.raw`\\`)
    .replaceAll("%", String.raw`\%`)
    .replaceAll("_", String.raw`\_`)}%`;
  return ilike(artifacts.title, pattern);
}

function artifactCatalogOrderBy(direction: ArtifactCatalogDirection): SQL[] {
  return [
    direction === "asc" ? asc(artifacts.createdAt) : desc(artifacts.createdAt),
    direction === "asc" ? asc(artifacts.id) : desc(artifacts.id),
  ];
}

function artifactLibraryOrderBy(
  direction: ArtifactCatalogDirection,
  merged = false,
): SQL[] {
  const createdAt = merged ? sql.identifier("created_at") : artifacts.createdAt;
  const id = merged ? sql.identifier("artifact_id") : artifacts.id;
  return direction === "asc"
    ? [sql`${asc(createdAt)} NULLS FIRST`, sql`${asc(id)} NULLS FIRST`]
    : [sql`${desc(createdAt)} NULLS LAST`, sql`${desc(id)} NULLS LAST`];
}

function artifactCatalogSelection() {
  return {
    id: artifacts.id,
    entityId: artifacts.entityId,
    kind: artifacts.kind,
    logicalKey: artifacts.logicalKey,
    displayKind: artifactCatalogEffectiveKind(),
    aliasUrl: artifacts.aliasUrl,
    sourceUrl: artifacts.sourceUrl,
    title: artifacts.title,
    thumbnail: artifacts.thumbnail,
    visibility: artifacts.visibility,
    createdAt: artifacts.createdAt,
    updatedAt: artifacts.updatedAt,
    // Preserve PostgreSQL microseconds in new keyset cursors; Date truncates
    // them and can skip records sharing a millisecond at a page boundary.
    cursorCreatedAt:
      sql`to_char(${artifacts.createdAt}, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.mapWith(
        pgTextDecoder,
      ),
  };
}

function persistedArtifactCategory() {
  return sql`coalesce(${artifacts.category}, 'other')`.mapWith(
    zodEnumDriverValueDecoder(zEnum(ARTIFACT_CATALOG_CATEGORIES)),
  );
}

export const listArtifactCatalog$ = command(
  async (
    { get },
    args: ListArtifactCatalogArgs,
    signal: AbortSignal,
  ): Promise<ListArtifactCatalogResult | null> => {
    const db = get(db$);
    const limit = args.limit ?? ARTIFACT_CATALOG_DEFAULT_LIMIT;
    const libraryQuery =
      args.direction !== undefined || args.category !== undefined;
    const includeLibraryMetadata = args.direction !== undefined;
    const direction = args.direction ?? "desc";
    const queryHash = artifactCatalogQueryHash(args, direction);
    const cursor = args.cursor ? decodeArtifactCursor(args.cursor) : null;
    if (
      args.cursor &&
      !isArtifactCatalogCursorValid(cursor, libraryQuery, queryHash)
    ) {
      return null;
    }
    const cursorFilter = artifactCatalogCursorFilter(cursor, direction);
    const keywordFilter = artifactCatalogKeywordFilter(args.keyword);
    const selection = artifactCatalogSelection();
    const categoryFilter =
      args.category === undefined
        ? undefined
        : args.category === "other"
          ? or(eq(artifacts.category, "other"), isNull(artifacts.category))
          : eq(artifacts.category, args.category);
    const filters = and(
      eq(artifacts.orgId, args.orgId),
      isNull(artifacts.deletedAt),
      args.kind ? artifactCatalogKindFilter(args.kind) : undefined,
      categoryFilter,
      args.chatThreadId
        ? eq(artifacts.chatThreadId, args.chatThreadId)
        : undefined,
      keywordFilter,
      cursorFilter,
    );
    const libraryCatalog = (authorUserId: string) => {
      return db
        .select({
          ...selection,
          // UNION ordering uses output names; distinguish this from the joined
          // source thread's id without changing the response field.
          id: sql`${artifacts.id}`.mapWith(artifacts.id).as("artifact_id"),
          category: persistedArtifactCategory(),
          sourceChatThread: {
            id: chatThreads.id,
            title: chatThreads.title,
          },
        })
        .from(artifacts)
        .leftJoin(
          chatThreads,
          and(
            eq(chatThreads.id, artifacts.chatThreadId),
            eq(chatThreads.orgId, args.orgId),
            eq(chatThreads.userId, args.userId),
            eq(chatThreads.hidden, false),
          ),
        )
        .where(and(filters, eq(artifacts.authorUserId, authorUserId)))
        .orderBy(...artifactLibraryOrderBy(direction))
        .limit(limit + 1);
    };
    // Each author namespace has its own ordered index range. Bound both before
    // merging, while keeping all filters and the cursor inside each range.
    const rows: readonly ArtifactCatalogListRow[] = libraryQuery
      ? await libraryCatalog(args.userId)
          .unionAll(
            libraryCatalog(sharedThreadArtifactAuthorUserId(args.userId)),
          )
          .orderBy(...artifactLibraryOrderBy(direction, true))
          .limit(limit + 1)
      : await db
          .select(selection)
          .from(artifacts)
          .where(and(filters, artifactCatalogOwnerFilter(args.userId)))
          .orderBy(...artifactCatalogOrderBy(direction))
          .limit(limit + 1);
    signal.throwIfAborted();

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const lastRow = pageRows.at(-1);
    return {
      artifacts: pageRows.map((row) => {
        const summary = toArtifactSummary(row);
        if (!includeLibraryMetadata || row.category === undefined) {
          return summary;
        }
        return {
          ...summary,
          category: row.category,
          ...(row.sourceChatThread && row.sourceChatThread.title !== null
            ? {
                sourceChatThread: {
                  id: row.sourceChatThread.id,
                  title: row.sourceChatThread.title,
                },
              }
            : {}),
        };
      }),
      nextCursor:
        hasMore && lastRow
          ? encodeArtifactCursor(
              libraryQuery
                ? {
                    query: queryHash,
                    value: lastRow.cursorCreatedAt,
                    id: lastRow.id,
                  }
                : {
                    createdAt: lastRow.createdAt.toISOString(),
                    id: lastRow.id,
                  },
            )
          : null,
    };
  },
);

interface GetArtifactCatalogEntryArgs {
  readonly artifactId: string;
  readonly sourceKind?: "file" | "html" | "shared-thread" | "site";
  readonly orgId: string;
  readonly userId: string;
}

function artifactCatalogIdentityFilter(args: GetArtifactCatalogEntryArgs) {
  switch (args.sourceKind) {
    case "file": {
      const qb = new QueryBuilder();
      return or(
        and(
          eq(artifacts.kind, "file"),
          notLike(artifacts.logicalKey, "shared-thread:%"),
          eq(artifacts.entityId, args.artifactId),
        ),
        and(
          eq(artifacts.kind, "image"),
          inArray(
            artifacts.entityId,
            qb
              .select({ id: imageArtifacts.id })
              .from(imageArtifacts)
              .where(eq(imageArtifacts.fileId, args.artifactId)),
          ),
        ),
      );
    }
    case "html": {
      const qb = new QueryBuilder();
      const sites = qb
        .select({
          logicalKey: sql`'site:' || ${privateHostedDeployments.siteId}::text`
            .mapWith(artifacts.logicalKey)
            .as("logical_key"),
        })
        .from(privateHostedDeployments)
        .where(
          and(
            eq(privateHostedDeployments.id, args.artifactId),
            eq(privateHostedDeployments.orgId, args.orgId),
            eq(privateHostedDeployments.userId, args.userId),
          ),
        );
      return inArray(artifacts.logicalKey, sites);
    }
    case "shared-thread": {
      return eq(
        artifacts.logicalKey,
        sharedThreadArtifactLogicalKey(args.artifactId),
      );
    }
    case "site": {
      return eq(artifacts.logicalKey, `site:${args.artifactId}`);
    }
    case undefined: {
      return eq(artifacts.id, args.artifactId);
    }
  }
}

export const getOwnedArtifactCatalogFromReference$ = command(
  async (
    { set },
    args: {
      readonly reference: string;
      readonly userId: string;
      readonly orgId: string;
    },
    signal: AbortSignal,
  ): Promise<ArtifactDetail | null> => {
    const parsed = parseArtifactReference(`/artifacts/${args.reference}`);
    if (!parsed) {
      return null;
    }
    const record =
      parsed.id === null
        ? await set(artifactReferenceRecord$, parsed.hash, signal)
        : null;
    signal.throwIfAborted();
    // Conversation snapshot resources never grant management of their source.
    if ((parsed.id === null && !record) || record?.version === 3) {
      return null;
    }
    if (record?.version === 2) {
      return await set(
        getArtifactCatalogEntry$,
        {
          ...args,
          artifactId: record.target.id,
          sourceKind: record.target.kind,
        },
        signal,
      );
    }
    if (parsed.id) {
      const file = await set(
        getArtifactCatalogEntry$,
        {
          ...args,
          artifactId: parsed.id,
          sourceKind: "file",
        },
        signal,
      );
      if (file) {
        return file;
      }
    }
    const shareId =
      parsed.id ?? (record?.version === 1 ? record.shareId : null);
    if (!shareId) {
      return null;
    }
    const policy = await set(
      probeLegacyArtifactSharePolicy$,
      { shareId },
      signal,
    );
    signal.throwIfAborted();
    if (
      !policy ||
      policy.ownerId !== args.userId ||
      policy.orgId !== args.orgId
    ) {
      return null;
    }
    return await set(
      getArtifactCatalogEntry$,
      {
        ...args,
        artifactId:
          policy.target.kind === "file"
            ? policy.target.id
            : policy.target.siteId,
        sourceKind: policy.target.kind === "file" ? "file" : "site",
      },
      signal,
    );
  },
);

const fileDetail$ = command(
  async (
    { get },
    args: {
      readonly fileId: string;
      readonly sourceUrl: string | null;
      readonly thumbnail: ArtifactThumbnail | null;
    },
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
        id: files.id,
        storageKey: files.storageKey,
        filename: files.filename,
        contentType: files.contentType,
        sizeBytes: files.sizeBytes,
      })
      .from(files)
      .where(eq(files.id, args.fileId))
      .limit(1);
    signal.throwIfAborted();
    if (!row?.storageKey || !row.filename) {
      return null;
    }
    const url =
      args.sourceUrl ??
      (row.storageKey.startsWith("private-artifacts/")
        ? new URL(artifactReferencePath(row.id, row.filename), env("APP_URL"))
            .href
        : buildFileUrlFromKey(row.storageKey, "current"));
    return {
      id: row.id,
      filename: row.filename,
      contentType: row.contentType || inferMimetype(row.filename),
      size: row.sizeBytes ?? 0,
      url,
      previewImageUrl: args.thumbnail?.url ?? null,
    };
  },
);

const hostedSiteDetail$ = command(
  async (
    { get },
    hostedSiteId: string,
    owner: { readonly userId: string; readonly orgId: string },
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
      .where(
        and(eq(hostedSites.id, hostedSiteId), isNull(hostedSites.deletedAt)),
      )
      .limit(1);
    signal.throwIfAborted();
    if (row) {
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
            nullableDriverValueDecoder(pgIntegerDecoder),
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
          eq(privateHostedDeployments.userId, owner.userId),
          eq(privateHostedDeployments.orgId, owner.orgId),
          eq(privateHostedDeployments.status, "ready"),
          isNull(hostedSites.deletedAt),
        ),
      )
      .orderBy(desc(privateHostedDeployments.createdAt))
      .limit(1);
    signal.throwIfAborted();
    return privateRow
      ? { ...privateRow, slug: privateRow.requestedSlug ?? privateRow.slug }
      : null;
  },
);

const presentationDetail$ = command(
  async (
    { get, set },
    summary: ArtifactSummary,
    entityId: string,
    owner: { readonly userId: string; readonly orgId: string },
    signal: AbortSignal,
  ): Promise<ArtifactDetail | null> => {
    const db = get(db$);
    const [entity] = await db
      .select({ hostedSiteId: presentationArtifacts.hostedSiteId })
      .from(presentationArtifacts)
      .where(eq(presentationArtifacts.id, entityId))
      .limit(1);
    signal.throwIfAborted();
    if (!entity) {
      return null;
    }
    const site = await set(
      hostedSiteDetail$,
      entity.hostedSiteId,
      owner,
      signal,
    );
    return site ? { ...summary, kind: "presentation", site } : null;
  },
);

function selectArtifactCatalogEntry(
  db: ReadonlyDb,
  args: GetArtifactCatalogEntryArgs,
) {
  return db
    .select({
      id: artifacts.id,
      kind: artifacts.kind,
      logicalKey: artifacts.logicalKey,
      entityId: artifacts.entityId,
      sourceChatThreadId: chatThreads.id,
      displayKind: artifacts.displayKind,
      aliasUrl: artifacts.aliasUrl,
      sourceUrl: artifacts.sourceUrl,
      title: artifacts.title,
      thumbnail: artifacts.thumbnail,
      visibility: artifacts.visibility,
      createdAt: artifacts.createdAt,
      updatedAt: artifacts.updatedAt,
    })
    .from(artifacts)
    .leftJoin(
      chatThreads,
      and(
        eq(chatThreads.id, artifacts.chatThreadId),
        eq(chatThreads.orgId, args.orgId),
        eq(chatThreads.userId, args.userId),
        eq(chatThreads.hidden, false),
      ),
    )
    .where(
      and(
        artifactCatalogIdentityFilter(args),
        eq(artifacts.orgId, args.orgId),
        artifactCatalogOwnerFilter(args.userId),
        isNull(artifacts.deletedAt),
      ),
    )
    .limit(1);
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
    const [row] = await selectArtifactCatalogEntry(db, args);
    signal.throwIfAborted();
    if (!row) {
      return null;
    }

    const summary = {
      ...toArtifactSummary(row),
      ...(row.sourceChatThreadId
        ? { sourceChatThreadId: row.sourceChatThreadId }
        : {}),
    };
    if (
      row.kind === "file" &&
      isSharedThreadArtifactLogicalKey(row.logicalKey)
    ) {
      return {
        ...summary,
        kind: "shared-thread",
        sharedThreadId: row.entityId,
        sharedThread: { id: row.entityId },
      };
    }
    if (summary.kind === "avatar") {
      const file = await set(
        fileDetail$,
        {
          fileId: row.entityId,
          sourceUrl: row.sourceUrl,
          thumbnail: row.thumbnail,
        },
        signal,
      );
      return file
        ? {
            ...summary,
            kind: "avatar",
            file,
            model: null,
            durationSeconds: null,
          }
        : null;
    }

    if (row.kind === "file") {
      const file = await set(
        fileDetail$,
        {
          fileId: row.entityId,
          sourceUrl: row.sourceUrl,
          thumbnail: row.thumbnail,
        },
        signal,
      );
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
      const file = await set(
        fileDetail$,
        {
          fileId: entity.fileId,
          sourceUrl: row.sourceUrl,
          thumbnail: row.thumbnail,
        },
        signal,
      );
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

    if (row.kind === "hosted-site") {
      const site = await set(hostedSiteDetail$, row.entityId, args, signal);
      return site ? { ...summary, kind: "hosted-site", site } : null;
    }

    return await set(presentationDetail$, summary, row.entityId, args, signal);
  },
);
