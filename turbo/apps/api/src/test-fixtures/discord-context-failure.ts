import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "../lib/db";

/**
 * Infrastructure exception: a Gateway caller cannot request a storage fault.
 * Fail the real context INSERT for only this test's Discord message; admission,
 * recovery, canonical history, Run state, and delivery use production APIs.
 */
export async function installDiscordContextFailureFixture(
  messageId: string,
): Promise<() => Promise<void>> {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const functionName = `fail_discord_context_${suffix}`;
  const triggerName = `discord_context_${suffix}_${messageId}`;
  await db().execute(sql`
    CREATE FUNCTION ${sql.identifier(functionName)}()
    RETURNS trigger LANGUAGE plpgsql AS $function$
    BEGIN
      IF NEW.message_id = split_part(TG_NAME, '_', 4) THEN
        RAISE EXCEPTION 'forced Discord context serialization failure'
          USING ERRCODE = '40001';
      END IF;
      RETURN NEW;
    END;
    $function$
  `);
  await db().execute(sql`
    CREATE TRIGGER ${sql.identifier(triggerName)} BEFORE INSERT
      ON chat_discord_context FOR EACH ROW
      EXECUTE FUNCTION ${sql.identifier(functionName)}()
  `);
  return async () => {
    await db().execute(sql`
      DROP TRIGGER ${sql.identifier(triggerName)} ON chat_discord_context
    `);
    await db().execute(sql`DROP FUNCTION ${sql.identifier(functionName)}()`);
  };
}
