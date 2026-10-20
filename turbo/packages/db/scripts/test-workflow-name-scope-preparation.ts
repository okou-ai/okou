import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import postgres from "postgres";
import { z } from "zod";

import { DRIZZLE_MIGRATE_OUT } from "../drizzle.config";
import { applyFixtureMigrations } from "./fixtures/migrate-with-empty-instructions";

const journal = z
  .object({ entries: z.array(z.object({ tag: z.string(), when: z.number() })) })
  .parse(
    JSON.parse(
      await readFile(`${DRIZZLE_MIGRATE_OUT}/meta/_journal.json`, "utf8"),
    ),
  );
const preparation = journal.entries.find((entry) => {
  return entry.tag.endsWith("_workflow_name_scopes");
});
assert.ok(
  preparation,
  "Retain this validator until same-name coexistence is activated",
);
const contraction = journal.entries.find((entry) => {
  return entry.tag.endsWith("_workflow_name_coexistence");
});
assert.ok(contraction, "The shared-name contraction must remain in history");
const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const adminUrl = new URL(databaseUrl);
adminUrl.pathname = "/postgres";
const databaseName = `workflow_names_${randomUUID().replaceAll("-", "")}`;
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
const agentId = randomUUID();

function uniqueConstraint(constraint: string) {
  return (error: unknown): boolean => {
    return (
      error instanceof Error &&
      "code" in error &&
      error.code === "23505" &&
      "constraint" in error &&
      error.constraint === constraint
    );
  };
}

async function insertWorkflow(
  name: string,
  installationState: "installing" | "installed" | null = null,
  visibility: "private" | "public" = "private",
) {
  return await client.query(
    `INSERT INTO workflows (org_id, agent_id, owner_user_id, name, visibility,
      official_definition_name, official_installation_state, created_by, updated_by)
     VALUES ('workflow-names-org', $1, 'workflow-names-owner', $2, $3, $4, $5,
      'workflow-names-owner', 'workflow-names-owner') RETURNING id`,
    [
      agentId,
      name,
      visibility,
      installationState === null ? null : name,
      installationState,
    ],
  );
}

async function assertOutgoingNameReads() {
  // Captured outgoing APIs read Private rows by name, without a definition predicate.
  const selected = await client.query(
    `SELECT id FROM workflows WHERE org_id = 'workflow-names-org'
      AND agent_id = $1 AND owner_user_id = 'workflow-names-owner'
      AND visibility = 'private' AND name = 'ordinary-first'`,
    [agentId],
  );
  assert.equal(
    selected.rowCount,
    1,
    "Outgoing name readers must remain unambiguous",
  );
  // The outgoing Copy API handles this exact constraint name.
  await assert.rejects(
    insertWorkflow("ordinary-first"),
    uniqueConstraint("idx_workflows_private_owner_agent_name_unique"),
  );
  assert.equal(
    (
      await client.query(
        `INSERT INTO workflows (org_id, agent_id, owner_user_id, name, created_by, updated_by)
     VALUES ('workflow-names-org', $1, 'workflow-names-owner', 'ordinary-first',
      'workflow-names-owner', 'workflow-names-owner') ON CONFLICT DO NOTHING RETURNING id`,
        [agentId],
      )
    ).rowCount,
    0,
    "Outgoing broad ON CONFLICT SQL remains supported",
  );
}

try {
  await client.connect();
  await applyFixtureMigrations(migrationSql, {
    beforeMillis: preparation.when,
  });
  await client.query(
    `INSERT INTO agents (id, org_id, owner, name)
     VALUES ($1, 'workflow-names-org', 'workflow-names-owner', 'workflow-names-agent')`,
    [agentId],
  );
  await insertWorkflow("ordinary-first");
  await insertWorkflow("official-first", "installing");
  await assertOutgoingNameReads();
  await applyFixtureMigrations(migrationSql, {
    beforeMillis: contraction.when,
  });
  await assertOutgoingNameReads();
  const sharedKey = "idx_workflows_private_owner_agent_name_unique";
  await assert.rejects(
    insertWorkflow("ordinary-first", "installed"),
    uniqueConstraint(sharedKey),
  );
  await assert.rejects(
    insertWorkflow("official-first"),
    uniqueConstraint(sharedKey),
  );
  await client.query(
    `UPDATE workflows SET official_installation_state = 'installed'
     WHERE agent_id = $1 AND official_definition_name = 'official-first'`,
    [agentId],
  );

  // Apply the generated contraction only after outgoing readers are excluded.
  await applyFixtureMigrations(migrationSql);
  await insertWorkflow("ordinary-first", "installing");
  await insertWorkflow("official-first");
  await insertWorkflow("ordinary-first", null, "public");
  await assert.rejects(
    insertWorkflow("ordinary-first"),
    uniqueConstraint("idx_workflows_ordinary_private_owner_agent_name_unique"),
  );
  for (const name of ["ordinary-first", "official-first"]) {
    for (const state of ["installing", "installed"] as const) {
      await assert.rejects(
        insertWorkflow(name, state),
        uniqueConstraint(
          "idx_workflows_official_owner_agent_definition_unique",
        ),
      );
    }
  }
  await assert.rejects(
    insertWorkflow("ordinary-first", null, "public"),
    uniqueConstraint("idx_workflows_public_agent_name_unique"),
  );
  console.log(
    "Workflow preparation preserves outgoing readers until the generated contraction activates independent namespaces",
  );
} finally {
  await client.end();
  await migrationSql.end();
  await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
  await admin.end();
}
