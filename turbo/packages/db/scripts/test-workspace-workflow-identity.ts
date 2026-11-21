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
    const audit = await readFile(
      new URL("./audit-workspace-workflow-identity.sql", import.meta.url),
      "utf8",
    );
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
    for (const [key, problem, visibility, a, b] of [
      ["public_org_name", "public_name", "public", null, null],
      ["ordinary_private_owner_name", "private_name", "private", null, null],
      [
        "official_owner_definition",
        "official_installation",
        "private",
        "weekly",
        "weekly",
      ],
      [
        "morning_brief_owner",
        "morning_brief",
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
      const [conflict] = await sql.unsafe(audit);
      assert.equal(conflict?.problem, problem);
      assert.equal(conflict?.workflow_ids.length, 2);
      await assert.rejects(migrate(), {
        code: "23505",
        constraint_name: "idx_workflows_" + key + "_unique",
      });
      const retained: readonly { agent_id: string }[] = await sql<
        { agent_id: string }[]
      >`DELETE FROM workflows WHERE org_id = ${org} AND id <> ${hidden.id} RETURNING agent_id`;
      assert.equal(retained.length, 2);
    }
    await sql`UPDATE workflows SET owner_user_id = 'other' WHERE id = ${hidden.id}`;
    assert.equal((await sql.unsafe(audit))[0]?.problem, "two_private_readers");
    await assert.rejects(migrate(), /two distinct legacy private readers/);
    await sql`UPDATE workflows SET owner_user_id = 'owner' WHERE id = ${hidden.id}`;
    await sql`UPDATE org_metadata SET default_agent_id = ${second} WHERE org_id = ${org}`;
    assert.equal((await sql.unsafe(audit))[0]?.problem, "default_executor");
    await assert.rejects(migrate(), /default executor differs/);
    await sql`UPDATE org_metadata SET default_agent_id = ${first} WHERE org_id = ${org}`;
    assert.equal((await sql.unsafe(audit)).length, 0);
    const [before] =
      await sql`SELECT agent_id, visibility FROM workflows WHERE id = ${hidden.id}`;
    assert.equal(before?.agent_id, personal);
    assert.equal(before?.visibility, "public");
    await migrate();
    const [after] =
      await sql`SELECT owner_user_id, visibility FROM workflows WHERE id = ${hidden.id}`;
    assert.equal(after?.owner_user_id, "owner");
    assert.equal(after?.visibility, "private");
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
