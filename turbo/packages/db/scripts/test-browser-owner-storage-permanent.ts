import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { browserOwnerProfiles } from "../src/schema/browser-owner";
import { browserChatSessions } from "../src/schema/browser-chat-session";

/** Current schema integrity; caller-level concurrency lives in Runner route tests. */
export async function validatePermanentBrowserOwnerStorage(
  databaseUrl: string,
) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const db = drizzle(client);
  const profileId = randomUUID(),
    instanceId = randomUUID(),
    replacementId = randomUUID();
  const providerProfileId = randomUUID(),
    chatThreadId = randomUUID();
  const orgId = `browser-owner-schema-${randomUUID()}`;
  const now = new Date();
  const creationExpiresAt = new Date(now.getTime() + 60_000);
  const timeoutAt = new Date(now.getTime() + 240 * 60_000);
  try {
    await db.insert(browserOwnerProfiles).values({
      id: profileId,
      orgId,
      userId: orgId,
      providerProfileId,
      instanceId,
      status: "creating",
      creationExpiresAt,
      timeoutAt,
    });
    await assert.rejects(
      client.query(
        "INSERT INTO browser_owner_profiles (org_id, user_id, provider_profile_id, instance_id, status, creation_expires_at, timeout_at) VALUES ($1, $1, $2, $3, 'creating', $4, $5)",
        [orgId, randomUUID(), randomUUID(), creationExpiresAt, timeoutAt],
      ),
      { code: "23505", constraint: "uq_browser_owner_profiles_owner" },
    );
    await assert.rejects(
      client.query(
        "INSERT INTO browser_owner_profiles (org_id, user_id, provider_profile_id, instance_id, status, creation_expires_at, timeout_at) VALUES ($1, $1, $2, $3, 'creating', $4, $5)",
        [
          orgId + "-other",
          providerProfileId,
          randomUUID(),
          creationExpiresAt,
          timeoutAt,
        ],
      ),
      { code: "23505", constraint: "uq_browser_owner_profiles_provider" },
    );
    await assert.rejects(
      client.query(
        "UPDATE browser_owner_profiles SET status = 'unknown' WHERE id = $1",
        [profileId],
      ),
      { code: "23514", constraint: "browser_owner_profiles_status_check" },
    );
    await assert.rejects(
      client.query(
        "UPDATE browser_owner_profiles SET status = 'active' WHERE id = $1",
        [profileId],
      ),
      { code: "23514", constraint: "browser_owner_profiles_provider_check" },
    );
    for (const assignment of [
      "creation_expires_at = created_at",
      "timeout_at = creation_expires_at - interval '1 second'",
    ]) {
      await assert.rejects(
        client.query(
          `UPDATE browser_owner_profiles SET ${assignment} WHERE id = $1`,
          [profileId],
        ),
        { code: "23514", constraint: "browser_owner_profiles_deadline_check" },
      );
    }

    await assert.rejects(
      client.query(
        "INSERT INTO browser_chat_sessions (instance_id, chat_thread_id, state, primary_window_id, expires_at, org_id, user_id) VALUES ($1, $2, 'active', 0, $3, $4, $4)",
        [instanceId, chatThreadId, timeoutAt, orgId],
      ),
      { code: "23503", constraint: "browser_chat_sessions_active_instance_fk" },
    );

    await db
      .update(browserOwnerProfiles)
      .set({ status: "active", providerSessionId: randomUUID() })
      .where(eq(browserOwnerProfiles.id, profileId));
    await assert.rejects(
      client.query(
        `INSERT INTO browser_owner_profiles
          (org_id, user_id, provider_profile_id, instance_id, provider_session_id,
           status, creation_expires_at, timeout_at)
         SELECT $2, $2, $3, $4, provider_session_id, 'active', creation_expires_at, timeout_at
         FROM browser_owner_profiles WHERE id = $1`,
        [profileId, orgId + "-session", randomUUID(), randomUUID()],
      ),
      { code: "23505", constraint: "uq_browser_owner_profiles_session" },
    );
    await db.insert(browserChatSessions).values({
      orgId,
      userId: orgId,
      name: "Saved chat",
      encryptedTabUrls: "encrypted-urls",
      tabUrlsCapturedAt: now,
      instanceId,
      chatThreadId,
      state: "active",
      primaryWindowId: 0,
      expiresAt: timeoutAt,
    });
    await assert.rejects(
      client.query(
        "INSERT INTO browser_chat_sessions (instance_id, chat_thread_id, state, primary_window_id, expires_at, org_id, user_id) VALUES ($1, $2, 'active', 0, $3, $4, $4)",
        [instanceId, chatThreadId, timeoutAt, orgId],
      ),
      { code: "23505", constraint: "browser_chat_sessions_pkey" },
    );
    await assert.rejects(
      client.query(
        "INSERT INTO browser_chat_sessions (instance_id, chat_thread_id, state, primary_window_id, expires_at, org_id, user_id) VALUES ($1, $2, 'active', 0, $3, $4, $4)",
        [instanceId, randomUUID(), timeoutAt, orgId],
      ),
      { code: "23505", constraint: "uq_browser_chat_sessions_native_window" },
    );
    await assert.rejects(
      client.query(
        "UPDATE browser_chat_sessions SET primary_window_id = -1 WHERE chat_thread_id = $1",
        [chatThreadId],
      ),
      { code: "23514", constraint: "browser_chat_sessions_primary_check" },
    );
    await assert.rejects(
      client.query(
        "UPDATE browser_chat_sessions SET expires_at = created_at WHERE chat_thread_id = $1",
        [chatThreadId],
      ),
      { code: "23514", constraint: "browser_chat_sessions_deadline_check" },
    );
    for (const assignment of [
      "state = NULL",
      "instance_id = NULL",
      "primary_window_id = NULL",
      "expires_at = NULL",
    ]) {
      await assert.rejects(
        client.query(
          `UPDATE browser_chat_sessions SET ${assignment} WHERE chat_thread_id = $1`,
          [chatThreadId],
        ),
        { code: "23514", constraint: "browser_chat_sessions_binding_check" },
      );
    }
    await assert.rejects(
      client.query(
        "UPDATE browser_chat_sessions SET tab_urls_captured_at = NULL WHERE chat_thread_id = $1",
        [chatThreadId],
      ),
      { code: "23514", constraint: "browser_chat_sessions_urls_check" },
    );
    await assert.rejects(
      client.query(
        "UPDATE browser_chat_sessions SET screenshot_object_key = 'incomplete-preview' WHERE chat_thread_id = $1",
        [chatThreadId],
      ),
      { code: "23514", constraint: "browser_chat_sessions_screenshot_check" },
    );
    await assert.rejects(
      client.query(
        "UPDATE browser_owner_profiles SET status = 'stopping' WHERE id = $1",
        [profileId],
      ),
      { code: "23503", constraint: "browser_chat_sessions_active_instance_fk" },
    );
    await db
      .update(browserChatSessions)
      .set({ state: "closing" })
      .where(eq(browserChatSessions.chatThreadId, chatThreadId));
    // Retiring authority is not proof of native closure. Its identity remains
    // while the provider is stopped, without retaining live admission.
    await db
      .update(browserOwnerProfiles)
      .set({ status: "stopping" })
      .where(eq(browserOwnerProfiles.id, profileId));
    await assert.rejects(
      client.query("DELETE FROM browser_owner_profiles WHERE id = $1", [
        profileId,
      ]),
      { code: "23503" },
    );
    await assert.rejects(
      client.query(
        "UPDATE browser_owner_profiles SET instance_id = $1 WHERE id = $2",
        [replacementId, profileId],
      ),
      { code: "23503", constraint: "browser_chat_sessions_instance_fk" },
    );
    await db
      .update(browserChatSessions)
      .set({
        instanceId: null,
        state: null,
        primaryWindowId: null,
        expiresAt: null,
      })
      .where(eq(browserChatSessions.chatThreadId, chatThreadId));
    await db
      .update(browserOwnerProfiles)
      .set({ status: "stopped" })
      .where(eq(browserOwnerProfiles.id, profileId));
    const [replacement] = await db
      .update(browserOwnerProfiles)
      .set({
        instanceId: replacementId,
        providerSessionId: null,
        status: "creating",
      })
      .where(eq(browserOwnerProfiles.id, profileId))
      .returning();
    assert.equal(replacement?.providerProfileId, providerProfileId);
    assert.equal(replacement?.instanceId, replacementId);
    const [retained] = await db
      .select()
      .from(browserChatSessions)
      .where(eq(browserChatSessions.chatThreadId, chatThreadId));
    assert.equal(retained?.instanceId, null);
    assert.equal(retained?.name, "Saved chat");
    assert.equal(retained?.encryptedTabUrls, "encrypted-urls");
    assert.equal(retained?.tabUrlsCapturedAt?.getTime(), now.getTime());
    const stale = await client.query(
      "UPDATE browser_owner_profiles SET status = 'stopped' WHERE id = $1 AND instance_id = $2 RETURNING id",
      [profileId, instanceId],
    );
    assert.equal(stale.rowCount, 0);
  } finally {
    await db
      .delete(browserChatSessions)
      .where(eq(browserChatSessions.chatThreadId, chatThreadId));
    await db
      .delete(browserOwnerProfiles)
      .where(eq(browserOwnerProfiles.id, profileId));
    await client.end();
  }
}
