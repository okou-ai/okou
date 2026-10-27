import {
  halloweenOperationsContract,
  type HalloweenParticipant,
} from "@okouai/api-contracts/contracts/halloween";
import { isStaffOrg } from "@okouai/core/staff-org";
import {
  halloweenBatches,
  halloweenReviews,
  halloweenRounds,
} from "@okouai/db/schema/halloween";
import { halloweenSnapshotSchema } from "@okouai/db/jsonb-contracts/halloween";
import { command } from "ccstate";
import { and, asc, eq, isNull, lte } from "drizzle-orm";
import { conflict, notFound } from "../../lib/error";
import { nowDate } from "../../lib/time";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { writeDb$, db$ } from "../external/db";
import type { RouteEntry } from "../route-entry";

const forbidden = () => {
  return {
    status: 403 as const,
    body: {
      error: {
        code: "FORBIDDEN",
        message:
          "This operation is available to Okou staff administrators only",
      },
    },
  };
};
const allowed = (auth: { orgId: string; orgRole?: string }) => {
  return isStaffOrg(auth.orgId) && auth.orgRole === "admin";
};
const batchReceipt = (row: typeof halloweenBatches.$inferSelect) => {
  return {
    status: 200 as const,
    body: {
      id: row.id,
      capturedAt: row.capturedAt.toISOString(),
      participants: halloweenSnapshotSchema.parse(row.participants),
    },
  };
};

const capture$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (!allowed(auth)) {
    return forbidden();
  }
  const body = await get(bodyResultOf(halloweenOperationsContract.capture));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const db = set(writeDb$);
  const [existing] = await db
    .select()
    .from(halloweenBatches)
    .where(eq(halloweenBatches.id, body.data.id));
  signal.throwIfAborted();
  if (existing) {
    return batchReceipt(existing);
  }
  const at = nowDate();
  const rows = await db
    .select({
      id: halloweenRounds.id,
      userId: halloweenRounds.userId,
      orgId: halloweenRounds.orgId,
      email: halloweenRounds.email,
      outcome: halloweenRounds.outcome,
      startedAt: halloweenRounds.startedAt,
      completedAt: halloweenRounds.completedAt,
      decision: halloweenReviews.decision,
      notifiedAt: halloweenReviews.notifiedAt,
      rewardedAt: halloweenReviews.rewardedAt,
    })
    .from(halloweenRounds)
    .leftJoin(
      halloweenReviews,
      eq(halloweenReviews.userId, halloweenRounds.userId),
    )
    .where(lte(halloweenRounds.startedAt, at))
    .orderBy(asc(halloweenRounds.startedAt));
  signal.throwIfAborted();
  const participants = new Map<string, HalloweenParticipant>();
  for (const row of rows) {
    if (row.outcome === "playing") {
      continue;
    }
    let participant = participants.get(row.userId);
    if (!participant) {
      participant = {
        userId: row.userId,
        orgId: row.orgId,
        email: row.email,
        firstPlayedAt: row.startedAt.toISOString(),
        lastPlayedAt: row.startedAt.toISOString(),
        rounds: [],
        decision: row.decision ?? "pending",
        notifiedAt: row.notifiedAt?.toISOString() ?? null,
        rewardedAt: row.rewardedAt?.toISOString() ?? null,
      };
      participants.set(row.userId, participant);
    }
    participant.lastPlayedAt = row.startedAt.toISOString();
    participant.rounds.push({
      id: row.id,
      outcome: row.outcome,
      startedAt: row.startedAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
    });
  }
  await db
    .insert(halloweenBatches)
    .values({
      id: body.data.id,
      capturedAt: at,
      capturedBy: auth.userId,
      participants: [...participants.values()],
    })
    .onConflictDoNothing();
  signal.throwIfAborted();
  const [saved] = await db
    .select()
    .from(halloweenBatches)
    .where(eq(halloweenBatches.id, body.data.id));
  signal.throwIfAborted();
  return saved ? batchReceipt(saved) : notFound("Participant batch not found");
});

const readBatch$ = command(async ({ get }, signal: AbortSignal) => {
  if (!allowed(get(organizationAuthContext$))) {
    return forbidden();
  }
  const { id } = get(pathParamsOf(halloweenOperationsContract.batch));
  const db = get(db$);
  const [row] = await db
    .select()
    .from(halloweenBatches)
    .where(eq(halloweenBatches.id, id));
  signal.throwIfAborted();
  return row ? batchReceipt(row) : notFound("Participant batch not found");
});

const review$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (!allowed(auth)) {
    return forbidden();
  }
  const body = await get(bodyResultOf(halloweenOperationsContract.review));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const db = set(writeDb$);
  const [batch] = await db
    .select()
    .from(halloweenBatches)
    .where(eq(halloweenBatches.id, body.data.batchId));
  signal.throwIfAborted();
  if (
    !batch ||
    !halloweenSnapshotSchema.parse(batch.participants).some((p) => {
      return p.userId === body.data.userId;
    })
  ) {
    return notFound("Account is not included in this participant batch");
  }
  const values = {
    ...body.data,
    reviewedBy: auth.userId,
    reviewedAt: nowDate(),
  };
  const saved = await db
    .insert(halloweenReviews)
    .values(values)
    .onConflictDoUpdate({
      target: halloweenReviews.userId,
      set: values,
      setWhere: and(
        isNull(halloweenReviews.notifiedAt),
        isNull(halloweenReviews.rewardedAt),
      ),
    })
    .returning({ userId: halloweenReviews.userId });
  signal.throwIfAborted();
  if (!saved.length) {
    return conflict("This account already has a final result for this event");
  }
  return { status: 200 as const, body: { saved: true as const } };
});

const auth = { requireOrganization: true, accept: ["session", "pat"] } as const;
export const halloweenOperationsRoutes: readonly RouteEntry[] = [
  {
    route: halloweenOperationsContract.capture,
    handler: authRoute(auth, capture$),
  },
  {
    route: halloweenOperationsContract.batch,
    handler: authRoute(auth, readBatch$),
  },
  {
    route: halloweenOperationsContract.review,
    handler: authRoute(auth, review$),
  },
];
