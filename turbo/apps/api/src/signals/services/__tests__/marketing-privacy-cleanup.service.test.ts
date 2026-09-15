import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { expect, test, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { env } from "../../../lib/env";
import { settle } from "../../utils";
import { cleanupRetainedMarketingPrivacy } from "../marketing-privacy-cleanup.service";

const context = testContext();

// Schema contraction and historical consent cannot be constructed by current
// product routes. These cases own private schemas; webhook route tests cover
// the actual user-deletion contract in retained and contracted databases.
async function harness(retained = true) {
  const name = `privacy_cleanup_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: env("DATABASE_URL"), max: 1 });
  const connection = new URL(env("DATABASE_URL"));
  connection.searchParams.set("application_name", name);
  const pool = new Pool({
    connectionString: connection.toString(),
    max: 3,
    options: `-c search_path=${name} -c statement_timeout=10000`,
  });
  onTestFinished(async () => {
    const results = [
      await settle(pool.end()),
      await settle(admin.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`)),
      await settle(admin.end()),
    ];
    for (const result of results) {
      if (!result.ok) {
        throw result.error;
      }
    }
  });
  await admin.query(`CREATE SCHEMA "${name}"`);
  if (retained) {
    for (const file of [
      "1108_privacy_choices",
      "1109_marketing_privacy_receipts",
      "1110_invalidate_marketing_privacy_epochs",
    ]) {
      const migration = await readFile(
        new URL(
          `../../../../../../packages/db/src/migrations/${file}.sql`,
          import.meta.url,
        ),
        "utf8",
      );
      await pool.query(migration.replaceAll('"public".', `"${name}".`));
    }
    await pool.query(`
      INSERT INTO privacy_choices (user_id, token_hash, linked_user_id,
        policy_version, source, sale_sharing, advertising, marketing_analytics)
      VALUES ('deleted-person', NULL, NULL, 'retired-policy', 'explicit', 'granted', 'granted', 'granted'),
        (NULL, 'linked-browser-hash', 'deleted-person', 'retired-policy', 'gpc', 'denied', 'denied', 'denied'),
        ('other-person', NULL, NULL, 'retired-policy', 'explicit', 'granted', 'granted', 'granted');
      INSERT INTO privacy_choice_revisions (revision, subject_id, sale_sharing,
        advertising, marketing_analytics, source, policy_version, recorded_at)
      SELECT revision, id, sale_sharing, advertising, marketing_analytics, source,
        policy_version, created_at FROM privacy_choices;
      INSERT INTO marketing_privacy_receipts (subject_id, privacy_revision,
        advertising_epoch, marketing_analytics_epoch, policy_version, captured_at)
      SELECT id, revision, advertising_epoch, marketing_analytics_epoch,
        policy_version, created_at FROM privacy_choices;
    `);
  }
  return { pool, admin, name, db: drizzle(pool) };
}

async function retainedRows(pool: Pool) {
  const result = [];
  for (const table of [
    "privacy_choices",
    "privacy_choice_revisions",
    "marketing_privacy_receipts",
  ]) {
    result.push(
      (
        await pool.query(
          `SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`,
        )
      ).rows,
    );
  }
  return result;
}

test("deletes personal and linked browser evidence, preserves other people, and supports retries", async () => {
  const { pool, db } = await harness();
  await cleanupRetainedMarketingPrivacy(db, "deleted-person", context.signal);
  const once = await retainedRows(pool);
  expect(
    once.map((rows) => {
      return rows.length;
    }),
  ).toStrictEqual([1, 1, 1]);
  expect(
    (await pool.query("SELECT user_id FROM privacy_choices")).rows,
  ).toStrictEqual([{ user_id: "other-person" }]);
  await cleanupRetainedMarketingPrivacy(db, "deleted-person", context.signal);
  await expect(retainedRows(pool)).resolves.toStrictEqual(once);
});

test("completes repeated account cleanup after all privacy storage is absent", async () => {
  const { db } = await harness(false);
  await expect(
    cleanupRetainedMarketingPrivacy(db, "deleted-person", context.signal),
  ).resolves.toBeUndefined();
  await expect(
    cleanupRetainedMarketingPrivacy(db, "deleted-person", context.signal),
  ).resolves.toBeUndefined();
});

test("rejects partial schema loss without deleting retained evidence", async () => {
  const { pool, db } = await harness();
  await pool.query("DROP TABLE marketing_privacy_receipts");
  await expect(
    cleanupRetainedMarketingPrivacy(db, "deleted-person", context.signal),
  ).rejects.toThrow("only partially retired");
  expect(
    (await pool.query("SELECT count(*)::int AS n FROM privacy_choices")).rows,
  ).toStrictEqual([{ n: 3 }]);
});

test.each(["COMMIT", "ROLLBACK"])(
  "reads the final schema after a concurrent drop %s",
  async (end) => {
    const { pool, admin, name, db } = await harness();
    const migration = await pool.connect();
    let cleanup: Promise<void> | undefined;
    const execution = await settle(
      (async () => {
        await migration.query("BEGIN");
        await migration.query(
          "SELECT pg_advisory_xact_lock(hashtext('marketing_privacy_storage_retirement'))",
        );
        cleanup = cleanupRetainedMarketingPrivacy(
          db,
          "deleted-person",
          context.signal,
        );
        await expect
          .poll(async () => {
            return (
              await admin.query(
                "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1 AND wait_event = 'advisory'",
                [name],
              )
            ).rows[0]?.n;
          })
          .toBe(1);
        await migration.query(`DROP TABLE marketing_privacy_receipts;
      DROP TABLE privacy_choice_revisions;
      DROP TABLE privacy_choices;
      DROP FUNCTION invalidate_marketing_privacy_epochs()`);
        await migration.query(end);
        await cleanup;
        if (end === "ROLLBACK") {
          expect(
            (await retainedRows(pool)).map((rows) => {
              return rows.length;
            }),
          ).toStrictEqual([1, 1, 1]);
        } else {
          expect(
            (
              await pool.query(
                "SELECT to_regclass('privacy_choices') AS relation",
              )
            ).rows,
          ).toStrictEqual([{ relation: null }]);
        }
      })(),
    );
    const rollback = await settle(migration.query("ROLLBACK"));
    migration.release();
    const completed = await settle(cleanup ?? Promise.resolve());
    for (const result of [execution, rollback, completed]) {
      if (!result.ok) {
        throw result.error;
      }
    }
  },
);

test("propagates a real delete failure and rolls back companion deletion", async () => {
  const { pool, db } = await harness();
  await pool.query(`CREATE TABLE deletion_blocker (subject_id uuid REFERENCES privacy_choices(id));
    INSERT INTO deletion_blocker SELECT id FROM privacy_choices WHERE token_hash IS NOT NULL`);
  const before = await retainedRows(pool);
  await expect(
    cleanupRetainedMarketingPrivacy(db, "deleted-person", context.signal),
  ).rejects.toMatchObject({ cause: { code: "23503" } });
  await expect(retainedRows(pool)).resolves.toStrictEqual(before);
  await pool.query("DROP TABLE deletion_blocker");
  await cleanupRetainedMarketingPrivacy(db, "deleted-person", context.signal);
  expect(
    (await retainedRows(pool)).map((rows) => {
      return rows.length;
    }),
  ).toStrictEqual([1, 1, 1]);
});
