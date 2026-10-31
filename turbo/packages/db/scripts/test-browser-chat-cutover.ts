import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { browserOwnerWindows } from "../src/schema/browser-owner";
import postgres from "postgres";
import { array, number, object, string } from "zod";
import { applyPendingMigrations } from "./migration-runner";

/** Destructive pre-acceptance cutover must preserve supported legacy data. */
export async function validateBrowserChatCutover(databaseUrl: string) {
  const admin = new Client({ connectionString: databaseUrl });
  const database = `browser_chat_cutover_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(databaseUrl);
  target.pathname = `/${database}`;
  const client = new Client({ connectionString: target.href });
  let created = false;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${database}"`);
    created = true;
    await client.connect();
    const journal = object({
      entries: array(object({ tag: string(), when: number() })),
    }).parse(
      JSON.parse(
        await readFile(
          new URL("../src/migrations/meta/_journal.json", import.meta.url),
          "utf8",
        ),
      ),
    );
    const cutover = journal.entries.find((entry) => {
      return entry.tag === "1502_browser_chat_sessions";
    });
    assert(cutover);
    const migrator = postgres(target.href, { max: 1, onnotice: () => {} });
    try {
      await applyPendingMigrations(migrator, { beforeMillis: cutover.when });
      const owner = randomUUID(),
        instanceId = randomUUID(),
        providerId = randomUUID();
      const shared = randomUUID(),
        legacy = randomUUID(),
        profiled = randomUUID();
      const profileId = randomUUID();
      await client.query(
        `INSERT INTO browser_owner_profiles
        (org_id, user_id, provider_profile_id, instance_id, provider_session_id, status, creation_expires_at, timeout_at)
        VALUES ($1, $1, $2, $3, $4, 'active', now() + interval '1 minute', now() + interval '2 minutes')`,
        [owner, randomUUID(), instanceId, providerId],
      );
      await client.query(
        "INSERT INTO browser_profiles (id, org_id, user_id, provider_profile_id) VALUES ($1, $2, $2, $3)",
        [profileId, owner, randomUUID()],
      );
      for (const thread of [shared, legacy, profiled]) {
        await client.query(
          "INSERT INTO chat_threads (id, user_id) VALUES ($1, $2)",
          [thread, owner],
        );
        await client.query(
          `INSERT INTO browser_sessions (chat_thread_id, org_id, user_id, name, status, timeout_minutes, browser_profile_id)
          VALUES ($1, $2, $2, 'Saved Browser', 'active', 240, $3)`,
          [thread, owner, thread === profiled ? profileId : null],
        );
        await client.query(
          "INSERT INTO browser_session_tab_snapshots (chat_thread_id, encrypted_tab_urls) VALUES ($1, $2)",
          [thread, `encrypted-${thread}`],
        );
        await client.query(
          "INSERT INTO browser_session_screenshots (chat_thread_id, object_key, url) VALUES ($1, $2, $3)",
          [thread, `preview-${thread}`, `https://example.test/${thread}`],
        );
      }
      await client.query(
        `INSERT INTO browser_session_instances
        (provider_session_id, chat_thread_id, run_id, status, timeout_at, started_at)
        VALUES ($1, $2, $3, 'active', now() + interval '2 minutes', now())`,
        [randomUUID(), legacy, randomUUID()],
      );
      await client.query(
        `INSERT INTO browser_owner_windows (chat_thread_id, instance_id, state, primary_window_id, expires_at)
        VALUES ($1, $2, 'active', 0, now() + interval '1 minute')`,
        [shared, instanceId],
      );
      const retained = `SELECT to_jsonb(b) AS browser, to_jsonb(s) AS screenshot, to_jsonb(t) AS snapshot
        FROM browser_sessions b JOIN browser_session_screenshots s USING (chat_thread_id)
        JOIN browser_session_tab_snapshots t USING (chat_thread_id)
        WHERE b.chat_thread_id = ANY($1::uuid[]) ORDER BY b.chat_thread_id`;
      const before = (await client.query(retained, [[legacy, profiled]])).rows;
      assert.equal(before.length, 2);
      await applyPendingMigrations(migrator);
      // Outgoing GA deletion/cron still execute this complete ORM projection
      // with the shared feature disabled. Keep it legal until contraction.
      const outgoingWindows = await drizzle(client)
        .select()
        .from(browserOwnerWindows)
        .where(eq(browserOwnerWindows.instanceId, instanceId));
      assert.deepEqual(outgoingWindows, []);
      assert.equal(
        (
          await client.query(
            "SELECT count(*)::int AS count FROM browser_chat_sessions",
          )
        ).rows[0].count,
        0,
      );
      assert.deepEqual(
        (await client.query(retained, [[legacy, profiled]])).rows,
        before,
      );
      assert.equal(
        (
          await client.query(
            "SELECT count(*)::int AS count FROM browser_sessions WHERE chat_thread_id = $1",
            [shared],
          )
        ).rows[0].count,
        0,
      );
      assert.equal(
        (
          await client.query(
            "SELECT count(*)::int AS count FROM browser_session_tab_snapshots WHERE chat_thread_id = $1",
            [shared],
          )
        ).rows[0].count,
        0,
      );
      assert.equal(
        (
          await client.query(
            "SELECT count(*)::int AS count FROM browser_session_screenshots WHERE chat_thread_id = $1",
            [shared],
          )
        ).rows[0].count,
        0,
      );
      assert.deepEqual(
        (
          await client.query(
            "SELECT object_key, chat_thread_id FROM browser_session_screenshot_deletions",
          )
        ).rows,
        [{ object_key: `preview-${shared}`, chat_thread_id: shared }],
      );
      assert.deepEqual(
        (
          await client.query(
            "SELECT status, provider_session_id FROM browser_owner_profiles WHERE instance_id = $1",
            [instanceId],
          )
        ).rows,
        [{ status: "stopping", provider_session_id: providerId }],
      );
      console.log(
        "   ✅ Browser chat cutover starts empty, hands off shared preview cleanup, and preserves legacy state",
      );
    } finally {
      await migrator.end();
    }
  } finally {
    try {
      await client.end();
    } finally {
      try {
        if (created) {
          await admin.query(`DROP DATABASE "${database}"`);
        }
      } finally {
        await admin.end();
      }
    }
  }
}
