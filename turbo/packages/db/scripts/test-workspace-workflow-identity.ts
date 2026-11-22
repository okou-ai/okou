import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { applyPendingMigrations } from "./migration-runner";

const migration = "1611_workspace_workflow_identity";
const migrations = new URL("../src/migrations/", import.meta.url);

export async function validateWorkspaceWorkflowIdentity(databaseUrl: string) {
  const admin = postgres(databaseUrl, { max: 1 });
  const url = new URL(databaseUrl);
  const database = "workflow_identity_" + randomUUID().replaceAll("-", "");
  url.pathname = "/" + database;
  const sql = postgres(url.toString(), { max: 1 });
  try {
    await admin.unsafe(`CREATE DATABASE "${database}"`);
    const journal = JSON.parse(
      await readFile(new URL("meta/_journal.json", migrations), "utf8"),
    ) as {
      entries: { tag: string; when: number }[];
    };
    const entry = journal.entries.find((row) => {
      return row.tag === migration;
    });
    assert.ok(entry);
    await applyPendingMigrations(sql, { beforeMillis: entry.when });
    const migrate = () => {
      return applyPendingMigrations(sql, { beforeMillis: entry.when + 1 });
    };
    const org = "workflow-migration";
    const [first, second, personal] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ] as const;
    await sql`INSERT INTO agents (id, org_id, owner, name, visibility) VALUES
      (${first}, ${org}, 'owner', 'default-agent', 'public'),
      (${second}, ${org}, 'other', 'other', 'public'),
      (${personal}, ${org}, 'owner', 'personal', 'private')`;
    await sql`INSERT INTO org_metadata (org_id, default_agent_id) VALUES (${org}, ${first})`;
    const [hidden] =
      await sql`INSERT INTO workflows (org_id, agent_id, owner_user_id, name, visibility, created_by, updated_by)
      VALUES (${org}, ${personal}, 'owner', 'hidden', 'public', 'owner', 'owner') RETURNING id`;
    assert.ok(hidden);
    for (const [key, visibility, a, b] of [
      ["public_org_name", "public", null, null],
      ["ordinary_private_owner_name", "private", null, null],
      ["official_owner_definition", "private", "weekly", "weekly"],
      [
        "morning_brief_owner",
        "private",
        "morning-brief",
        "internal-test-morning-brief",
      ],
    ] as const) {
      for (const [agentId, definition] of [
        [first, a],
        [second, b],
      ] as const) {
        await sql`INSERT INTO workflows (org_id, agent_id, owner_user_id, name, visibility, official_definition_name,
          official_installation_state, created_by, updated_by) VALUES (${org}, ${agentId}, 'owner',
          ${definition ?? "same-name"}, ${visibility}, ${definition}, ${definition ? "installed" : null}, 'owner', 'owner')`;
      }
      await assert.rejects(migrate(), {
        code: "23505",
        constraint_name: "idx_workflows_" + key + "_unique",
      });
      const retained: readonly { agent_id: string }[] = await sql<
        { agent_id: string }[]
      >`DELETE FROM workflows WHERE org_id = ${org} AND id <> ${hidden.id} RETURNING agent_id`;
      assert.equal(retained.length, 2);
    }
    const [shared] =
      await sql`INSERT INTO workflows (org_id, agent_id, owner_user_id, name, visibility, created_by, updated_by)
      VALUES (${org}, ${personal}, 'other', 'shared', 'public', 'other', 'other') RETURNING id`;
    assert.ok(shared);
    await sql`UPDATE workflows SET org_id = 'foreign' WHERE id = ${shared.id}`;
    await assert.rejects(migrate(), /foreign workspace/);
    await sql`UPDATE workflows SET org_id = ${org} WHERE id = ${shared.id}`;
    const [duplicate] =
      await sql`INSERT INTO workflows (org_id, agent_id, owner_user_id, name, visibility, created_by, updated_by)
      VALUES (${org}, ${first}, 'owner', 'shared', 'public', 'owner', 'owner') RETURNING id`;
    assert.ok(duplicate);
    await assert.rejects(migrate(), {
      code: "23505",
      constraint_name: "idx_workflows_public_org_name_unique",
    });
    await sql`DELETE FROM workflows WHERE id = ${duplicate.id}`;
    await sql`UPDATE org_metadata SET default_agent_id = ${second} WHERE org_id = ${org}`;
    await assert.rejects(migrate(), /default executor differs/);
    await sql`UPDATE org_metadata SET default_agent_id = ${first} WHERE org_id = ${org}`;
    const [before] =
      await sql`SELECT agent_id, visibility FROM workflows WHERE id = ${hidden.id}`;
    assert.equal(before?.agent_id, personal);
    assert.equal(before?.visibility, "public");
    await migrate();
    const [after] =
      await sql`SELECT owner_user_id, visibility FROM workflows WHERE id = ${hidden.id}`;
    assert.equal(after?.owner_user_id, "owner");
    assert.equal(after?.visibility, "private");
    const [published] =
      await sql`SELECT owner_user_id, visibility FROM workflows WHERE id = ${shared.id}`;
    assert.equal(published?.owner_user_id, "other");
    assert.equal(published?.visibility, "public");
    const columns = await sql`SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND (table_name, column_name) IN
      (('workflows', 'agent_id'), ('org_metadata', 'default_agent_id'))`;
    assert.equal(columns.length, 0);
  } finally {
    await sql.end();
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${database}"`);
    } finally {
      await admin.end();
    }
  }
}
