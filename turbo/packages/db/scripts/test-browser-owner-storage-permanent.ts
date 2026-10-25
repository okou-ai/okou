import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { z } from "zod";
import {
  browserOwnerInstances,
  browserOwnerProfiles,
} from "../src/schema/browser-owner";
import {
  parseBrowserOwnerWindows,
  type BrowserOwnerWindows,
} from "../src/jsonb-contracts/browser-owner";

/** Current schema integrity; caller-level concurrency lives in Runner route tests. */
export async function validatePermanentBrowserOwnerStorage(
  databaseUrl: string,
) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const db = drizzle(client);
  const profileId = randomUUID();
  const instanceId = randomUUID();
  const replacementId = randomUUID();
  const providerProfileId = randomUUID();
  const windowSessionId = randomUUID();
  const chatThreadId = randomUUID();
  const orgId = `browser-owner-schema-${randomUUID()}`;
  const now = new Date();
  const creationExpiresAt = new Date(now.getTime() + 60_000);
  const timeoutAt = new Date(now.getTime() + 240 * 60_000);
  try {
    await db
      .insert(browserOwnerProfiles)
      .values({ id: profileId, orgId, userId: orgId, providerProfileId });
    await assert.rejects(
      client.query(
        "INSERT INTO browser_owner_profiles (org_id, user_id, provider_profile_id) VALUES ($1, $1, $2)",
        [orgId, randomUUID()],
      ),
      { code: "23505", constraint: "uq_browser_owner_profiles_owner" },
    );
    await assert.rejects(
      client.query(
        "INSERT INTO browser_owner_profiles (org_id, user_id, provider_profile_id) VALUES ($1, $1, $2)",
        [`${orgId}-other`, providerProfileId],
      ),
      { code: "23505", constraint: "uq_browser_owner_profiles_provider" },
    );

    const [instance] = await db
      .insert(browserOwnerInstances)
      .values({
        id: instanceId,
        ownerProfileId: profileId,
        status: "creating",
        creationExpiresAt,
        timeoutAt,
      })
      .returning();
    assert.ok(instance);
    assert.deepEqual(parseBrowserOwnerWindows(instance.windows), {});
    await assert.rejects(
      client.query(
        "INSERT INTO browser_owner_instances (owner_profile_id, status, creation_expires_at, timeout_at) VALUES ($1, 'creating', $2, $3)",
        [profileId, creationExpiresAt, timeoutAt],
      ),
      { code: "23505", constraint: "uq_browser_owner_instances_live_owner" },
    );
    await assert.rejects(
      client.query(
        "UPDATE browser_owner_instances SET status = 'unknown' WHERE id = $1",
        [instanceId],
      ),
      { code: "23514", constraint: "browser_owner_instances_status_check" },
    );
    await assert.rejects(
      client.query(
        "UPDATE browser_owner_instances SET status = 'active' WHERE id = $1",
        [instanceId],
      ),
      { code: "23514", constraint: "browser_owner_instances_provider_check" },
    );
    await assert.rejects(
      client.query(
        "UPDATE browser_owner_instances SET windows = '[]'::jsonb WHERE id = $1",
        [instanceId],
      ),
      { code: "23514", constraint: "browser_owner_instances_windows_check" },
    );

    await assert.rejects(
      client.query("DELETE FROM browser_owner_profiles WHERE id = $1", [
        profileId,
      ]),
      { code: "23503" },
    );

    await db
      .update(browserOwnerInstances)
      .set({ status: "stopped" })
      .where(eq(browserOwnerInstances.id, instanceId));
    const windows: BrowserOwnerWindows = {
      [windowSessionId]: {
        chatThreadId,
        state: "active",
        expiresAt: timeoutAt.getTime(),
        primaryWindowId: 0,
        auxiliaryWindowIds: [1, 2],
      },
    };
    await db.insert(browserOwnerInstances).values({
      id: replacementId,
      ownerProfileId: profileId,
      status: "active",
      providerSessionId: randomUUID(),
      windows,
      creationExpiresAt,
      timeoutAt,
    });
    await db
      .delete(browserOwnerInstances)
      .where(eq(browserOwnerInstances.id, instanceId));
    const surviving = await db
      .select({
        id: browserOwnerInstances.id,
        windows: browserOwnerInstances.windows,
      })
      .from(browserOwnerInstances)
      .where(inArray(browserOwnerInstances.id, [instanceId, replacementId]));
    assert.equal(surviving.length, 1);
    assert.equal(surviving[0]?.id, replacementId);
    assert.deepEqual(parseBrowserOwnerWindows(surviving[0]?.windows), windows);

    const column = z
      .object({ is_nullable: z.literal("YES") })
      .parse(
        (
          await client.query(
            "SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'browser_user_action_requests' AND column_name = 'window_session_id'",
          )
        ).rows[0],
      );
    assert.equal(column.is_nullable, "YES");
    // Frozen outgoing ORM column lists stay legal while the additive nullable
    // identity ships. Remove transition-only proof with #42932 after its gate.
    await client.query(`PREPARE outgoing_browser_input_read(uuid) AS
      SELECT request_token_hash, org_id, user_id, agent_id, chat_thread_id,
        status, provider_session_id, payload, apply_started_at, completed_at
      FROM browser_user_action_requests WHERE provider_session_id = $1`);
    await client.query("DEALLOCATE outgoing_browser_input_read");
    await client.query(`PREPARE outgoing_browser_input_write AS
      INSERT INTO browser_user_action_requests (request_token_hash, org_id,
        user_id, agent_id, chat_thread_id, status, provider_session_id, payload,
        apply_started_at, completed_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING request_token_hash, org_id, user_id, agent_id, chat_thread_id,
        status, provider_session_id, payload, apply_started_at, completed_at`);
    await client.query("DEALLOCATE outgoing_browser_input_write");
  } finally {
    await db
      .delete(browserOwnerInstances)
      .where(inArray(browserOwnerInstances.id, [instanceId, replacementId]));
    await db
      .delete(browserOwnerProfiles)
      .where(eq(browserOwnerProfiles.id, profileId));
    await client.end();
  }
}
