import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "../lib/db";

/**
 * Infrastructure exception: an older API's `slack:chat` payload shape cannot
 * be produced by the current writer. Rewrites only this run's delivery row as
 * it is inserted so the current dispatcher reads the retired `vm0` brand.
 */
export async function installLegacySlackChatCallbackBrandFixture(
  runId: string,
): Promise<() => Promise<void>> {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const functionName = `legacy_slack_brand_${suffix}`;
  const triggerName = `legacy_slack_brand_${runId.replaceAll("-", "")}`;
  await db().execute(sql`
    CREATE FUNCTION ${sql.identifier(functionName)}()
    RETURNS trigger LANGUAGE plpgsql AS $function$
    BEGIN
      IF replace(NEW.run_id::text, '-', '') = split_part(TG_NAME, '_', 4)
         AND NEW.internal_kind = 'slack:chat' THEN
        NEW.payload := NEW.payload || '{"publicBrand":"vm0"}'::jsonb;
      END IF;
      RETURN NEW;
    END;
    $function$
  `);
  await db().execute(sql`
    CREATE TRIGGER ${sql.identifier(triggerName)} BEFORE INSERT
      ON agent_run_callbacks FOR EACH ROW
      EXECUTE FUNCTION ${sql.identifier(functionName)}()
  `);
  return async () => {
    await db().execute(sql`
      DROP TRIGGER ${sql.identifier(triggerName)} ON agent_run_callbacks
    `);
    await db().execute(sql`DROP FUNCTION ${sql.identifier(functionName)}()`);
  };
}
