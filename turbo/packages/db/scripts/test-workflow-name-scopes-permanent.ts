import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

/** Current Workflow identity keys on replayed and freshly generated schemas. */
export async function validatePermanentWorkflowNameScopes(databaseUrl: string) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const agentId = randomUUID();
  const orgId = `workflow-scopes-${randomUUID()}`;

  const insert = async (
    name: string,
    visibility: "private" | "public" = "private",
    definition: string | null = null,
    state: "installing" | "installed" | null = null,
  ) => {
    return await client.query(
      `INSERT INTO workflows (org_id, agent_id, owner_user_id, name, visibility,
        official_definition_name, official_installation_state, created_by, updated_by)
       VALUES ($1, $2, 'owner', $3, $4, $5, $6, 'owner', 'owner') RETURNING id`,
      [orgId, agentId, name, visibility, definition, state],
    );
  };
  const duplicate = (constraint: string) => {
    return (error: unknown): boolean => {
      return (
        error instanceof Error &&
        "code" in error &&
        error.code === "23505" &&
        "constraint" in error &&
        error.constraint === constraint
      );
    };
  };

  try {
    await client.query(
      `INSERT INTO agents (id, org_id, owner, name) VALUES ($1, $2, 'owner', 'scopes')`,
      [agentId, orgId],
    );
    await insert("ordinary-first");
    await insert("ordinary-first", "private", "ordinary-first", "installing");
    await insert("official-first", "private", "official-first", "installed");
    await insert("official-first");
    await insert("ordinary-first", "public");

    await assert.rejects(
      insert("ordinary-first"),
      duplicate("idx_workflows_ordinary_private_owner_agent_name_unique"),
    );
    await assert.rejects(
      insert("ordinary-first", "public"),
      duplicate("idx_workflows_public_agent_name_unique"),
    );
    for (const state of ["installing", "installed"] as const) {
      await assert.rejects(
        insert("ordinary-first", "private", "ordinary-first", state),
        duplicate("idx_workflows_official_owner_agent_definition_unique"),
      );
    }
    assert.equal(
      (
        await client.query(
          `SELECT id FROM workflows WHERE org_id = $1 AND agent_id = $2
           AND owner_user_id = 'owner' AND name = 'ordinary-first'
           AND visibility = 'private' AND official_definition_name IS NULL`,
          [orgId, agentId],
        )
      ).rowCount,
      1,
      "Ordinary readers select one identity even beside a same-name Official installation",
    );
  } finally {
    await client.query(`DELETE FROM agents WHERE id = $1`, [agentId]);
    await client.end();
  }
}
