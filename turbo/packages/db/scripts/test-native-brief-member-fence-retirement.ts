import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import postgres from "postgres";
import { z } from "zod";

import { DRIZZLE_MIGRATE_OUT } from "../drizzle.config";
import { schema } from "../src/index";
import { orgMembersMetadata } from "../src/runtime/org-members-metadata";
import { applyPendingMigrations } from "./migration-runner";
import { validateMemberMetadataRuntimePreparation } from "./test-member-metadata-runtime-preparation";

const journal = z
  .object({ entries: z.array(z.object({ tag: z.string(), when: z.number() })) })
  .parse(
    JSON.parse(
      await readFile(`${DRIZZLE_MIGRATE_OUT}/meta/_journal.json`, "utf8"),
    ),
  );
const contraction = journal.entries.find((entry) => {
  return entry.tag.endsWith("_drop_native_morning_brief_member_fence");
});
assert.ok(contraction, "Retain the validator through production contraction");
const databaseUrl = process.env.DATABASE_URL;
assert.ok(
  databaseUrl,
  "DATABASE_URL is required for an owned disposable database",
);
const adminUrl = new URL(databaseUrl);
adminUrl.pathname = "/postgres";
const databaseName = `native_member_fence_${randomUUID().replaceAll("-", "")}`;
const ownedUrl = new URL(adminUrl);
ownedUrl.pathname = `/${databaseName}`;
const admin = new Client({ connectionString: adminUrl.toString() });
await admin.connect();
await admin.query(`CREATE DATABASE "${databaseName}"`);
const migrationSql = postgres(ownedUrl.toString(), {
  max: 1,
  onnotice: () => {},
});
const client = new Client({ connectionString: ownedUrl.toString() });
const db = drizzle(client, { schema });
const journalRows = z.array(
  z.object({ id: z.number(), hash: z.string(), created_at: z.string() }),
);
const existsRows = z.array(z.object({ exists: z.boolean() })).length(1);

async function columnExists() {
  const result = await client.query(`
    SELECT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute
      WHERE attrelid = 'public.org_members_metadata'::regclass
        AND attname = 'morning_brief_collection_revoked_at' AND NOT attisdropped
    ) AS exists
  `);
  return existsRows.parse(result.rows)[0]?.exists;
}

async function migrationJournal() {
  return journalRows.parse(
    (
      await client.query(
        "SELECT * FROM drizzle.__drizzle_migrations ORDER BY id",
      )
    ).rows,
  );
}

try {
  await client.connect();
  await applyPendingMigrations(migrationSql, {
    beforeMillis: contraction.when,
  });
  await db.insert(orgMembersMetadata).values({
    orgId: "native-fence-org",
    userId: "native-fence-member",
    timezone: "Asia/Shanghai",
    locale: "zh-Hans",
    theme: "dark",
    onboardingDone: true,
  });
  await client.query(`
    UPDATE public.org_members_metadata
    SET morning_brief_collection_revoked_at = '2026-03-10T00:00:00'
  `);
  const preferencesBefore = await db.select().from(orgMembersMetadata);
  const journalBefore = await migrationJournal();
  assert.equal(await columnExists(), true);

  // Exercise the real migration and journal boundary for each unexpected consumer.
  for (const dependency of [
    {
      create:
        "CREATE INDEX native_fence_index ON org_members_metadata (morning_brief_collection_revoked_at)",
      drop: "DROP INDEX native_fence_index",
    },
    {
      create:
        "ALTER TABLE org_members_metadata ADD CONSTRAINT native_fence_check CHECK (morning_brief_collection_revoked_at IS NOT NULL)",
      drop: "ALTER TABLE org_members_metadata DROP CONSTRAINT native_fence_check",
    },
    {
      create:
        "CREATE VIEW native_fence_view AS SELECT morning_brief_collection_revoked_at FROM org_members_metadata",
      drop: "DROP VIEW native_fence_view",
    },
    {
      create:
        "CREATE FUNCTION native_fence_reader() RETURNS timestamp LANGUAGE sql AS $$ SELECT morning_brief_collection_revoked_at FROM org_members_metadata LIMIT 1 $$",
      drop: "DROP FUNCTION native_fence_reader()",
    },
    {
      create:
        "CREATE FUNCTION native_fence_row(value org_members_metadata) RETURNS org_members_metadata LANGUAGE sql AS $$ SELECT value $$",
      drop: "DROP FUNCTION native_fence_row(org_members_metadata)",
    },
    {
      create:
        "CREATE FUNCTION native_fence_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.morning_brief_collection_revoked_at IS NOT NULL THEN RETURN NEW; END IF; RETURN NEW; END $$; CREATE TRIGGER native_fence_trigger BEFORE UPDATE ON org_members_metadata FOR EACH ROW EXECUTE FUNCTION native_fence_trigger()",
      drop: "DROP TRIGGER native_fence_trigger ON org_members_metadata; DROP FUNCTION native_fence_trigger()",
    },
  ]) {
    await client.query(dependency.create);
    await assert.rejects(
      applyPendingMigrations(migrationSql, {
        beforeMillis: contraction.when + 1,
      }),
      (error: unknown) => {
        return (
          error instanceof Error &&
          "code" in error &&
          error.code === "2BP01" &&
          error.message.includes(
            "Unexpected Native Morning Brief member fence dependencies",
          )
        );
      },
    );
    assert.equal(
      await columnExists(),
      true,
      "Rejected contraction must preserve the column",
    );
    assert.deepEqual(
      await db.select().from(orgMembersMetadata),
      preferencesBefore,
    );
    assert.deepEqual(
      await migrationJournal(),
      journalBefore,
      "Rejected contraction must not advance the journal",
    );
    await client.query(dependency.drop);
  }

  await client.query(
    "ALTER TABLE org_members_metadata DROP COLUMN morning_brief_collection_revoked_at",
  );
  await assert.rejects(
    applyPendingMigrations(migrationSql, {
      beforeMillis: contraction.when + 1,
    }),
    /Expected org_members_metadata.morning_brief_collection_revoked_at before retirement/u,
  );
  assert.deepEqual(await migrationJournal(), journalBefore);
  await client.query(
    "ALTER TABLE org_members_metadata ADD COLUMN morning_brief_collection_revoked_at timestamp",
  );
  await client.query(`
    UPDATE public.org_members_metadata
    SET morning_brief_collection_revoked_at = '2026-03-10T00:00:00'
  `);

  await client.query(
    `ALTER TABLE drizzle.__drizzle_migrations ADD CONSTRAINT native_fence_journal_failure CHECK (created_at <> ${contraction.when})`,
  );
  await assert.rejects(
    applyPendingMigrations(migrationSql, {
      beforeMillis: contraction.when + 1,
    }),
    (error: unknown) => {
      return (
        error instanceof Error && "code" in error && error.code === "23514"
      );
    },
  );
  assert.equal(await columnExists(), true, "Journal failure must restore DROP");
  assert.deepEqual(
    await db.select().from(orgMembersMetadata),
    preferencesBefore,
  );
  assert.deepEqual(await migrationJournal(), journalBefore);
  await client.query(
    "ALTER TABLE drizzle.__drizzle_migrations DROP CONSTRAINT native_fence_journal_failure",
  );

  await applyPendingMigrations(migrationSql, {
    beforeMillis: contraction.when + 1,
  });
  assert.equal(await columnExists(), false);
  assert.deepEqual(
    await db.select().from(orgMembersMetadata),
    preferencesBefore,
    "DROP must preserve every current member preference",
  );
  const journalAfter = await migrationJournal();
  assert.equal(journalAfter.length, journalBefore.length + 1);
  assert.equal(journalAfter.at(-1)?.created_at, String(contraction.when));
  await applyPendingMigrations(migrationSql, {
    beforeMillis: contraction.when + 1,
  });
  assert.deepEqual(await migrationJournal(), journalAfter);
  await validateMemberMetadataRuntimePreparation(ownedUrl.toString());
  assert.deepEqual(
    await db.select().from(orgMembersMetadata),
    preferencesBefore,
  );
  console.log(
    "Native member fence contraction rejects unexpected consumers, preserves preferences and journal atomicity, and supports current SQL",
  );
} finally {
  try {
    await client.end();
    await migrationSql.end();
  } finally {
    try {
      await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  }
}
