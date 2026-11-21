import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { applyPendingMigrations } from "./migration-runner";

export async function validateWalletIntentUpgrade(url: string, when: number) {
  const sql = postgres(url, { max: 1 });
  const intent = randomUUID();
  const org = randomUUID();
  try {
    await applyPendingMigrations(sql, { beforeMillis: when });
    const original = await sql`
      WITH owners AS (
        INSERT INTO agents (id, org_id, owner, name)
        SELECT gen_random_uuid(), ${org}, 'wallet-member', 'wallet-' || n
        FROM generate_series(1, 2) n RETURNING id
      ), connections AS (
        INSERT INTO link_wallet_connections (org_id, user_id, agent_id, authorization_id)
        SELECT ${org}, 'wallet-member', id, gen_random_uuid() FROM owners
        RETURNING *
      )
      INSERT INTO link_wallet_spends (org_id, user_id, agent_id, connection_id, authorization_id,
        intent_id, provider_spend_id, amount, currency, merchant_name, merchant_url, context, test, expires_at)
      SELECT org_id, user_id, agent_id, id, authorization_id, ${intent}, gen_random_uuid()::text,
        100, 'usd', 'Books', 'https://example.test', 'test', true, now() FROM connections
      RETURNING id, provider_spend_id`;
    await applyPendingMigrations(sql, { beforeMillis: when + 1 });
    const migrated = await sql`
      SELECT id, provider_spend_id, historical_intent_ordinal FROM link_wallet_spends
      WHERE org_id = ${org} AND user_id = 'wallet-member' AND intent_id = ${intent}
      ORDER BY historical_intent_ordinal`;
    assert.deepEqual(
      migrated.map((row) => {
        return row.historical_intent_ordinal;
      }),
      [0, 1],
    );
    for (const row of original) {
      assert.ok(
        migrated.some((saved) => {
          return (
            saved.id === row.id &&
            saved.provider_spend_id === row.provider_spend_id
          );
        }),
      );
    }
  } finally {
    await sql.end();
  }
}
