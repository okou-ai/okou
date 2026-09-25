import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "pg";
import { sql } from "drizzle-orm";

import { closeDbPool, db } from "../lib/db";
import { env, mockEnv, optionalEnv } from "../lib/env";
import { flushWaitUntilForTest } from "../signals/context/wait-until";
import { settleIncludingAbort } from "../signals/utils";
import { installApiTestConnectorCatalog } from "./connector-catalog";

/**
 * Infrastructure exception: operator activation is not a user API. Own a fully
 * migrated database so this global switch never changes another test's mode.
 * Application setup and assertions inside work still use production endpoints.
 */
export async function withSplitChatEventDatabase(
  work: () => Promise<void>,
  options: { readonly contracted?: boolean } = {},
): Promise<void> {
  const originalUrl = env("DATABASE_URL");
  const url = new URL(originalUrl);
  if (!["localhost", "127.0.0.1", "postgres"].includes(url.hostname)) {
    throw new Error("Chat terminal retry fixtures require local PostgreSQL");
  }
  const name = `chat_terminal_retry_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: originalUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  url.pathname = `/${name}`;
  const packageDir = fileURLToPath(
    new URL("../../../../packages/db", import.meta.url),
  );
  const result = await settleIncludingAbort(
    (async () => {
      await promisify(execFile)(
        "node",
        [
          fileURLToPath(import.meta.resolve("tsx/cli")),
          join(packageDir, "scripts/migrate.ts"),
        ],
        {
          cwd: packageDir,
          env: {
            PATH: optionalEnv("PATH"),
            HOME: optionalEnv("HOME"),
            DATABASE_URL: url.toString(),
          },
          timeout: 120_000,
          maxBuffer: 20 * 1024 * 1024,
        },
      );
      await closeDbPool();
      mockEnv("DATABASE_URL", url.toString());
      await installApiTestConnectorCatalog();
      await db().execute(sql`
        UPDATE chat_event_write_control SET activated_at = now() WHERE id = 'global'
      `);
      if (options.contracted) {
        // The separately authorized Release 2 DDL is exercised only in this
        // disposable database. Preparation API code must remain usable in its
        // fixed active mode after the legacy allocator has been removed.
        await db().execute(sql`
          DROP TRIGGER bridge_chat_event_sequence_allocation ON chat_threads;
          DROP FUNCTION bridge_chat_event_sequence_allocation();
          ALTER TABLE chat_threads DROP COLUMN last_chat_event_seq_id
        `);
      }
      await work();
    })(),
  );
  const flushed = await settleIncludingAbort(flushWaitUntilForTest());
  const closed = await settleIncludingAbort(closeDbPool());
  mockEnv("DATABASE_URL", originalUrl);
  const dropped = await settleIncludingAbort(
    admin.query(`DROP DATABASE "${name}" WITH (FORCE)`),
  );
  const ended = await settleIncludingAbort(admin.end());
  for (const outcome of [result, flushed, closed, dropped, ended]) {
    if (!outcome.ok) {
      throw outcome.error;
    }
  }
}

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
