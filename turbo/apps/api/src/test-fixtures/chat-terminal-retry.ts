import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "../lib/db";

/**
 * Infrastructure exception: a real PostgreSQL error after a committed marker
 * cannot be induced by an HTTP caller. The one-shot sequence survives rollback;
 * only the test's run can hit the fault, and no service return value is mocked.
 */
export async function installTerminalCallbackFailureFixture(
  runId: string,
  boundary:
    | "delivery-registration"
    | "automation-admission"
    | "source-acknowledgement",
): Promise<() => Promise<void>> {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const sequenceName = `callback_fault_attempts_${suffix}`;
  const functionName = `fail_callback_once_${suffix}`;
  const triggerName = `callback_fault_${suffix}_${runId.replaceAll("-", "")}`;
  const predicate = {
    "delivery-registration": sql`NEW.internal_kind = 'slack:chat'`,
    // The admission receipt commits in the same transaction as the queued
    // automation input, so failing it rolls back the whole admission.
    "automation-admission": sql`NEW.internal_kind = 'chat' AND NEW.payload -> 'chatRunFinishedAutomationIds' IS NOT NULL`,
    "source-acknowledgement": sql`NEW.internal_kind = 'chat' AND NEW.status = 'delivered'`,
  }[boundary];
  await db().execute(sql`CREATE SEQUENCE ${sql.identifier(sequenceName)}`);
  await db().execute(sql`
    CREATE FUNCTION ${sql.identifier(functionName)}()
    RETURNS trigger LANGUAGE plpgsql AS $function$
    BEGIN
      IF replace(NEW.run_id::text, '-', '') = split_part(TG_NAME, '_', 4)
         AND ${predicate} THEN
        IF nextval(('callback_fault_attempts_' || split_part(TG_NAME, '_', 3))::regclass) = 1 THEN
          RAISE EXCEPTION 'forced terminal callback persistence failure';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $function$
  `);
  const operation =
    boundary === "delivery-registration" ? sql`INSERT` : sql`UPDATE`;
  await db().execute(sql`
    CREATE TRIGGER ${sql.identifier(triggerName)} BEFORE ${operation}
      ON agent_run_callbacks FOR EACH ROW
      EXECUTE FUNCTION ${sql.identifier(functionName)}()
  `);
  return async () => {
    await db().execute(sql`
      DROP TRIGGER ${sql.identifier(triggerName)} ON agent_run_callbacks
    `);
    await db().execute(sql`DROP FUNCTION ${sql.identifier(functionName)}()`);
    await db().execute(sql`DROP SEQUENCE ${sql.identifier(sequenceName)}`);
  };
}

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
