import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

/** Validate Discord ownership cascades against both replayed and freshly generated schema. */
export async function validatePermanentDiscordChat(
  databaseUrl: string,
): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const suffix = randomUUID();
  const guild = `discord-chat-guild-${suffix}`;
  const org = `discord-chat-org-${suffix}`;
  const user = `discord-chat-user-${suffix}`;
  const connection = randomUUID();
  const thread = randomUUID();
  const route = randomUUID();
  const ingress = randomUUID();
  const receiptDigest = suffix.replaceAll("-", "").repeat(2);

  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO discord_org_installations (guild_id, org_id, bot_user_id)
       VALUES ($1, $2, 'bot')`,
      [guild, org],
    );
    await client.query(
      `INSERT INTO discord_org_connections (id, guild_id, discord_user_id, user_id)
       VALUES ($1, $2, 'sender', $3)`,
      [connection, guild, user],
    );
    await client.query(
      "INSERT INTO chat_threads (id, user_id) VALUES ($1, $2)",
      [thread, user],
    );
    await client.query(
      `INSERT INTO discord_chat_thread_routes
       (id, connection_id, channel_id, session_key, user_id, chat_thread_id)
       VALUES ($1, $2, 'channel', 'thread', $3, $4)`,
      [route, connection, user, thread],
    );
    await client.query(
      `INSERT INTO discord_chat_ingress
       (id, connection_id, event_id, message_id, payload)
       VALUES ($1, $2, $3, $3, '{}')`,
      [ingress, connection, `event-${suffix}`],
    );
    await client.query(
      "INSERT INTO discord_gateway_receipts (event_digest) VALUES ($1)",
      [receiptDigest],
    );
    await client.query(
      "DELETE FROM discord_org_installations WHERE guild_id = $1",
      [guild],
    );
    assert.deepEqual(
      (
        await client.query(
          `SELECT id FROM discord_chat_thread_routes WHERE id = $1
           UNION ALL
           SELECT id FROM discord_chat_ingress WHERE id = $2`,
          [route, ingress],
        )
      ).rows,
      [],
    );
    assert.deepEqual(
      (
        await client.query(
          "SELECT event_digest FROM discord_gateway_receipts WHERE event_digest = $1",
          [receiptDigest],
        )
      ).rows,
      [{ event_digest: receiptDigest }],
    );
    console.log("Discord ownership cascades and durable receipts passed");
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
}
