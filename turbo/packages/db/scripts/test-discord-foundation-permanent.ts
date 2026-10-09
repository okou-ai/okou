import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

/** Exercise the live schema, both after historical replay and fresh generation. */
export async function validatePermanentDiscordFoundation(
  databaseUrl: string,
): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  const suffix = randomUUID();
  const probeTable = `discord_ingress_owner_probe_${suffix.replaceAll("-", "")}`;
  const guildA = `guild-a-${suffix.slice(0, 8)}`;
  const guildB = `guild-b-${suffix.slice(0, 8)}`;
  const orgA = `org-a-${suffix}`;
  const orgB = `org-b-${suffix}`;
  const userA = `user-a-${suffix}`;
  const userB = `user-b-${suffix}`;
  const senderA = `sender-a-${suffix.slice(0, 8)}`;
  const senderB = `sender-b-${suffix.slice(0, 8)}`;
  const installationGrants = [randomUUID(), randomUUID()] as const;
  const replacementGrant = randomUUID();
  const connections = [randomUUID(), randomUUID(), randomUUID()] as const;
  const threads = [randomUUID(), randomUUID(), randomUUID()] as const;
  const routes = [randomUUID(), randomUUID(), randomUUID()] as const;
  const ingress = [randomUUID(), randomUUID(), randomUUID()] as const;
  const contexts = [randomUUID(), randomUUID(), randomUUID()] as const;
  const unassignedIngress = randomUUID();

  async function rejectWrite(
    query: string,
    values: readonly unknown[],
    code: string | RegExp,
    constraint: string,
  ) {
    await assert.rejects(client.query(query, [...values]), {
      code,
      constraint,
    });
  }

  async function countIds(table: string, ids: readonly string[]) {
    const result = await client.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM "${table}" WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    return result.rows[0]?.count;
  }

  try {
    await client.query(
      `WITH consent AS (
         INSERT INTO discord_org_grants (id, org_id, initiated_by_user_id, verified_guild_id, verified_bot_user_id, approved_at, expires_at)
         VALUES ($5, $2, $7, $1, 'bot', now(), now() + interval '10 minutes'),
                ($6, $4, $7, $3, 'bot', now(), now() + interval '10 minutes')
         RETURNING id, org_id, initiated_by_user_id, verified_guild_id, verified_bot_user_id, approved_at
       ) INSERT INTO discord_org_installations (guild_id, org_id, bot_user_id, installed_by_user_id, org_grant_id, created_at)
         SELECT verified_guild_id, org_id, verified_bot_user_id, initiated_by_user_id, id, approved_at FROM consent`,
      [guildA, orgA, guildB, orgB, ...installationGrants, userA],
    );
    await rejectWrite(
      `INSERT INTO discord_org_installations (guild_id, org_id, bot_user_id, org_grant_id)
       VALUES ('duplicate-org', $1, 'bot', $2)`,
      [orgA, installationGrants[0]],
      "23505",
      "uq_discord_org_installations_org",
    );
    await rejectWrite(
      `INSERT INTO discord_org_connections (guild_id, discord_user_id, user_id, oauth_grant_id)
       VALUES ($1, 'unowned-sender', 'unowned-user', $2)`,
      [guildA, randomUUID()],
      "23503",
      "fk_discord_connection_oauth_grant",
    );
    await client.query(
      `WITH consent AS (
         INSERT INTO discord_oauth_states (id, state_hash, completion_token_hash, phase, user_id, org_id, flow, redirect_uri, verified_guild_id, verified_guild_name, verified_discord_user_id, verified_bot_user_id, expires_at)
         SELECT id, id::text, NULL, 'approved', user_id, org_id, 'connect', 'https://example.test/callback', guild_id, 'guild', sender_id, 'bot', now() + interval '10 minutes'
         FROM (VALUES ($1::uuid, $4::text, $10::text, $2::text, $3::text),
                      ($5, $7, $10, $2, $6), ($8, $4, $11, $9, $3), ($12, $7, $11, $9, $3))
           AS evidence(id, user_id, org_id, guild_id, sender_id)
         RETURNING id, user_id, verified_guild_id, verified_discord_user_id
       ) INSERT INTO discord_org_connections (id, guild_id, discord_user_id, user_id, oauth_grant_id)
         SELECT id, verified_guild_id, verified_discord_user_id, user_id, id FROM consent WHERE id <> $12`,
      [
        connections[0],
        guildA,
        senderA,
        userA,
        connections[1],
        senderB,
        userB,
        connections[2],
        guildB,
        orgA,
        orgB,
        replacementGrant,
      ],
    );
    await rejectWrite(
      `INSERT INTO discord_org_connections (guild_id, discord_user_id, user_id, oauth_grant_id)
       VALUES ($1, $2, 'another-user', $3)`,
      [guildA, senderA, connections[0]],
      "23505",
      "uq_discord_org_connections_guild_sender",
    );
    await rejectWrite(
      `INSERT INTO discord_org_connections (guild_id, discord_user_id, user_id, oauth_grant_id)
       VALUES ($1, 'another-sender', $2, $3)`,
      [guildA, userA, connections[0]],
      "23505",
      "uq_discord_org_connections_guild_user",
    );
    await rejectWrite(
      `UPDATE discord_org_connections SET user_id = $1 WHERE id = $2`,
      [userB, connections[2]],
      "23P01",
      "ex_discord_connections_global_sender_owner",
    );
    await client.query(
      `INSERT INTO discord_user_dm_preferences (discord_user_id, connection_id, user_id)
       VALUES ($1, $2, $3)`,
      [senderA, connections[0], userA],
    );
    await rejectWrite(
      `UPDATE discord_user_dm_preferences SET connection_id = $1 WHERE discord_user_id = $2`,
      [connections[1], senderA],
      "23503",
      "discord_user_dm_preferences_sender_owner_fk",
    );
    await rejectWrite(
      `UPDATE discord_user_dm_preferences SET user_id = $1 WHERE discord_user_id = $2`,
      [userB, senderA],
      "23503",
      "discord_user_dm_preferences_sender_owner_fk",
    );
    // A sender can explicitly select either of their verified organizations.
    await client.query(
      `UPDATE discord_user_dm_preferences SET connection_id = $1 WHERE discord_user_id = $2`,
      [connections[2], senderA],
    );
    await client.query(
      `UPDATE discord_user_dm_preferences SET connection_id = $1 WHERE discord_user_id = $2`,
      [connections[0], senderA],
    );
    for (const [i, connection] of connections.entries()) {
      const userId = i === 1 ? userB : userA;
      await client.query(
        `INSERT INTO chat_threads (id, user_id) VALUES ($1, $2)`,
        [threads[i], userId],
      );
      await client.query(
        `INSERT INTO discord_chat_thread_routes (id, connection_id, channel_id, session_key, user_id, chat_thread_id)
         VALUES ($1, $2, 'channel', 'thread', $3, $4)`,
        [routes[i], connection, userId, threads[i]],
      );
      await client.query(
        `INSERT INTO discord_chat_ingress (id, connection_id, route_id, event_id, message_id, payload)
         VALUES ($1, $2, $3, $4, $5, '{}')`,
        [
          ingress[i],
          connection,
          routes[i],
          `event-${ingress[i]}`,
          `message-${ingress[i]}`,
        ],
      );
      await client.query(
        `INSERT INTO chat_discord_context (
           id, connection_id, route_id, chat_thread_id, channel_id, message_id,
           bot_user_id, message_text, sender_user_id, channel_type, destination_channel_id
         ) VALUES ($1, $2, $3, $4, 'channel', $5, 'bot', 'hello', $6, 'thread', 'destination')`,
        [
          contexts[i],
          connection,
          routes[i],
          threads[i],
          `message-${ingress[i]}`,
          i === 1 ? senderB : senderA,
        ],
      );
    }
    // Downstream delivery tables can reference ingress ownership before a route exists.
    await client.query(`
      CREATE TABLE "${probeTable}" (
        ingress_id uuid NOT NULL,
        connection_id uuid NOT NULL,
        CONSTRAINT discord_ingress_owner_probe_fk
          FOREIGN KEY (ingress_id, connection_id)
          REFERENCES discord_chat_ingress(id, connection_id) ON DELETE CASCADE
      )
    `);
    await rejectWrite(
      `INSERT INTO "${probeTable}" VALUES ($1, $2)`,
      [ingress[0], connections[1]],
      "23503",
      "discord_ingress_owner_probe_fk",
    );
    await client.query(`INSERT INTO "${probeTable}" VALUES ($1, $2)`, [
      ingress[0],
      connections[0],
    ]);
    await rejectWrite(
      `INSERT INTO discord_chat_thread_routes (connection_id, channel_id, session_key, user_id, chat_thread_id)
       VALUES ($1, 'channel', 'thread', $2, $3)`,
      [connections[0], userA, threads[0]],
      "23505",
      "uq_discord_chat_thread_routes_session",
    );
    await rejectWrite(
      `INSERT INTO discord_chat_thread_routes (connection_id, channel_id, session_key, user_id, chat_thread_id)
       VALUES ($1, 'channel', 'forged-connection', $2, $3)`,
      [connections[1], userA, threads[0]],
      "23503",
      "discord_chat_thread_routes_connection_owner_fk",
    );
    await rejectWrite(
      `INSERT INTO discord_chat_thread_routes (connection_id, channel_id, session_key, user_id, chat_thread_id)
       VALUES ($1, 'channel', 'forged-chat', $2, $3)`,
      [connections[0], userA, threads[1]],
      "23503",
      "discord_chat_thread_routes_chat_owner_fk",
    );
    await rejectWrite(
      `UPDATE discord_chat_ingress SET route_id = $1 WHERE id = $2`,
      [routes[1], ingress[0]],
      "23503",
      "discord_chat_ingress_route_connection_fk",
    );
    await rejectWrite(
      `UPDATE chat_discord_context SET chat_thread_id = $1 WHERE id = $2`,
      [threads[1], contexts[0]],
      "23503",
      "chat_discord_context_route_owner_fk",
    );
    await rejectWrite(
      `UPDATE discord_chat_ingress SET event_id = $1 WHERE id = $2`,
      [`event-${ingress[0]}`, ingress[1]],
      "23505",
      "uq_discord_chat_ingress_event",
    );
    await rejectWrite(
      `UPDATE discord_chat_ingress SET message_id = $1 WHERE id = $2`,
      [`message-${ingress[0]}`, ingress[1]],
      "23505",
      "uq_discord_chat_ingress_message",
    );
    await rejectWrite(
      `UPDATE discord_chat_ingress SET status = 'processing' WHERE id = $1`,
      [ingress[0]],
      "23514",
      "chk_discord_chat_ingress_claim",
    );
    await client.query(
      `UPDATE discord_chat_ingress SET status = 'processing', claim_token = $1, claimed_at = now()
       WHERE id = $2`,
      [randomUUID(), ingress[0]],
    );
    await rejectWrite(
      `UPDATE discord_chat_ingress SET status = 'processed' WHERE id = $1`,
      [ingress[0]],
      "23514",
      "chk_discord_chat_ingress_claim",
    );
    await client.query(
      `UPDATE discord_chat_ingress SET status = 'processed', claim_token = NULL, claimed_at = NULL
       WHERE id = $1`,
      [ingress[0]],
    );
    await client.query(
      `INSERT INTO discord_chat_ingress (id, connection_id, event_id, message_id, payload)
       VALUES ($1, $2, $3, $4, '{}')`,
      [
        unassignedIngress,
        connections[0],
        `event-${unassignedIngress}`,
        `message-${unassignedIngress}`,
      ],
    );
    await client.query(`INSERT INTO "${probeTable}" VALUES ($1, $2)`, [
      unassignedIngress,
      connections[0],
    ]);
    await client.query("DELETE FROM discord_org_connections WHERE id = $1", [
      connections[0],
    ]);
    assert.equal(await countIds("discord_chat_thread_routes", [routes[0]]), 0);
    assert.equal(
      await countIds("discord_chat_ingress", [ingress[0], unassignedIngress]),
      0,
    );
    assert.equal(await countIds("chat_discord_context", [contexts[0]]), 0);
    assert.deepEqual(
      (await client.query(`SELECT ingress_id FROM "${probeTable}"`)).rows,
      [],
    );
    assert.equal(await countIds("chat_threads", threads), 3);
    assert.deepEqual(
      (
        await client.query(
          `SELECT discord_user_id FROM discord_user_dm_preferences WHERE discord_user_id = $1`,
          [senderA],
        )
      ).rows,
      [],
    );
    assert.equal(await countIds("discord_org_connections", connections), 2);
    assert.equal(await countIds("discord_chat_ingress", ingress), 2);

    // Guild uninstall removes that guild's owned descendants, preserving another guild.
    await client.query(
      "DELETE FROM discord_org_installations WHERE guild_id = $1",
      [guildA],
    );
    assert.equal(await countIds("discord_org_connections", connections), 1);
    assert.equal(await countIds("discord_chat_thread_routes", routes), 1);
    assert.equal(await countIds("discord_chat_ingress", ingress), 1);
    assert.equal(await countIds("chat_discord_context", contexts), 1);
    assert.deepEqual(
      (
        await client.query(
          "SELECT guild_id FROM discord_org_installations WHERE guild_id = $1",
          [guildB],
        )
      ).rows,
      [{ guild_id: guildB }],
    );

    // Canonical thread deletion also removes ingress/context without revoking the binding.
    await client.query("DELETE FROM chat_threads WHERE id = $1", [threads[2]]);
    assert.equal(await countIds("discord_chat_thread_routes", routes), 0);
    assert.equal(await countIds("discord_chat_ingress", ingress), 0);
    assert.equal(await countIds("chat_discord_context", contexts), 0);
    assert.equal(await countIds("discord_org_connections", connections), 1);
    // Ownership remains reserved by the surviving other-guild connection.
    await rejectWrite(
      `INSERT INTO discord_org_connections (guild_id, discord_user_id, user_id, oauth_grant_id) VALUES ($1, $2, $3, $4)`,
      [guildB, senderA, userB, replacementGrant],
      "23505",
      "uq_discord_org_connections_guild_sender",
    );
    await client.query("DELETE FROM discord_org_connections WHERE id = $1", [
      connections[2],
    ]);
    // Deleting the last actual connection releases authority in that same write.
    await client.query(
      `INSERT INTO discord_org_connections (guild_id, discord_user_id, user_id, oauth_grant_id) VALUES ($1, $2, $3, $4)`,
      [guildB, senderA, userB, replacementGrant],
    );
    assert.deepEqual(
      (
        await client.query(
          `SELECT user_id FROM discord_org_connections WHERE guild_id = $1 AND discord_user_id = $2`,
          [guildB, senderA],
        )
      ).rows,
      [{ user_id: userB }],
    );
    console.log(
      "Discord foundation ownership, dedupe, claim and deletion invariants passed",
    );
  } finally {
    try {
      await client.query(`DROP TABLE IF EXISTS "${probeTable}"`);
      await client.query(
        "DELETE FROM discord_oauth_states WHERE id = ANY($1::uuid[])",
        [[...connections, replacementGrant]],
      );
      await client.query(
        "DELETE FROM discord_org_grants WHERE id = ANY($1::uuid[])",
        [installationGrants],
      );
      await client.query(
        "DELETE FROM chat_threads WHERE id = ANY($1::uuid[])",
        [threads],
      );
    } finally {
      await client.end();
    }
  }
}
