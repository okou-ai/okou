import {
  suggestionStatus,
  liveSuggestion,
  suggestionRow,
} from "./agent-suggestions-lifecycle";
import { command } from "ccstate";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { agents } from "@okouai/db/schema/agent";
import { feedItems } from "@okouai/db/schema/feed-item";
import { workflows } from "@okouai/db/schema/workflow";
import {
  officialWorkflowCatalogReleases,
  officialWorkflowCatalogState,
  officialWorkflowDefinitionRevisions,
} from "@okouai/db/schema/official-workflow-catalog";
import {
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
import { nowDate } from "../../lib/time";
import { withSuggestionConsumeToken } from "./agent-suggestion-consumption-token";
import { visibleWorkflowCondition } from "./workflow-data.service";
import {
  acceptedCatalogDefinitionRevision,
  acceptedOfficialWorkflowCatalogReadPlan,
} from "./official-workflow-catalog-read.service";

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
type StoredSuggestion = ReturnType<typeof suggestionRow>;
/**
 * Reads several owned suggestions in one statement, keyed by each requested
 * id; absent ids map to null. PostgreSQL compares hyphenated UUID text
 * case-insensitively and returns stored ids in lowercase.
 */
export const storedSuggestions$ = command(
  async (
    { get },
    owner: Owner,
    ids: readonly string[],
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, StoredSuggestion | null>> => {
    const canonicalIds = [
      ...new Set(
        ids.map((id) => {
          return id.toLowerCase();
        }),
      ),
    ];
    if (canonicalIds.length === 0) {
      return new Map<string, StoredSuggestion | null>();
    }
    const rows = await get(db$)
      .select()
      .from(feedItems)
      .where(and(suggestionOwner(owner), inArray(feedItems.id, canonicalIds)));
    signal.throwIfAborted();
    const stored = new Map(
      rows.map((row) => {
        return [row.id, suggestionRow(row)] as const;
      }),
    );
    return new Map(
      ids.map((id) => {
        return [id, stored.get(id.toLowerCase()) ?? null] as const;
      }),
    );
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
        description: sql`coalesce(
          ${officialWorkflowDefinitionRevisions.payload}->'workflow'->>'description',
          ${workflows.description}
        )`.mapWith(nullableDriverValueDecoder(pgTextDecoder)),
      })
      .from(workflows)
      .innerJoin(agents, eq(agents.id, workflows.agentId))
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
          visibleWorkflowCondition({
            userId: auth.userId,
            role: auth.orgRole ?? "member",
          }),
        ),
      );
    signal.throwIfAborted();
    return new Map(
      rows.map(({ id, description }) => {
        return [id, description] as const;
      }),
    );
  },
);

export const readFeedItems$ = command(
  async (
    { get, set },
    owner: Owner,
    type: "suggestion" | "event" | undefined,
    signal: AbortSignal,
  ) => {
    const rows = await get(db$)
      .select()
      .from(feedItems)
      .where(
        and(
          eq(feedItems.orgId, owner.orgId),
          eq(feedItems.userId, owner.userId),
          type ? eq(feedItems.type, type) : undefined,
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
      .limit(10);
    signal.throwIfAborted();
    const items = rows.map((row) => {
      if (row.type === "event") {
        return platformEventSchema.parse({
          ...row,
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
    const [receipts, descriptions] = await Promise.all([
      type === "event" ? [] : set(recentSuggestionReceipts$, owner, signal),
      set(
        feedAutomationDescriptions$,
        items.flatMap((item) => {
          return item.type === "event" ? [item.content.workflowId] : [];
        }),
        signal,
      ),
    ]);
    const describedItems = items.map((item) => {
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
    return { status: 200 as const, body: { items: describedItems, receipts } };
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
