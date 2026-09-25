import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "../lib/db";

/**
 * Infrastructure exception: no runner request can force delivery registration
 * to fail after its terminal marker commits. This real PostgreSQL fault is
 * restricted to the test-owned chat; requests and assertions use public APIs.
 */
export async function installDiscordDeliveryRegistrationFailureFixture(
  chatThreadId: string,
): Promise<() => Promise<void>> {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const functionName = `fail_discord_delivery_${suffix}`;
  const triggerName = `discord_delivery_${suffix}_${chatThreadId.replaceAll("-", "")}`;
  await db().execute(sql`
    CREATE FUNCTION ${sql.identifier(functionName)}()
    RETURNS trigger LANGUAGE plpgsql AS $function$
    BEGIN
      IF replace(NEW.chat_thread_id::text, '-', '') = split_part(TG_NAME, '_', 4) THEN
        RAISE EXCEPTION 'forced Discord delivery registration failure';
      END IF;
      RETURN NEW;
    END;
    $function$
  `);
  await db().execute(sql`
    CREATE TRIGGER ${sql.identifier(triggerName)} BEFORE INSERT
      ON discord_chat_deliveries FOR EACH ROW
      EXECUTE FUNCTION ${sql.identifier(functionName)}()
  `);
  return async () => {
    await db().execute(sql`
      DROP TRIGGER ${sql.identifier(triggerName)} ON discord_chat_deliveries
    `);
    await db().execute(sql`DROP FUNCTION ${sql.identifier(functionName)}()`);
  };
}
