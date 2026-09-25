import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

/** Validate delivery ownership against both replayed and freshly generated schema. */
export async function validatePermanentDiscordChat(
  databaseUrl: string,
): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const suffix = randomUUID();
  const guild = `discord-chat-guild-${suffix}`;
  const org = `discord-chat-org-${suffix}`;
  const userA = `discord-chat-user-a-${suffix}`;
  const userB = `discord-chat-user-b-${suffix}`;
  const connectionA = randomUUID();
  const connectionB = randomUUID();
  const threadA = randomUUID();
  const threadB = randomUUID();
  const routeA = randomUUID();
  const routeB = randomUUID();
  const eventId = randomUUID();
  const ingressId = randomUUID();
  const eventDelivery = randomUUID();
  const ingressDelivery = randomUUID();
  const receiptDigest = suffix.replaceAll("-", "").repeat(2);

  async function rejectWrite(
    query: string,
    values: readonly string[],
    code: string,
    constraint: string,
  ): Promise<void> {
    await client.query("SAVEPOINT rejected_discord_delivery");
    await assert.rejects(client.query(query, [...values]), {
      code,
      constraint,
    });
    await client.query("ROLLBACK TO SAVEPOINT rejected_discord_delivery");
  }

  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO discord_org_installations (guild_id, org_id, bot_user_id)
       VALUES ($1, $2, 'bot')`,
      [guild, org],
    );
    await client.query(
      `INSERT INTO discord_org_connections (id, guild_id, discord_user_id, user_id)
       VALUES ($1, $2, 'sender-a', $3), ($4, $2, 'sender-b', $5)`,
      [connectionA, guild, userA, connectionB, userB],
    );
    await client.query(
      `INSERT INTO chat_threads (id, user_id) VALUES ($1, $3), ($2, $3)`,
      [threadA, threadB, userA],
    );
    await client.query(
      `INSERT INTO discord_chat_thread_routes
       (id, connection_id, channel_id, session_key, user_id, chat_thread_id)
       VALUES ($1, $2, 'channel', 'thread-a', $3, $4),
              ($5, $2, 'channel', 'thread-b', $3, $6)`,
      [routeA, connectionA, userA, threadA, routeB, threadB],
    );
    await client.query(
      `INSERT INTO chat_events (id, chat_thread_id, event_type, payload, seq_id)
       VALUES ($1, $2, 'output.message', '{"content":"Reply"}'::jsonb, 1)`,
      [eventId, threadA],
    );
    await client.query(
      `INSERT INTO discord_chat_ingress
       (id, connection_id, event_id, message_id, payload)
       VALUES ($1, $2, $3, $3, '{}')`,
      [ingressId, connectionA, `event-${suffix}`],
    );
    await client.query(
      `INSERT INTO discord_chat_deliveries
       (id, connection_id, chat_event_id, chat_thread_id, route_id,
        org_id, user_id, channel_id, content)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'channel', 'Reply')`,
      [eventDelivery, connectionA, eventId, threadA, routeA, org, userA],
    );
    await client.query(
      `INSERT INTO discord_chat_deliveries
       (id, connection_id, ingress_id, org_id, user_id, channel_id, content)
       VALUES ($1, $2, $3, $4, $5, 'channel', 'Admission failed')`,
      [ingressDelivery, connectionA, ingressId, org, userA],
    );

    // A different valid route cannot relabel an existing event's thread.
    await rejectWrite(
      `UPDATE discord_chat_deliveries SET chat_thread_id = $1, route_id = $2
       WHERE id = $3`,
      [threadB, routeB, eventDelivery],
      "23503",
      "discord_chat_deliveries_event_thread_fk",
    );
    await rejectWrite(
      "UPDATE discord_chat_deliveries SET user_id = $1 WHERE id = $2",
      [userB, eventDelivery],
      "23503",
      "discord_chat_deliveries_connection_owner_fk",
    );
    await rejectWrite(
      `UPDATE discord_chat_deliveries SET connection_id = $1, user_id = $2
       WHERE id = $3`,
      [connectionB, userB, ingressDelivery],
      "23503",
      "discord_chat_deliveries_ingress_owner_fk",
    );
    await rejectWrite(
      "UPDATE discord_chat_deliveries SET chat_event_id = NULL WHERE id = $1",
      [eventDelivery],
      "23514",
      "discord_chat_deliveries_source_check",
    );
    await rejectWrite(
      "UPDATE discord_chat_deliveries SET status = 'unsupported' WHERE id = $1",
      [eventDelivery],
      "23514",
      "discord_chat_deliveries_status_check",
    );
    await client.query(
      "UPDATE discord_chat_deliveries SET status = 'suppressed' WHERE id = $1",
      [eventDelivery],
    );
    await client.query("DELETE FROM chat_events WHERE id = $1", [eventId]);
    assert.deepEqual(
      (
        await client.query(
          "SELECT id FROM discord_chat_deliveries WHERE id = $1",
          [eventDelivery],
        )
      ).rows,
      [],
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
          "SELECT id FROM discord_chat_deliveries WHERE id = $1",
          [ingressDelivery],
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
    console.log(
      "Discord delivery ownership, cascades and durable receipts passed",
    );
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
}
