import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { command } from "ccstate";
import { and, asc, eq, gt } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import {
  expiryPageAfter,
  expiryPrefixForAmount,
  expiryPrefixSelection,
  type PreparedUsageExpiryLot,
  type PreparedUsageExpiryPrefix,
} from "./usage-expiry-prefix";

export const prepareUsageExpiryPrefix$ = command(
  async (
    { set },
    args: { readonly orgId: string; readonly gross: number },
    signal: AbortSignal,
  ): Promise<PreparedUsageExpiryPrefix> => {
    const db = set(writeDb$);
    const at = nowDate();
    const lots: PreparedUsageExpiryLot[] = [];
    let remaining = args.gross;
    let cursor: PreparedUsageExpiryLot | undefined;
    while (remaining > 0) {
      const page = await db
        .select(expiryPrefixSelection())
        .from(creditExpiresRecord)
        .where(
          and(
            eq(creditExpiresRecord.orgId, args.orgId),
            gt(creditExpiresRecord.remaining, 0),
            gt(creditExpiresRecord.expiresAt, at),
            expiryPageAfter(cursor),
          ),
        )
        .orderBy(
          asc(creditExpiresRecord.expiresAt),
          asc(creditExpiresRecord.id),
        )
        .limit(128);
      signal.throwIfAborted();
      const prefix = expiryPrefixForAmount(page, remaining);
      lots.push(...prefix.lots);
      remaining = prefix.remaining;
      cursor = page.at(-1);
      if (page.length < 128) {
        break;
      }
    }
    return { lots };
  },
);
