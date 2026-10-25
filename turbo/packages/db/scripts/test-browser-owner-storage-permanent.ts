import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { z } from "zod";
import {
  browserOwnerInstances,
  browserOwnerProfiles,
  browserPageOwnership,
} from "../src/schema/browser-owner";
import { parseBrowserOwnerWindows } from "../src/jsonb-contracts/browser-owner";

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
  const generation = randomUUID();
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

    const page = {
      instanceId,
      targetId: "owned-page",
      windowGeneration: generation,
      chatThreadId,
      nativeWindowId: 1,
    };
    await db.insert(browserPageOwnership).values(page);
    await assert.rejects(
      client.query(
        "INSERT INTO browser_page_ownership (instance_id, target_id, window_generation, chat_thread_id, native_window_id) VALUES ($1, $2, $3, $4, 2)",
        [instanceId, page.targetId, randomUUID(), randomUUID()],
      ),
      {
        code: "23505",
        constraint: "browser_page_ownership_instance_id_target_id_pk",
      },
    );
    await assert.rejects(
      client.query(
        "UPDATE browser_page_ownership SET native_window_id = 0 WHERE instance_id = $1",
        [instanceId],
      ),
      {
        code: "23514",
        constraint: "browser_page_ownership_native_window_check",
      },
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
    await db.insert(browserOwnerInstances).values({
      id: replacementId,
      ownerProfileId: profileId,
      status: "creating",
      creationExpiresAt,
      timeoutAt,
    });
    await db
      .insert(browserPageOwnership)
      .values({ ...page, instanceId: replacementId });
    await db
      .delete(browserOwnerInstances)
      .where(eq(browserOwnerInstances.id, instanceId));
    const surviving = await db
      .select({ instanceId: browserPageOwnership.instanceId })
      .from(browserPageOwnership)
      .where(
        inArray(browserPageOwnership.instanceId, [instanceId, replacementId]),
      );
    assert.deepEqual(surviving, [{ instanceId: replacementId }]);

    const column = z
      .object({ is_nullable: z.literal("YES") })
      .parse(
        (
          await client.query(
            "SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'browser_user_action_requests' AND column_name = 'window_generation'",
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
