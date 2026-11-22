import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { applyPendingMigrations } from "./migration-runner";

export async function validateChatThreadEventExecutorRetirement(
  databaseUrl: string,
  migrationMillis: number,
  retirementMillis: number,
): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1 });
  const org = randomUUID();
  const otherOrg = randomUUID();
  const shared = { sha256: "a".repeat(64), archiveBytes: 123 };
  const personal = { sha256: "b".repeat(64), archiveBytes: 234 };
  const savedVersion = randomUUID();
  const executor = randomUUID();
  const eventId = randomUUID();
  try {
    await applyPendingMigrations(sql, { beforeMillis: migrationMillis });
    await sql`INSERT INTO agents (id, org_id, owner, name, visibility, instructions, instructions_bundle)
      VALUES (${executor}, ${org}, 'owner', 'default-agent', 'public', 'workspace text', ${sql.json(shared)}),
        (gen_random_uuid(), ${otherOrg}, 'owner', 'private-agent', 'private', 'private text', ${sql.json(personal)})`;
    await sql`INSERT INTO org_members_cache (org_id, user_id)
      VALUES (${org}, 'owner'), (${org}, 'peer'), (${otherOrg}, 'owner'), (${otherOrg}, 'peer')`;
    await sql`INSERT INTO instructions (org_id, user_id, content, bundle, version)
      VALUES (${org}, 'owner', '', ${sql.json(personal)}, ${savedVersion})`;
    await sql`INSERT INTO chat_thread_events
      (id, user_id, org_id, seq_id, chat_thread_id, kind, event_executor_id, pin_order)
      VALUES (${eventId}, 'owner', ${org}, 7, gen_random_uuid(), 'agent_reassigned', ${executor}, 'a1')`;
    const expectedProfiles =
      await sql`SELECT to_jsonb(a) - 'created_at' AS profile FROM agents a WHERE org_id IN (${org}, ${otherOrg}) ORDER BY id`;
    const [before] =
      await sql`SELECT to_jsonb(e) - 'event_executor_id' AS payload
      FROM chat_thread_events e WHERE id = ${eventId}`;

    await applyPendingMigrations(sql, {
      beforeMillis: retirementMillis,
    });
    const profiles =
      await sql`SELECT to_jsonb(p) AS profile FROM legacy_agent_api_profiles p WHERE org_id IN (${org}, ${otherOrg}) ORDER BY id`;
    assert.deepEqual([...profiles], [...expectedProfiles]);
    await assert.rejects(
      async () => {
        await sql`UPDATE agents SET description = 'stale writer' WHERE id = ${executor}`;
      },
      { code: "55000" },
    );
    await sql`UPDATE legacy_agent_api_profiles SET description = 'during upgrade' WHERE org_id = ${org} AND id = ${executor}`;
    await applyPendingMigrations(sql, { beforeMillis: retirementMillis + 1 });
    const [updated] =
      await sql`SELECT description FROM legacy_agent_api_profiles WHERE id = ${executor}`;
    assert.equal(updated?.description, "during upgrade");
    const [retired] =
      await sql`SELECT to_regclass('public.agents') AS relation`;
    assert.equal(retired?.relation, null);
    const [after] =
      await sql`SELECT to_jsonb(e) AS payload FROM chat_thread_events e WHERE id = ${eventId}`;
    assert.deepEqual(after, before);
    const saved = await sql`SELECT content, bundle, version FROM instructions
      WHERE org_id = ${org} AND user_id = 'owner'`;
    assert.deepEqual(
      [...saved],
      [{ content: "", bundle: personal, version: savedVersion }],
    );
    const missing = await sql`SELECT org_id FROM instructions
      WHERE (org_id = ${org} AND user_id = 'peer') OR org_id = ${otherOrg}`;
    assert.equal(
      missing.length,
      0,
      "members without saved instructions keep the built-in default",
    );
  } finally {
    await sql.end();
  }
}
