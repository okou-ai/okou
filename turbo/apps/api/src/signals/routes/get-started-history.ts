import { getStartedHistoryContract } from "@okouai/api-contracts/contracts/get-started-history";
import { getStartedClaims } from "@okouai/db/schema/get-started-claim";
import { command } from "ccstate";
import { asc, gt } from "drizzle-orm";
import { timingSafeEqual } from "node:crypto";
import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { authorization$, setResHeader$ } from "../context/hono";
import { queryOf } from "../context/request";
import { db$ } from "../external/db";
import type { RouteEntry } from "../route-entry";

const exportHistory$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const secret = env("MARKETING_REWARDS_EXPORT_SECRET");
  if (!secret) {
    return {
      status: 503 as const,
      body: {
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "Reward history export is not configured",
        },
      },
    };
  }
  const supplied = Buffer.from(get(authorization$) ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    return {
      status: 401 as const,
      body: {
        error: {
          code: "UNAUTHORIZED",
          message: "Invalid reward history credential",
        },
      },
    };
  }
  const query = get(queryOf(getStartedHistoryContract.export));
  // Immutable-ID pagination is a full scan, not an incremental watermark.
  // Repeat and reconcile after the source writer drain before changing owners.
  const rows = await get(db$)
    .select()
    .from(getStartedClaims)
    .where(query.after ? gt(getStartedClaims.id, query.after) : undefined)
    .orderBy(asc(getStartedClaims.id))
    .limit(query.limit + 1);
  signal.throwIfAborted();
  const page = rows.slice(0, query.limit);
  return {
    status: 200 as const,
    body: {
      version: 1 as const,
      environment: env("ENV"),
      exportedAt: nowDate().toISOString(),
      // Worker leases remain with the source owner; copying a receipt never
      // transfers processing authority or creates a new credit grant.
      records: page.map(
        ({ leaseId: _leaseId, leaseExpiresAt: _leaseExpiresAt, ...row }) => {
          return {
            ...row,
            nextAttemptAt: row.nextAttemptAt.toISOString(),
            completedAt: row.completedAt?.toISOString() ?? null,
            reviewedAt: row.reviewedAt?.toISOString() ?? null,
            grantedAt: row.grantedAt?.toISOString() ?? null,
            expiresAt: row.expiresAt?.toISOString() ?? null,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
          };
        },
      ),
      nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    },
  };
});

export const getStartedHistoryRoutes: readonly RouteEntry[] = [
  { route: getStartedHistoryContract.export, handler: exportHistory$ },
];
