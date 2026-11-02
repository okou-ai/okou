import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

/** Current invariants and the preceding account writer's complete column shape. */
export async function validateChatConnectorAccessSchema(
  databaseUrl: string,
): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const accountId = randomUUID();
  const agentId = randomUUID();
  const threadId = randomUUID();
  const grantId = randomUUID();
  const owner = `chat-access-${randomUUID()}`;
  try {
    await client.query(
      "INSERT INTO agents (id,org_id,owner,name) VALUES ($1,$2,$2,$3)",
      [agentId, owner, owner],
    );
    await client.query(
      "INSERT INTO chat_threads (id,user_id,agent_id) VALUES ($1,$2,$3)",
      [threadId, owner, agentId],
    );
    // Frozen outgoing ORM INSERT/RETURNING: the new field is omitted entirely.
    const preceding = await client.query(
      `INSERT INTO connectors
      (id,connector_slug,custom_connector_id,display_name,is_default,auth_method,automatic_auth_type,
       storage_version,external_id,external_username,external_email,oauth_scopes,oauth_granted_scopes,
       token_expires_at,user_id,org_id,needs_reconnect,reconnect_reason,created_at,updated_at)
      VALUES ($1,'schema-chat-access',NULL,'Schema account',true,'api-token',NULL,1,NULL,NULL,NULL,NULL,NULL,NULL,$2,$2,false,NULL,now(),now())
      RETURNING id,connector_slug,custom_connector_id,display_name,is_default,auth_method,automatic_auth_type,
       storage_version,external_id,external_username,external_email,oauth_scopes,oauth_granted_scopes,
       token_expires_at,user_id,org_id,needs_reconnect,reconnect_reason,created_at,updated_at`,
      [accountId, owner],
    );
    assert.equal(preceding.rows[0].id, accountId);
    assert.deepEqual(
      (
        await client.query(
          "SELECT default_enabled_for_chats,is_default FROM connectors WHERE id=$1",
          [accountId],
        )
      ).rows,
      [{ default_enabled_for_chats: true, is_default: true }],
    );
    await assert.rejects(
      client.query(
        "UPDATE connectors SET default_enabled_for_chats=false WHERE id=$1",
        [accountId],
      ),
      { code: "23514", constraint: "chk_connectors_default_enabled" },
    );
    await client.query(
      "INSERT INTO chat_thread_connector_access_overrides (chat_thread_id,connector_id,enabled) VALUES ($1,$2,false)",
      [threadId, accountId],
    );
    await client.query(
      "INSERT INTO connector_permission_grants (id,org_id,user_id,connector_slug,permission,action) VALUES ($1,$2,$2,'schema-chat-access','read','deny')",
      [grantId, owner],
    );
    await assert.rejects(
      client.query(
        "INSERT INTO connector_permission_grants (org_id,user_id,connector_slug,permission,action) VALUES ($1,$1,'schema-chat-access','read','allow')",
        [owner],
      ),
      { code: "23505", constraint: "uq_connector_permission_grants_builtin" },
    );
    await assert.rejects(
      client.query(
        "INSERT INTO connector_permission_grants (org_id,user_id,connector_slug,permission,action,expires_at) VALUES ($1,$1,'schema-chat-access','write','deny',now())",
        [owner],
      ),
      { code: "23514", constraint: "chk_connector_permission_grants_expiry" },
    );
    await client.query("DELETE FROM connectors WHERE id=$1", [accountId]);
    assert.deepEqual(
      (
        await client.query(
          "SELECT enabled FROM chat_thread_connector_access_overrides WHERE chat_thread_id=$1",
          [threadId],
        )
      ).rows,
      [],
    );
    // Member connector permissions outlive individual accounts and Chats.
    assert.equal(
      (
        await client.query(
          "SELECT id FROM connector_permission_grants WHERE id=$1",
          [grantId],
        )
      ).rows[0].id,
      grantId,
    );
    await client.query("DELETE FROM chat_threads WHERE id=$1", [threadId]);
    assert.deepEqual(
      (
        await client.query(
          "SELECT permission FROM connector_permission_grants WHERE id=$1",
          [grantId],
        )
      ).rows,
      [{ permission: "read" }],
    );
  } finally {
    await client.query("DELETE FROM agents WHERE id=$1", [agentId]);
    await client.query("DELETE FROM connectors WHERE id=$1", [accountId]);
    await client.query("DELETE FROM connector_permission_grants WHERE id=$1", [
      grantId,
    ]);
    await client.end();
  }
}
