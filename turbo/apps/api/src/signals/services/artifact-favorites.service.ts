import { createHash } from "node:crypto";
import { command, computed, type Computed } from "ccstate";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { iso, object, string, uuid } from "zod";
import type {
  ArtifactFavorite,
  ArtifactFavoriteDetail,
  ArtifactFavoritesListQuery,
} from "@okouai/api-contracts/contracts/artifact-favorites";
import type {
  ArtifactCatalogCategory,
  ArtifactSummary,
} from "@okouai/api-contracts/contracts/artifact-catalog";
import { artifactFavorites } from "@okouai/db/schema/artifact-favorite";
import { pgTextDecoder } from "../../lib/db-structured-result";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { safeJsonParse } from "../utils";
import { readFavoriteArtifact$ } from "./artifact-favorite-access.service";

interface CollectionOwner {
  readonly orgId: string;
  readonly userId: string;
}

const cursorSchema = object({
  query: string(),
  createdAt: iso.datetime({ precision: 6 }),
  artifactId: uuid(),
});

function favoriteSummary(detail: ArtifactFavoriteDetail): ArtifactSummary {
  const common = {
    id: detail.id,
    title: detail.title,
    thumbnail: detail.thumbnail,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    ...(detail.sourceUrl ? { sourceUrl: detail.sourceUrl } : {}),
    ...(detail.aliasUrl ? { aliasUrl: detail.aliasUrl } : {}),
    ...(detail.videoSourceUrl ? { videoSourceUrl: detail.videoSourceUrl } : {}),
  };
  return detail.kind === "shared-thread"
    ? { ...common, kind: detail.kind, sharedThreadId: detail.sharedThreadId }
    : { ...common, kind: detail.kind };
}

function matchesFavoriteFilters(
  args: ArtifactFavoritesListQuery,
  current: {
    readonly detail: ArtifactFavoriteDetail;
    readonly category: ArtifactCatalogCategory;
  } | null,
): boolean {
  if (args.category && current?.category !== args.category) {
    return false;
  }
  const keyword = args.keyword?.toLowerCase();
  if (!keyword) {
    return true;
  }
  if (!current) {
    return false;
  }
  return [
    current.detail.title,
    "file" in current.detail ? current.detail.file.filename : "",
  ].some((value) => {
    return value.toLowerCase().includes(keyword);
  });
}

export function artifactFavoriteStatus(
  input$: Computed<
    CollectionOwner & { readonly artifactIds: readonly string[] }
  >,
) {
  return computed(async (get) => {
    const input = get(input$);
    const rows = await get(db$)
      .select({ artifactId: artifactFavorites.artifactId })
      .from(artifactFavorites)
      .where(
        and(
          eq(artifactFavorites.orgId, input.orgId),
          eq(artifactFavorites.userId, input.userId),
          inArray(artifactFavorites.artifactId, input.artifactIds),
        ),
      );
    const ids = new Set(
      rows.map((row) => {
        return row.artifactId;
      }),
    );
    return Object.fromEntries(
      input.artifactIds.map((id) => {
        return [id, ids.has(id)];
      }),
    );
  });
}

export const createArtifactFavorite$ = command(
  async (
    { set },
    args: CollectionOwner & { readonly artifactId: string },
    signal: AbortSignal,
  ) => {
    await set(writeDb$)
      .insert(artifactFavorites)
      .values({ ...args, createdAt: nowDate() })
      .onConflictDoNothing({
        target: [
          artifactFavorites.orgId,
          artifactFavorites.userId,
          artifactFavorites.artifactId,
        ],
      });
    signal.throwIfAborted();
    return { artifactId: args.artifactId, favorited: true as const };
  },
);

export const removeArtifactFavorite$ = command(
  async (
    { set },
    args: CollectionOwner & { readonly artifactId: string },
    signal: AbortSignal,
  ) => {
    await set(writeDb$)
      .delete(artifactFavorites)
      .where(
        and(
          eq(artifactFavorites.orgId, args.orgId),
          eq(artifactFavorites.userId, args.userId),
          eq(artifactFavorites.artifactId, args.artifactId),
        ),
      );
    signal.throwIfAborted();
    return { artifactId: args.artifactId, favorited: false as const };
  },
);

/** Scan one bounded relation page. Filter only AFTER live authorization. */
export const listArtifactFavorites$ = command(
  async (
    { get, set },
    args: CollectionOwner & ArtifactFavoritesListQuery,
    signal: AbortSignal,
  ) => {
    const limit = args.limit ?? 20;
    const query = createHash("sha256")
      .update(
        JSON.stringify([
          args.orgId,
          args.userId,
          args.category ?? null,
          args.keyword ?? null,
        ]),
      )
      .digest("hex");
    const parsed = args.cursor
      ? cursorSchema.safeParse(
          safeJsonParse(Buffer.from(args.cursor, "base64url").toString("utf8")),
        )
      : null;
    if (parsed && (!parsed.success || parsed.data.query !== query)) {
      return null;
    }
    const cursor = parsed?.success ? parsed.data : null;
    const rows = await get(db$)
      .select({
        artifactId: artifactFavorites.artifactId,
        createdAt: artifactFavorites.createdAt,
        cursorCreatedAt:
          sql`to_char(${artifactFavorites.createdAt}, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.mapWith(
            pgTextDecoder,
          ),
      })
      .from(artifactFavorites)
      .where(
        and(
          eq(artifactFavorites.orgId, args.orgId),
          eq(artifactFavorites.userId, args.userId),
          cursor
            ? lt(
                sql`(${artifactFavorites.createdAt}, ${artifactFavorites.artifactId})`,
                sql`(${cursor.createdAt}::timestamp, ${cursor.artifactId}::uuid)`,
              )
            : undefined,
        ),
      )
      .orderBy(
        sql`${artifactFavorites.createdAt} DESC NULLS LAST`,
        sql`${artifactFavorites.artifactId} DESC NULLS LAST`,
      )
      .limit(limit + 1);
    signal.throwIfAborted();
    const page = rows.slice(0, limit);
    const hydrated = await Promise.all(
      page.map(async (row) => {
        const current = await set(
          readFavoriteArtifact$,
          { ...args, artifactId: row.artifactId },
          signal,
        );
        return { row, current };
      }),
    );
    signal.throwIfAborted();
    const favorites: ArtifactFavorite[] = [];
    for (const { row, current } of hydrated) {
      if (!matchesFavoriteFilters(args, current)) {
        continue;
      }
      favorites.push({
        artifactId: row.artifactId,
        createdAt: row.createdAt.toISOString(),
        artifact: current
          ? { ...favoriteSummary(current.detail), category: current.category }
          : null,
      });
    }
    const last = page.at(-1);
    return {
      favorites,
      // Empty filtered pages can continue. Cursor shape depends only on the
      // caller's own relations, never on a denied target's title/category.
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(
              JSON.stringify({
                query,
                createdAt: last.cursorCreatedAt,
                artifactId: last.artifactId,
              }),
              "utf8",
            ).toString("base64url")
          : null,
    };
  },
);
