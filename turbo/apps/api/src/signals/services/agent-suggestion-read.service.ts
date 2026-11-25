import {
  suggestionStatus,
  liveSuggestion,
  suggestionRow,
} from "./agent-suggestions-lifecycle";
import { Buffer } from "node:buffer";
import type { infer as zInfer } from "zod";
import { command } from "ccstate";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { feedItems } from "@okouai/db/schema/feed-item";
import { workflows } from "@okouai/db/schema/workflow";
import {
  officialWorkflowCatalogReleases,
  officialWorkflowCatalogState,
  officialWorkflowDefinitionRevisions,
} from "@okouai/db/schema/official-workflow-catalog";
import {
  FEED_PAGE_SIZE,
  SUGGESTION_RETENTION_MS,
  suggestionReceiptSchema,
  suggestionSchema,
  platformEventSchema,
} from "@okouai/api-contracts/contracts/feed";
import { db$ } from "../external/db";
import { organizationAuthContext$ } from "../auth/auth-context";
import {
  nullableDriverValueDecoder,
  pgTextDecoder,
} from "../../lib/db-structured-result";
import { safeJsonParse } from "../utils";
import { badRequestMessage } from "../../lib/error";
import { nowDate } from "../../lib/time";
import { withSuggestionConsumeToken } from "./agent-suggestion-consumption-token";
import { visibleWorkflowCondition } from "./workflow-visibility";
import {
  acceptedCatalogDefinitionRevision,
  acceptedOfficialWorkflowCatalogReadPlan,
} from "./official-workflow-catalog-read.service";
import { builtInWorkflow } from "./builtin-workflows";

interface Owner {
  readonly orgId: string;
  readonly userId: string;
}
export function suggestionOwner(owner: Owner) {
  return and(
    eq(feedItems.orgId, owner.orgId),
    eq(feedItems.userId, owner.userId),
    eq(feedItems.type, "suggestion"),
  );
}
export const storedSuggestion$ = command(
  async ({ get }, owner: Owner, id: string, signal: AbortSignal) => {
    const [row] = await get(db$)
      .select()
      .from(feedItems)
      .where(and(suggestionOwner(owner), eq(feedItems.id, id)))
      .limit(1);
    signal.throwIfAborted();
    return row ? suggestionRow(row) : null;
  },
);
const recentSuggestionReceipts$ = command(
  async ({ get }, owner: Owner, signal: AbortSignal) => {
    const cutoff = new Date(nowDate().getTime() - SUGGESTION_RETENTION_MS);
    const rows = await get(db$)
      .select({
        id: feedItems.id,
        type: feedItems.type,
        priority: feedItems.priority,
        state: feedItems.state,
        createdAt: feedItems.createdAt,
        updatedAt: feedItems.updatedAt,
        expiresAt: feedItems.expiresAt,
      })
      .from(feedItems)
      .where(
        and(
          suggestionOwner(owner),
          ne(suggestionStatus, "active"),
          gt(feedItems.updatedAt, cutoff),
        ),
      )
      .orderBy(sql`${desc(feedItems.updatedAt)} NULLS LAST`, asc(feedItems.id))
      .limit(100);
    signal.throwIfAborted();
    return rows.map((row) => {
      return suggestionReceiptSchema.parse({
        ...row,
        content: null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        expiresAt: row.expiresAt?.toISOString() ?? null,
      });
    });
  },
);

/** Resolve current descriptions for the same workflows the signed-in member can open. */
const feedAutomationDescriptions$ = command(
  async ({ get }, workflowIds: readonly string[], signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.tokenType !== "session" || workflowIds.length === 0) {
      return new Map<string, string | null>();
    }
    const catalog = acceptedOfficialWorkflowCatalogReadPlan();
    const rows = await get(db$)
      .select({
        id: workflows.id,
        definitionName: workflows.officialDefinitionName,
        description: sql`coalesce(
          ${officialWorkflowDefinitionRevisions.payload}->'workflow'->>'description',
          ${workflows.description}
        )`.mapWith(nullableDriverValueDecoder(pgTextDecoder)),
      })
      .from(workflows)

      .leftJoin(
        officialWorkflowCatalogState,
        and(isNotNull(workflows.officialDefinitionName), catalog.condition),
      )
      .leftJoin(officialWorkflowCatalogReleases, catalog.join)
      .leftJoin(
        officialWorkflowDefinitionRevisions,
        and(
          eq(
            officialWorkflowDefinitionRevisions.definitionName,
            workflows.officialDefinitionName,
          ),
          eq(
            officialWorkflowDefinitionRevisions.revision,
            acceptedCatalogDefinitionRevision(workflows.officialDefinitionName),
          ),
        ),
      )
      .where(
        and(
          eq(workflows.orgId, auth.orgId),
          inArray(workflows.id, workflowIds),
          visibleWorkflowCondition(auth.userId),
        ),
      );
    signal.throwIfAborted();
    return new Map(
      rows.map(({ id, description, definitionName }) => {
        return [
          id,
          builtInWorkflow(definitionName)?.revision.definition.workflow
            .description ?? description,
        ] as const;
      }),
    );
  },
);

const feedCursorSchema = suggestionSchema.pick({
  priority: true,
  createdAt: true,
  id: true,
});
type FeedCursor = zInfer<typeof feedCursorSchema>;

export const readActiveFeedCards$ = command(
  async (
    { get, set },
    owner: Owner,
    options: {
      readonly type?: "suggestion" | "event";
      readonly firstOnly?: boolean;
      readonly after?: FeedCursor;
    },
    signal: AbortSignal,
  ) => {
    const { after } = options;
    const limit = options.firstOnly ? 1 : FEED_PAGE_SIZE;
    const rows = await get(db$)
      .select({
        card: feedItems,
        // Preserve microseconds at the page boundary; Date truncates to milliseconds.
        cursorTime:
          sql`to_char(${feedItems.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.mapWith(
            pgTextDecoder,
          ),
      })
      .from(feedItems)
      .where(
        and(
          eq(feedItems.orgId, owner.orgId),
          eq(feedItems.userId, owner.userId),
          after
            ? or(
                lt(feedItems.priority, after.priority),
                and(
                  eq(feedItems.priority, after.priority),
                  sql`(${feedItems.createdAt}, ${feedItems.id}) > (${after.createdAt}::timestamptz, ${after.id}::uuid)`,
                ),
              )
            : undefined,
          options.type ? eq(feedItems.type, options.type) : undefined,
          or(
            liveSuggestion(nowDate()),
            and(
              eq(feedItems.type, "event"),
              sql`${feedItems.state}->>'status' = 'active'`,
            ),
          ),
        ),
      )
      .orderBy(
        sql`${desc(feedItems.priority)} NULLS LAST`,
        asc(feedItems.createdAt),
        asc(feedItems.id),
      )
      .limit(options.firstOnly ? 1 : limit + 1);
    signal.throwIfAborted();
    const page = rows.slice(0, limit);
    const items = page.map(({ card: row }) => {
      if (row.type === "event") {
        return platformEventSchema.parse({
          ...row,
          sourceType: "platform-event",
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          expiresAt: row.expiresAt?.toISOString() ?? null,
        });
      }
      return withSuggestionConsumeToken(
        owner,
        suggestionSchema.parse(suggestionRow(row)),
      );
    });
    const descriptions = await set(
      feedAutomationDescriptions$,
      items.flatMap((item) => {
        return item.type === "event" ? [item.content.workflowId] : [];
      }),
      signal,
    );
    signal.throwIfAborted();
    const cards = items.map((item) => {
      if (item.type !== "event") {
        return item;
      }
      const description = descriptions.get(item.content.workflowId)?.trim();
      return description
        ? {
            ...item,
            content: { ...item.content, automationDescription: description },
          }
        : item;
    });
    const tail = page.at(-1);
    const nextCursor =
      rows.length > limit && tail
        ? Buffer.from(
            JSON.stringify({
              priority: tail.card.priority,
              createdAt: tail.cursorTime,
              id: tail.card.id,
            }),
          ).toString("base64url")
        : undefined;
    return { items: cards, nextCursor };
  },
);

export const readFeedItems$ = command(
  async (
    { set },
    owner: Owner,
    query: { readonly type?: "suggestion" | "event"; readonly cursor?: string },
    signal: AbortSignal,
  ) => {
    const { type, cursor } = query;
    const after = cursor
      ? feedCursorSchema.safeParse(
          safeJsonParse(Buffer.from(cursor, "base64url").toString("utf8")),
        )
      : undefined;
    if (after && !after.success) {
      return badRequestMessage("Invalid feed cursor");
    }
    const [page, receipts] = await Promise.all([
      set(readActiveFeedCards$, owner, { type, after: after?.data }, signal),
      cursor || type === "event"
        ? []
        : set(recentSuggestionReceipts$, owner, signal),
    ]);
    signal.throwIfAborted();
    return { status: 200 as const, body: { ...page, receipts } };
  },
);
export const readSuggestionManagement$ = command(
  async (
    { get, set },
    owner: Owner,
    after: string | undefined,
    signal: AbortSignal,
  ) => {
    const rows = await get(db$)
      .select()
      .from(feedItems)
      .where(
        and(
          suggestionOwner(owner),
          liveSuggestion(nowDate()),
          after ? gt(feedItems.id, after) : undefined,
        ),
      )
      .orderBy(asc(feedItems.id))
      .limit(101);
    signal.throwIfAborted();
    const page = rows.slice(0, 100);
    const suggestions = page.map((row) => {
      return withSuggestionConsumeToken(
        owner,
        suggestionSchema.parse(suggestionRow(row)),
      );
    });
    const receipts = after
      ? []
      : await set(recentSuggestionReceipts$, owner, signal);
    return {
      status: 200 as const,
      body: {
        items: suggestions,
        receipts,
        nextAfter: rows.length > 100 ? (page.at(-1)?.id ?? null) : null,
      },
    };
  },
);
