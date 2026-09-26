import { randomUUID } from "node:crypto";

import { sql, type SQL } from "drizzle-orm";

import { db } from "../lib/db";

function triggerFunctionName(kind: string): string {
  return `test_email_outbox_${kind}_${randomUUID().replaceAll("-", "")}`;
}

async function installEmailOutboxTrigger(
  itemId: string,
  functionName: string,
  createFunction: SQL,
  signal: AbortSignal,
  timing: "before" | "after" = "before",
): Promise<() => Promise<void>> {
  const event = timing === "after" ? sql`AFTER UPDATE` : sql`BEFORE UPDATE`;
  await db().transaction(async (tx) => {
    await tx.execute(createFunction);
    signal.throwIfAborted();
    await tx.execute(sql`
      CREATE TRIGGER ${sql.identifier(itemId)} ${event} ON email_outbox
      FOR EACH ROW EXECUTE FUNCTION ${sql.identifier(functionName)}()
    `);
    signal.throwIfAborted();
  });

  let dropped = false;
  return async () => {
    if (dropped) {
      return;
    }
    dropped = true;
    await db().transaction(async (tx) => {
      await tx.execute(
        sql`DROP TRIGGER ${sql.identifier(itemId)} ON email_outbox`,
      );
      await tx.execute(sql`DROP FUNCTION ${sql.identifier(functionName)}()`);
    });
  };
}

/**
 * Fail one row's delivery completion after the provider has already accepted
 * its request, leaving the committed request and key behind exactly as a worker
 * that lost its database connection would.
 */
export async function rejectEmailOutboxCompletion(
  itemId: string,
  signal: AbortSignal,
): Promise<() => Promise<void>> {
  const functionName = triggerFunctionName("completion");
  return await installEmailOutboxTrigger(
    itemId,
    functionName,
    sql`
      CREATE FUNCTION ${sql.identifier(functionName)}() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id::text = TG_NAME AND NEW.status = 'sent' THEN
          RAISE EXCEPTION 'Test email outbox completion write failed'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$
    `,
    signal,
  );
}
