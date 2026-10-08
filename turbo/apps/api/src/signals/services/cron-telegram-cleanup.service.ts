import { command } from "ccstate";
import { telegramMessages } from "@okouai/db/schema/telegram-message";
import { inArray, lt, sql } from "drizzle-orm";

import { pgTextDecoder } from "../../lib/db-structured-result";
import { nowDate } from "../../lib/time";
import { type Db, writeDb$ } from "../external/db";

const TELEGRAM_MESSAGE_RETENTION_DAYS = 30;
const TELEGRAM_MESSAGE_DELETE_BATCH_SIZE = 10_000;
const telegramMessageCtid = sql`ctid`.mapWith(pgTextDecoder);

function retentionCutoff(): Date {
  const cutoffDate = nowDate();
  cutoffDate.setUTCDate(
    cutoffDate.getUTCDate() - TELEGRAM_MESSAGE_RETENTION_DAYS,
  );
  return cutoffDate;
}

async function cleanupTelegramMessages(
  db: Db,
  cutoff: Date,
  batchSize: number,
  signal: AbortSignal,
): Promise<number> {
  const expiredWhere = lt(telegramMessages.createdAt, cutoff);

  let totalDeleted = 0;
  let batchDeleted: number;

  do {
    const expiredMessages = db
      .select({ ctid: telegramMessageCtid })
      .from(telegramMessages)
      .where(expiredWhere)
      .limit(batchSize);
    const { rowCount } = await db
      .delete(telegramMessages)
      .where(inArray(telegramMessageCtid, expiredMessages));
    signal.throwIfAborted();

    batchDeleted = rowCount ?? 0;
    totalDeleted += batchDeleted;
  } while (batchDeleted === batchSize);

  return totalDeleted;
}

export const cleanupTelegramMessages$ = command(
  async ({ set }, signal: AbortSignal): Promise<number> => {
    return await cleanupTelegramMessages(
      set(writeDb$),
      retentionCutoff(),
      TELEGRAM_MESSAGE_DELETE_BATCH_SIZE,
      signal,
    );
  },
);
