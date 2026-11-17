import { createHash } from "node:crypto";
import { command, computed, type Computed } from "ccstate";
import {
  and,
  desc,
  eq,
  gt,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import {
  featureGuideEditions,
  featureGuideReceipts,
  featureGuideRevisions,
} from "@okouai/db/schema/feature-guide";
import type { ImportFeatureGuide } from "@okouai/api-contracts/contracts/feature-guides";
import { featureGuideRevisionContentSchema } from "@okouai/db/jsonb-contracts/feature-guide";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";

interface FeatureGuideViewer {
  readonly orgId: string;
  readonly userId: string;
}

function featureGuideAudienceCondition(viewer: FeatureGuideViewer) {
  const audience = sql`${featureGuideRevisions.content}->'audience'`;
  return or(
    isNull(audience),
    sql`${audience}->'orgIds' @> ${JSON.stringify([viewer.orgId])}::jsonb`,
    sql`${audience}->'users' @> ${JSON.stringify([{ orgId: viewer.orgId, userId: viewer.userId }])}::jsonb`,
  );
}

export function currentFeatureGuide(viewer$: Computed<FeatureGuideViewer>) {
  return computed(async (get) => {
    const viewer = get(viewer$);
    const now = nowDate();
    const rows = await get(db$)
      .select({
        id: featureGuideEditions.id,
        revisionId: featureGuideRevisions.id,
        content: featureGuideRevisions.content,
      })
      .from(featureGuideEditions)
      .innerJoin(
        featureGuideRevisions,
        eq(featureGuideEditions.publishedRevisionId, featureGuideRevisions.id),
      )
      .where(
        and(
          isNotNull(featureGuideEditions.publishedAt),
          featureGuideAudienceCondition(viewer),
          lte(featureGuideRevisions.startsAt, now),
          or(
            isNull(featureGuideRevisions.expiresAt),
            gt(featureGuideRevisions.expiresAt, now),
          ),
        ),
      )
      .orderBy(
        desc(featureGuideEditions.publishedAt),
        desc(featureGuideEditions.id),
      )
      .limit(1);
    const row = rows[0];
    if (!row) {
      return null;
    }
    const { audience: _audience, ...content } =
      featureGuideRevisionContentSchema.parse(row.content);
    return { ...row, content };
  });
}

interface FeatureGuideReceiptIdentity {
  readonly userId: string;
  readonly editionId: string;
}

interface FeatureGuideRevisionIdentity {
  readonly editionId: string;
  readonly revisionId: string;
}

export function featureGuideReceipt(
  identity$: Computed<Promise<FeatureGuideReceiptIdentity | null>>,
) {
  return computed(async (get) => {
    const identity = await get(identity$);
    if (!identity) {
      return null;
    }
    const rows = await get(db$)
      .select({ seenAt: featureGuideReceipts.seenAt })
      .from(featureGuideReceipts)
      .where(
        and(
          eq(featureGuideReceipts.userId, identity.userId),
          eq(featureGuideReceipts.editionId, identity.editionId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  });
}

export function featureGuideRevision(
  identity$: Computed<Promise<FeatureGuideRevisionIdentity | null>>,
) {
  return computed(async (get) => {
    const identity = await get(identity$);
    if (!identity) {
      return null;
    }
    const rows = await get(db$)
      .select({ id: featureGuideRevisions.id })
      .from(featureGuideRevisions)
      .where(
        and(
          eq(featureGuideRevisions.editionId, identity.editionId),
          eq(featureGuideRevisions.id, identity.revisionId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  });
}

export function acknowledgeableFeatureGuideRevision(
  identity$: Computed<
    Promise<(FeatureGuideRevisionIdentity & FeatureGuideViewer) | null>
  >,
) {
  return computed(async (get) => {
    const identity = await get(identity$);
    if (!identity) {
      return null;
    }
    const rows = await get(db$)
      .select({ id: featureGuideRevisions.id })
      .from(featureGuideRevisions)
      .innerJoin(
        featureGuideEditions,
        eq(featureGuideRevisions.editionId, featureGuideEditions.id),
      )
      .where(
        and(
          eq(featureGuideRevisions.editionId, identity.editionId),
          eq(featureGuideRevisions.id, identity.revisionId),
          isNotNull(featureGuideEditions.publishedRevisionId),
          featureGuideAudienceCondition(identity),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  });
}

export const markFeatureGuideSeen$ = command(
  async (
    { set },
    userId: string,
    editionId: string,
    revisionId: string,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    await set(writeDb$)
      .insert(featureGuideReceipts)
      .values({ userId, editionId, revisionId, seenAt: nowDate() })
      .onConflictDoNothing({
        target: [featureGuideReceipts.userId, featureGuideReceipts.editionId],
      });
    signal.throwIfAborted();
  },
);

export const importFeatureGuide$ = command(
  async (
    { set },
    input: ImportFeatureGuide,
    createdBy: string,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    await set(writeDb$)
      .insert(featureGuideEditions)
      .values({ id: input.editionId })
      .onConflictDoNothing();
    signal.throwIfAborted();
    const content = featureGuideRevisionContentSchema.parse({
      ...input.content,
      ...(input.audience ? { audience: input.audience } : {}),
    });
    const startsAt = new Date(input.startsAt);
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    const contentHash = createHash("sha256")
      .update(
        JSON.stringify({
          editionId: input.editionId,
          content,
          startsAt: startsAt.toISOString(),
          expiresAt: expiresAt?.toISOString() ?? null,
        }),
      )
      .digest("hex");
    const rows = await set(writeDb$)
      .insert(featureGuideRevisions)
      .values({
        editionId: input.editionId,
        content,
        contentHash,
        startsAt,
        expiresAt,
        createdBy,
      })
      .onConflictDoUpdate({
        target: [
          featureGuideRevisions.editionId,
          featureGuideRevisions.contentHash,
        ],
        set: { contentHash },
      })
      .returning({ revisionId: featureGuideRevisions.id });
    signal.throwIfAborted();
    const row = rows[0];
    if (!row) {
      throw new Error("Feature guide import did not return a revision");
    }
    return { editionId: input.editionId, revisionId: row.revisionId };
  },
);

export const publishFeatureGuide$ = command(
  async (
    { set },
    editionId: string,
    revisionId: string | null,
    publishedBy: string,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const rows = await set(writeDb$)
      .update(featureGuideEditions)
      .set({
        publishedRevisionId: revisionId,
        publishedAt: revisionId
          ? sql`case when ${eq(featureGuideEditions.publishedRevisionId, revisionId)} then ${featureGuideEditions.publishedAt} else ${sql.param(nowDate(), featureGuideEditions.publishedAt)} end`
          : null,
        publishedBy,
      })
      .where(eq(featureGuideEditions.id, editionId))
      .returning({ id: featureGuideEditions.id });
    signal.throwIfAborted();
    return rows.length > 0;
  },
);

export const deleteFeatureGuideReceipts$ = command(
  async ({ set }, userId: string, signal: AbortSignal) => {
    signal.throwIfAborted();
    await set(writeDb$)
      .delete(featureGuideReceipts)
      .where(eq(featureGuideReceipts.userId, userId));
    signal.throwIfAborted();
  },
);
