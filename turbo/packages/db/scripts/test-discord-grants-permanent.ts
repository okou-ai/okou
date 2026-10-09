import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

/** Physical grant/FK invariants only; public API tests own user-lifecycle coverage. */
export async function validatePermanentDiscordGrants(
  databaseUrl: string,
): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const suffix = randomUUID();
  const id = randomUUID();
  const peerGrant = randomUUID();
  const org = `grant-org-${suffix}`;
  const actor = `grant-actor-${suffix}`;
  const peer = `grant-peer-${suffix}`;
  const guild = BigInt(
    `0x${suffix.replaceAll("-", "").slice(0, 15)}`,
  ).toString();
  const bot = "700000000000000001";
  const sender = "700000000000000002";
  const peerSender = "700000000000000003";
  const createdAt = new Date();
  try {
    assert.deepEqual(
      (
        await client.query(
          `SELECT contype FROM pg_constraint WHERE conname = 'ex_discord_connections_global_sender_owner' AND conrelid = 'discord_org_connections'::regclass`,
        )
      ).rows,
      [{ contype: "x" }],
    );
    await client.query(
      `INSERT INTO discord_org_grants (id, org_id, initiated_by_user_id, verified_guild_id, verified_bot_user_id, expires_at) VALUES ($1, $2, $3, $4, $5, now() + interval '10 minutes')`,
      [id, org, actor, guild, bot],
    );
    await client.query(
      `INSERT INTO discord_oauth_states (id, state_hash, completion_token_hash, phase, user_id, org_id, flow, redirect_uri, verified_guild_id, verified_guild_name, verified_discord_user_id, verified_bot_user_id, expires_at) VALUES ($1::uuid, $1::text, NULL, 'approved', $2, $3, 'install', 'https://example.test/callback', $4, 'guild', $5, $6, now() + interval '10 minutes')`,
      [id, actor, org, guild, sender, bot],
    );
    // PostgreSQL's immediate RI checks see the complete data-modifying statement:
    // the returned installation activates its exact grant later in the same CTE.
    await client.query(
      `WITH installed AS (
      INSERT INTO discord_org_installations (guild_id, org_id, bot_user_id, installed_by_user_id, org_grant_id, created_at)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING org_grant_id
    ), approved AS (
      UPDATE discord_org_grants SET approved_at = $6 WHERE id IN (SELECT org_grant_id FROM installed) RETURNING id
    ) INSERT INTO discord_org_connections (guild_id, discord_user_id, user_id, oauth_grant_id)
      SELECT $1, $7, $4, id FROM approved`,
      [guild, org, bot, actor, id, createdAt, sender],
    );
    await assert.rejects(
      client.query(
        `INSERT INTO discord_org_connections (guild_id, discord_user_id, user_id, oauth_grant_id) VALUES ($1, $2, $3, $4)`,
        [guild, peerSender, peer, id],
      ),
      { code: "23503", constraint: "fk_discord_connection_oauth_grant" },
    );
    await client.query(
      `INSERT INTO discord_oauth_states (id, state_hash, completion_token_hash, phase, user_id, org_id, flow, redirect_uri, verified_guild_id, verified_guild_name, verified_discord_user_id, verified_bot_user_id, expires_at) VALUES ($1::uuid, $1::text, NULL, 'approved', $2, $3, 'connect', 'https://example.test/callback', $4, 'guild', $5, $6, now() + interval '10 minutes')`,
      [peerGrant, peer, org, guild, peerSender, bot],
    );
    await client.query(
      `INSERT INTO discord_org_connections (guild_id, discord_user_id, user_id, oauth_grant_id) VALUES ($1, $2, $3, $4)`,
      [guild, peerSender, peer, peerGrant],
    );
    await client.query(
      `WITH personal AS (DELETE FROM discord_oauth_states WHERE user_id = $1 RETURNING id)
      UPDATE discord_org_grants SET initiated_by_user_id = NULL WHERE initiated_by_user_id = $1 AND (SELECT count(*) FROM personal) >= 0`,
      [actor],
    );
    assert.deepEqual(
      (
        await client.query(
          `SELECT installed_by_user_id, org_id FROM discord_org_installations WHERE guild_id = $1`,
          [guild],
        )
      ).rows,
      [{ installed_by_user_id: null, org_id: org }],
    );
    assert.deepEqual(
      (
        await client.query(
          `SELECT user_id FROM discord_org_connections WHERE guild_id = $1`,
          [guild],
        )
      ).rows,
      [{ user_id: peer }],
    );
    await client.query(`DELETE FROM discord_org_grants WHERE id = $1`, [id]);
    assert.deepEqual(
      (
        await client.query(
          `SELECT guild_id FROM discord_org_installations WHERE guild_id = $1`,
          [guild],
        )
      ).rows,
      [],
    );
    assert.deepEqual(
      (
        await client.query(
          `SELECT user_id FROM discord_org_connections WHERE guild_id = $1`,
          [guild],
        )
      ).rows,
      [],
    );
    console.log(
      "Discord consent provenance, installer anonymization and scoped cascades passed",
    );
  } finally {
    // Physical-schema fixtures have unique real identities and clean up through
    // their native cascades; no explicit non-billing transaction or savepoint.
    try {
      await client.query(
        `DELETE FROM discord_oauth_states WHERE id = ANY($1::uuid[])`,
        [[id, peerGrant]],
      );
      await client.query(`DELETE FROM discord_org_grants WHERE id = $1`, [id]);
    } finally {
      await client.end();
    }
  }
}
