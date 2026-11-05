import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import postgres from "postgres";
import { array, number, object, record, string, unknown } from "zod";
import { applyPendingMigrations } from "../../migration-runner";

/** Acceptance for the bounded, explicitly authorized legacy-account cutover. */
export async function validateTeamsDisconnection(databaseUrl: string) {
  const journal = object({
    entries: array(object({ tag: string(), when: number() })),
  }).parse(
    JSON.parse(
      await readFile(
        new URL("../../../src/migrations/meta/_journal.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  const disconnection = journal.entries.find((entry) => {
    return entry.tag.endsWith("_disconnect_unowned_teams_connections");
  });
  assert.ok(disconnection, "Missing bounded Teams disconnection migration");
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await applyPendingMigrations(sql, { beforeMillis: disconnection.when });
    const fixture = `teams-disconnection-${randomUUID()}`;
    const organization = `${fixture}-org`;
    function account(owned: boolean) {
      return {
        id: randomUUID(),
        threadId: randomUUID(),
        contextId: randomUUID(),
        userId: `${fixture}-${randomUUID()}`,
        orgId: owned ? organization : null,
      };
    }
    const owned = account(true);
    const extra = account(false);
    const unowned = Array.from({ length: 7 }, () => {
      return account(false);
    });
    const accounts = [owned, ...unowned, extra];
    const threadIds = accounts.map((item) => {
      return item.threadId;
    });
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    async function readState() {
      const result = await client.query(
        `SELECT jsonb_build_object(
          'connections', (SELECT jsonb_agg(to_jsonb(c) ORDER BY id)
            FROM teams_org_connections c WHERE teams_tenant_id = $1),
          'routes', (SELECT jsonb_agg(to_jsonb(r) ORDER BY id)
            FROM teams_chat_thread_routes r WHERE chat_thread_id = ANY($3::uuid[])),
          'threads', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id)
            FROM chat_threads t WHERE id = ANY($3::uuid[])),
          'events', (SELECT jsonb_agg(to_jsonb(e) ORDER BY id)
            FROM chat_events e WHERE chat_thread_id = ANY($3::uuid[])),
          'contexts', (SELECT jsonb_agg(to_jsonb(c) ORDER BY id)
            FROM chat_teams_context c WHERE chat_thread_id = ANY($3::uuid[])),
          'installations', (SELECT jsonb_agg(to_jsonb(i) ORDER BY teams_tenant_id)
            FROM teams_org_installations i WHERE teams_tenant_id = $1),
          'ownedConnection', (SELECT to_jsonb(c) - 'legacy_installation_tenant_id'
            FROM teams_org_connections c WHERE id = $2::uuid),
          'ownedRoutes', (SELECT jsonb_agg(to_jsonb(r) ORDER BY id)
            FROM teams_chat_thread_routes r WHERE connection_id = $2::uuid),
          'journal', (SELECT jsonb_agg(to_jsonb(m) ORDER BY id)
            FROM drizzle.__drizzle_migrations m)
        ) AS state`,
        [fixture, owned.id, threadIds],
      );
      return object({ state: record(string(), unknown()) }).parse(
        result.rows[0],
      ).state;
    }
    try {
      await client.query(
        "INSERT INTO teams_org_installations (teams_tenant_id, org_id) VALUES ($1, $2)",
        [fixture, organization],
      );
      for (const item of accounts) {
        await client.query(
          `INSERT INTO teams_org_connections
            (id, teams_tenant_id, user_id, org_id, teams_aad_object_id)
          VALUES ($1, $2, $3, $4, $5)`,
          [item.id, fixture, item.userId, item.orgId, randomUUID()],
        );
        await client.query(
          "INSERT INTO chat_threads (id, user_id, title) VALUES ($1, $2, 'Preserved Teams history')",
          [item.threadId, item.userId],
        );
        await client.query(
          `INSERT INTO teams_chat_thread_routes
            (connection_id, conversation_id, thread_id, user_id, chat_thread_id)
          VALUES ($1, 'fixture-conversation', 'fixture-thread', $2, $3)`,
          [item.id, item.userId, item.threadId],
        );
        await client.query(
          `INSERT INTO chat_teams_context
            (id, chat_thread_id, tenant_id, connection_id, conversation_id, message_text)
          VALUES ($1, $2, $3, $4, 'fixture-conversation', 'Preserved input')`,
          [item.contextId, item.threadId, fixture, item.id],
        );
        await client.query(
          `INSERT INTO chat_events
            (chat_thread_id, seq_id, event_type, context_type, context_id, payload)
          VALUES ($1, 1, 'input.prompt', 'teams', $2,
            '{"userMessage":{"parts":[{"type":"text","text":"Preserved input"}]}}'::jsonb)`,
          [item.threadId, item.contextId],
        );
      }
      const beforeReferenceRefusal = await readState();
      await client.query(
        `CREATE TABLE teams_unexpected_reference (
          connection_id uuid REFERENCES teams_org_connections(id) ON DELETE CASCADE
        )`,
      );
      try {
        await assert.rejects(applyPendingMigrations(sql), {
          code: "P0001",
          message: /Unexpected Teams connection references/,
        });
        assert.deepEqual(await readState(), beforeReferenceRefusal);
      } finally {
        await client.query("DROP TABLE teams_unexpected_reference");
      }
      const beforeRefusal = await readState();
      await assert.rejects(applyPendingMigrations(sql), {
        code: "P0001",
        message: /More than 7 unowned Teams connections/,
      });
      assert.deepEqual(await readState(), beforeRefusal);

      // An already disconnected account is not a target of the later cutover.
      await client.query("DELETE FROM teams_org_connections WHERE id = $1", [
        extra.id,
      ]);
      const beforeCutover = await readState();
      await applyPendingMigrations(sql);
      const afterCutover = await readState();
      for (const key of [
        "threads",
        "events",
        "contexts",
        "installations",
        "ownedConnection",
        "ownedRoutes",
      ]) {
        assert.deepEqual(afterCutover[key], beforeCutover[key]);
      }
      assert.deepEqual(
        (
          await client.query(
            "SELECT id, org_id FROM teams_org_connections WHERE teams_tenant_id = $1",
            [fixture],
          )
        ).rows,
        [{ id: owned.id, org_id: organization }],
      );
      assert.deepEqual(afterCutover.routes, beforeCutover.ownedRoutes);
      assert.notDeepEqual(afterCutover.journal, beforeCutover.journal);
    } finally {
      try {
        await client.query(
          "DELETE FROM teams_org_connections WHERE teams_tenant_id = $1",
          [fixture],
        );
        await client.query(
          "DELETE FROM chat_threads WHERE id = ANY($1::uuid[])",
          [threadIds],
        );
        await client.query(
          "DELETE FROM teams_org_installations WHERE teams_tenant_id = $1",
          [fixture],
        );
      } finally {
        await client.end();
      }
    }
  } finally {
    await sql.end();
  }
}
