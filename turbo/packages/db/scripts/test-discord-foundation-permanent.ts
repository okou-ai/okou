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
  const guildA = `guild-a-${suffix}`;
  const guildB = `guild-b-${suffix}`;
  const orgA = `org-a-${suffix}`;
  const orgB = `org-b-${suffix}`;
  const userA = `user-a-${suffix}`;
  const userB = `user-b-${suffix}`;
  const senderA = `sender-a-${suffix}`;
  const senderB = `sender-b-${suffix}`;
  const agentId = randomUUID();
  const connections = [randomUUID(), randomUUID(), randomUUID()] as const;
  const threads = [randomUUID(), randomUUID(), randomUUID()] as const;
  const routes = [randomUUID(), randomUUID(), randomUUID()] as const;
  const ingress = [randomUUID(), randomUUID(), randomUUID()] as const;
  const contexts = [randomUUID(), randomUUID(), randomUUID()] as const;
  const unassignedIngress = randomUUID();

  async function rejectWrite(
    query: string,
    values: readonly unknown[],
    code: string,
    constraint: string,
  ) {
    await client.query("SAVEPOINT rejected_discord_write");
    await assert.rejects(client.query(query, [...values]), {
      code,
      constraint,
    });
    await client.query("ROLLBACK TO SAVEPOINT rejected_discord_write");
  }

  async function countIds(table: string, ids: readonly string[]) {
    const result = await client.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM "${table}" WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    return result.rows[0]?.count;
  }

  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO discord_org_installations (guild_id, org_id, bot_user_id)
       VALUES ($1, $2, 'bot'), ($3, $4, 'bot')`,
      [guildA, orgA, guildB, orgB],
    );
    await rejectWrite(
      `INSERT INTO discord_org_installations (guild_id, org_id, bot_user_id)
       VALUES ('duplicate-org', $1, 'bot')`,
      [orgA],
      "23505",
      "uq_discord_org_installations_org",
    );
    await client.query(
      `INSERT INTO discord_org_connections (id, guild_id, discord_user_id, user_id)
       VALUES ($1, $2, $3, $4), ($5, $2, $6, $7), ($8, $9, $3, $4)`,
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
      ],
    );
    await rejectWrite(
      `INSERT INTO discord_org_connections (guild_id, discord_user_id, user_id)
       VALUES ($1, $2, 'another-user')`,
      [guildA, senderA],
      "23505",
      "uq_discord_org_connections_guild_sender",
    );
    await rejectWrite(
      `INSERT INTO discord_org_connections (guild_id, discord_user_id, user_id)
       VALUES ($1, 'another-sender', $2)`,
      [guildA, userA],
      "23505",
      "uq_discord_org_connections_guild_user",
    );
    await client.query(
      `INSERT INTO agents (id, org_id, owner, name) VALUES ($1, $2, $3, 'discord-test')`,
      [agentId, orgA, userA],
    );
    await client.query(
      `INSERT INTO discord_user_agent_preferences (user_id, org_id, connection_id, selected_agent_id)
       VALUES ($1, $2, $3, $4)`,
      [userA, orgA, connections[0], agentId],
    );
    await rejectWrite(
      `UPDATE discord_user_agent_preferences SET user_id = $1 WHERE connection_id = $2`,
      [userB, connections[0]],
      "23503",
      "discord_user_agent_preferences_connection_owner_fk",
    );
    await client.query("DELETE FROM agents WHERE id = $1", [agentId]);
    assert.deepEqual(
      (
        await client.query(
          `SELECT selected_agent_id FROM discord_user_agent_preferences WHERE connection_id = $1`,
          [connections[0]],
        )
      ).rows,
      [{ selected_agent_id: null }],
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
        `INSERT INTO discord_chat_ingress (id, connection_id, route_id, event_id, message_id, payload, public_brand)
         VALUES ($1, $2, $3, $4, $5, '{}', 'okou')`,
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
           bot_user_id, public_brand, message_text, sender_user_id, channel_type, destination_channel_id
         ) VALUES ($1, $2, $3, $4, 'channel', $5, 'bot', 'okou', 'hello', $6, 'thread', 'destination')`,
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
      CREATE TABLE discord_ingress_owner_probe (
        ingress_id uuid NOT NULL,
        connection_id uuid NOT NULL,
        CONSTRAINT discord_ingress_owner_probe_fk
          FOREIGN KEY (ingress_id, connection_id)
          REFERENCES discord_chat_ingress(id, connection_id) ON DELETE CASCADE
      )
    `);
    await rejectWrite(
      `INSERT INTO discord_ingress_owner_probe VALUES ($1, $2)`,
      [ingress[0], connections[1]],
      "23503",
      "discord_ingress_owner_probe_fk",
    );
    await client.query(
      `INSERT INTO discord_ingress_owner_probe VALUES ($1, $2)`,
      [ingress[0], connections[0]],
    );
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
      `INSERT INTO discord_chat_ingress (id, connection_id, event_id, message_id, payload, public_brand)
       VALUES ($1, $2, $3, $4, '{}', 'okou')`,
      [
        unassignedIngress,
        connections[0],
        `event-${unassignedIngress}`,
        `message-${unassignedIngress}`,
      ],
    );
    await client.query(
      `INSERT INTO discord_ingress_owner_probe VALUES ($1, $2)`,
      [unassignedIngress, connections[0]],
    );
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
      (await client.query("SELECT ingress_id FROM discord_ingress_owner_probe"))
        .rows,
      [],
    );
    assert.equal(await countIds("chat_threads", threads), 3);
    assert.deepEqual(
      (
        await client.query(
          `SELECT user_id FROM discord_user_agent_preferences WHERE user_id = $1`,
          [userA],
        )
      ).rows,
      [],
    );
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

    // Canonical thread erasure also removes ingress/context without revoking the binding.
    await client.query("DELETE FROM chat_threads WHERE id = $1", [threads[2]]);
    assert.equal(await countIds("discord_chat_thread_routes", routes), 0);
    assert.equal(await countIds("discord_chat_ingress", ingress), 0);
    assert.equal(await countIds("chat_discord_context", contexts), 0);
    assert.equal(await countIds("discord_org_connections", connections), 1);
    console.log(
      "Discord foundation ownership, dedupe, claim and erasure invariants passed",
    );
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
}
