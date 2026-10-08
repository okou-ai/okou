import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "../lib/db";

/**
 * Infrastructure exception: a Telegram webhook cannot request a storage fault.
 * Fail the real required context INSERT for only this test's chat; setup,
 * admission, launch, file access, and delivery assertions still use production
 * APIs.
 */
export async function installTelegramContextFailureFixture(
  chatId: number,
): Promise<() => Promise<void>> {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const functionName = `fail_telegram_context_${suffix}`;
  const triggerName = `tg_context_${suffix}_${chatId}`;
  await db().execute(sql`
    CREATE FUNCTION ${sql.identifier(functionName)}()
    RETURNS trigger LANGUAGE plpgsql AS $function$
    BEGIN
      IF NEW.chat_id = split_part(TG_NAME, '_', 4) THEN
        RAISE EXCEPTION 'forced Telegram context storage failure';
      END IF;
      RETURN NEW;
    END;
    $function$
  `);
  await db().execute(sql`
    CREATE TRIGGER ${sql.identifier(triggerName)} BEFORE INSERT
      ON chat_telegram_context FOR EACH ROW
      EXECUTE FUNCTION ${sql.identifier(functionName)}()
  `);
  return async () => {
    await db().execute(sql`
      DROP TRIGGER ${sql.identifier(triggerName)} ON chat_telegram_context
    `);
    await db().execute(sql`DROP FUNCTION ${sql.identifier(functionName)}()`);
  };
}
