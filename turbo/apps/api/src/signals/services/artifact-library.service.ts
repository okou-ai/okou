import { createHash } from "node:crypto";
import { command } from "ccstate";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  ilike,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import {
  ARTIFACT_CATALOG_KINDS,
  type ArtifactCatalogDirection,
  type ArtifactCatalogKind,
  type ArtifactCatalogSort,
  type ArtifactDetail,
  type ArtifactSummary,
} from "@okouai/api-contracts/contracts/artifact-catalog";
import {
  artifactCatalogFavorites,
  artifacts,
} from "@okouai/db/schema/artifact";
import { runUploadedFiles } from "@okouai/db/schema/run-uploaded-file";
import {
  iso,
  object,
  string,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";
import {
  pgTextDecoder,
  zodEnumDriverValueDecoder,
} from "../../lib/db-structured-result";
import { db$, writeDb$ } from "../external/db";
import { safeJsonParse } from "../utils";
import { canReadArtifactCatalogEntry$ } from "./artifact-catalog-access.service";
import {
  artifactCatalogDetail$,
  artifactCatalogOwnerFilter,
  getArtifactCatalogEntry$,
  readArtifactCatalogCandidate$,
  toArtifactSummary,
} from "./artifact-catalog.service";

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
  value: string(),
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

interface ListArtifactCatalogArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly kind?: ArtifactCatalogKind;
  readonly chatThreadId?: string;
  readonly keyword?: string;
  readonly sort?: ArtifactCatalogSort;
  readonly direction?: ArtifactCatalogDirection;
  readonly starred?: boolean;
}

interface ListArtifactCatalogResult {
  readonly artifacts: readonly ArtifactSummary[];
  readonly nextCursor: string | null;
}

function artifactCatalogEffectiveKind() {
  // Native PPTX files belong to Presentations without changing their file-backed
  // storage or detail contract. Derive this on reads so existing files move too.
  // Other summaries retain their display projection or base-kind fallback.
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

function artifactCatalogKindFilter(kind: ArtifactCatalogKind): SQL {
  return eq(artifactCatalogEffectiveKind(), kind);
}

function artifactCatalogQueryHash(
  args: ListArtifactCatalogArgs,
  sort: ArtifactCatalogSort,
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
        sort,
        direction,
        args.starred ?? false,
      ]),
    )
    .digest("hex");
}

function isArtifactCatalogCursorValid(
  cursor: ArtifactCursor | ArtifactLibraryCursor | null,
  libraryQuery: boolean,
  sort: ArtifactCatalogSort,
  queryHash: string,
): boolean {
  if (!cursor) {
    return false;
  }
  if ("createdAt" in cursor) {
    return !libraryQuery;
  }
  if (!libraryQuery || cursor.query !== queryHash) {
    return false;
  }
  return (
    sort === "title" ||
    iso.datetime({ precision: 6 }).safeParse(cursor.value).success
  );
}

function artifactCatalogSortColumn(sort: ArtifactCatalogSort) {
  return sort === "title" ? artifacts.title : artifacts.createdAt;
}

function artifactCatalogCursorFilter(
  cursor: ArtifactCursor | ArtifactLibraryCursor | null,
  sort: ArtifactCatalogSort,
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
  const sortColumn = artifactCatalogSortColumn(sort);
  const value =
    sort === "title" ? sql`${cursor.value}` : sql`${cursor.value}::timestamp`;
  return direction === "asc"
    ? gt(
        sql`(${sortColumn}, ${artifacts.id})`,
        sql`(${value}, ${cursor.id}::uuid)`,
      )
    : lt(
        sql`(${sortColumn}, ${artifacts.id})`,
        sql`(${value}, ${cursor.id}::uuid)`,
      );
}

function artifactCatalogKeywordFilter(
  keyword: string | undefined,
  libraryQuery: boolean,
): SQL | undefined {
  if (!keyword) {
    return undefined;
  }
  const pattern = `%${keyword
    .replaceAll("\\", String.raw`\\`)
    .replaceAll("%", String.raw`\%`)
    .replaceAll("_", String.raw`\_`)}%`;
  const qb = new QueryBuilder();
  return or(
    ilike(artifacts.title, pattern),
    libraryQuery
      ? exists(
          qb
            .select({ id: runUploadedFiles.id })
            .from(runUploadedFiles)
            .where(
              and(
                eq(runUploadedFiles.id, artifacts.projectionFileId),
                eq(runUploadedFiles.orgId, artifacts.orgId),
                ilike(runUploadedFiles.filename, pattern),
              ),
            ),
        )
      : undefined,
  );
}

function artifactCatalogOrderBy(
  sort: ArtifactCatalogSort,
  direction: ArtifactCatalogDirection,
): SQL[] {
  const column = artifactCatalogSortColumn(sort);
  return [
    direction === "asc" ? asc(column) : desc(column),
    direction === "asc" ? asc(artifacts.id) : desc(artifacts.id),
  ];
}

function artifactCatalogFavoriteFilter(args: {
  readonly userId: string;
  readonly orgId: string;
}): SQL {
  const qb = new QueryBuilder();
  return exists(
    qb
      .select({ id: artifactCatalogFavorites.artifactId })
      .from(artifactCatalogFavorites)
      .where(
        and(
          eq(artifactCatalogFavorites.artifactId, artifacts.id),
          eq(artifactCatalogFavorites.orgId, args.orgId),
          eq(artifactCatalogFavorites.userId, args.userId),
        ),
      ),
  );
}

function isArtifactLibraryQuery(args: ListArtifactCatalogArgs): boolean {
  return (
    args.sort !== undefined ||
    args.direction !== undefined ||
    args.starred === true
  );
}

const readArtifactCatalogPage$ = command(
  async (
    { get },
    args: ListArtifactCatalogArgs,
    cursor: ArtifactCursor | ArtifactLibraryCursor | null,
    signal: AbortSignal,
  ) => {
    const db = get(db$);
    const libraryQuery = isArtifactLibraryQuery(args);
    const sort = args.sort ?? "createdAt";
    const direction = args.direction ?? "desc";
    const sortColumn = artifactCatalogSortColumn(sort);
    const favoriteFilter = libraryQuery
      ? artifactCatalogFavoriteFilter(args)
      : undefined;
    const rows = await db
      .select({
        id: artifacts.id,
        entityId: artifacts.entityId,
        authorUserId: artifacts.authorUserId,
        projectionFileId: artifacts.projectionFileId,
        kind: artifacts.kind,
        logicalKey: artifacts.logicalKey,
        displayKind: artifactCatalogEffectiveKind(),
        aliasUrl: artifacts.aliasUrl,
        sourceUrl: artifacts.sourceUrl,
        videoSourceUrl: artifacts.videoSourceUrl,
        title: artifacts.title,
        thumbnail: artifacts.thumbnail,
        createdAt: artifacts.createdAt,
        updatedAt: artifacts.updatedAt,
        // Keep PostgreSQL microseconds at Created keyset boundaries.
        sortValue:
          !libraryQuery || sort === "title"
            ? artifacts.title
            : sql`to_char(${sortColumn}, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.mapWith(
                pgTextDecoder,
              ),
      })
      .from(artifacts)
      .where(
        and(
          eq(artifacts.orgId, args.orgId),
          args.starred
            ? favoriteFilter
            : libraryQuery
              ? or(artifactCatalogOwnerFilter(args.userId), favoriteFilter)
              : artifactCatalogOwnerFilter(args.userId),
          isNull(artifacts.deletedAt),
          args.kind ? artifactCatalogKindFilter(args.kind) : undefined,
          args.chatThreadId
            ? eq(artifacts.chatThreadId, args.chatThreadId)
            : undefined,
          artifactCatalogKeywordFilter(args.keyword, libraryQuery),
          artifactCatalogCursorFilter(cursor, sort, direction),
        ),
      )
      .orderBy(...artifactCatalogOrderBy(sort, direction))
      .limit(
        libraryQuery ? 200 : (args.limit ?? ARTIFACT_CATALOG_DEFAULT_LIMIT) + 1,
      );
    signal.throwIfAborted();
    return rows;
  },
);

/** The route owns the feature gate; legacy queries retain their owner-only path. */
export const listArtifactCatalog$ = command(
  async (
    { set },
    args: ListArtifactCatalogArgs,
    signal: AbortSignal,
  ): Promise<ListArtifactCatalogResult | null> => {
    const limit = args.limit ?? ARTIFACT_CATALOG_DEFAULT_LIMIT;
    const libraryQuery = isArtifactLibraryQuery(args);
    const sort = args.sort ?? "createdAt";
    const direction = args.direction ?? "desc";
    const queryHash = artifactCatalogQueryHash(args, sort, direction);
    const cursor = args.cursor ? decodeArtifactCursor(args.cursor) : null;
    if (
      args.cursor &&
      !isArtifactCatalogCursorValid(cursor, libraryQuery, sort, queryHash)
    ) {
      return null;
    }
    const rows: Awaited<ReturnType<typeof readArtifactCatalogPage$.write>> = [];
    let scanCursor = cursor;
    while (rows.length <= limit) {
      const candidates = await set(
        readArtifactCatalogPage$,
        args,
        scanCursor,
        signal,
      );
      for (const row of candidates) {
        if (
          !libraryQuery ||
          (await set(canReadArtifactCatalogEntry$, row, args, signal))
        ) {
          rows.push(row);
          if (rows.length > limit) {
            break;
          }
        }
      }
      const lastCandidate = candidates.at(-1);
      if (!libraryQuery || candidates.length < 200 || !lastCandidate) {
        break;
      }
      scanCursor = {
        query: queryHash,
        value: lastCandidate.sortValue,
        id: lastCandidate.id,
      };
    }

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const lastRow = pageRows.at(-1);
    return {
      artifacts: pageRows.map(toArtifactSummary),
      nextCursor:
        hasMore && lastRow
          ? encodeArtifactCursor(
              libraryQuery
                ? {
                    query: queryHash,
                    value: lastRow.sortValue,
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

export const listArtifactCatalogFavorites$ = command(
  async (
    { get, set },
    viewer: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<string[]> => {
    const rows = await get(db$)
      .select({
        id: artifacts.id,
        kind: artifacts.kind,
        entityId: artifacts.entityId,
        logicalKey: artifacts.logicalKey,
        authorUserId: artifacts.authorUserId,
        projectionFileId: artifacts.projectionFileId,
      })
      .from(artifactCatalogFavorites)
      .innerJoin(
        artifacts,
        eq(artifacts.id, artifactCatalogFavorites.artifactId),
      )
      .where(
        and(
          eq(artifactCatalogFavorites.orgId, viewer.orgId),
          eq(artifactCatalogFavorites.userId, viewer.userId),
          eq(artifacts.orgId, viewer.orgId),
          isNull(artifacts.deletedAt),
        ),
      )
      .orderBy(asc(artifacts.id));
    signal.throwIfAborted();
    const artifactIds: string[] = [];
    for (const row of rows) {
      if (await set(canReadArtifactCatalogEntry$, row, viewer, signal)) {
        artifactIds.push(row.id);
      }
    }
    return artifactIds;
  },
);

export const setArtifactCatalogFavorite$ = command(
  async (
    { set },
    args: {
      readonly artifactId: string;
      readonly orgId: string;
      readonly userId: string;
      readonly starred: boolean;
    },
    signal: AbortSignal,
  ): Promise<{ artifactId: string; starred: boolean } | null> => {
    const row = await set(readArtifactCatalogCandidate$, args, false, signal);
    if (!row || !(await set(canReadArtifactCatalogEntry$, row, args, signal))) {
      return null;
    }
    const db = set(writeDb$);
    if (args.starred) {
      await db
        .insert(artifactCatalogFavorites)
        .select(
          db
            .select({
              orgId: sql`${args.orgId}`
                .mapWith(artifactCatalogFavorites.orgId)
                .as("org_id"),
              userId: sql`${args.userId}`
                .mapWith(artifactCatalogFavorites.userId)
                .as("user_id"),
              artifactId: artifacts.id,
            })
            .from(artifacts)
            .where(
              and(
                eq(artifacts.id, args.artifactId),
                eq(artifacts.orgId, args.orgId),
                isNull(artifacts.deletedAt),
              ),
            ),
        )
        .onConflictDoNothing({
          target: [
            artifactCatalogFavorites.orgId,
            artifactCatalogFavorites.userId,
            artifactCatalogFavorites.artifactId,
          ],
        });
    } else {
      await db
        .delete(artifactCatalogFavorites)
        .where(
          and(
            eq(artifactCatalogFavorites.orgId, args.orgId),
            eq(artifactCatalogFavorites.userId, args.userId),
            eq(artifactCatalogFavorites.artifactId, args.artifactId),
          ),
        );
    }
    signal.throwIfAborted();
    return { artifactId: args.artifactId, starred: args.starred };
  },
);

/** Live read authority never changes the foundation's owner-only management read. */
export const getArtifactLibraryEntry$ = command(
  async (
    { set },
    args: {
      readonly artifactId: string;
      readonly sourceKind?: "shared-thread";
      readonly orgId: string;
      readonly userId: string;
      readonly libraryAccess: boolean;
    },
    signal: AbortSignal,
  ): Promise<ArtifactDetail | null> => {
    if (!args.libraryAccess) {
      return await set(getArtifactCatalogEntry$, args, signal);
    }
    const row = await set(readArtifactCatalogCandidate$, args, false, signal);
    if (!row || !(await set(canReadArtifactCatalogEntry$, row, args, signal))) {
      return null;
    }
    return await set(artifactCatalogDetail$, row, args.orgId, signal);
  },
);
