import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

/** Feed ownership and suggestion-state constraints on both schema construction paths. */
export async function validateFeedItemStorage(databaseUrl: string) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const orgId = `feed-storage-${randomUUID()}`;
  const userId = randomUUID();
  const id = randomUUID();
  const feedback = {
    id: randomUUID(),
    kind: "already_done",
    createdAt: "2026-11-13T00:00:00.000Z",
    learnedAt: null,
    targetId: null,
    note: "Handled",
    context: {
      title: "Review",
      rationale: "Pending decision",
      optionLabel: null,
    },
  };
  const state = { status: "active", selectedOptionId: null, feedbacks: [] };
  try {
    await client.query(
      `INSERT INTO feed_items (org_id, user_id, id, type, content, state, created_at, updated_at, expires_at)
       VALUES ($1, $2, $3, 'suggestion', $4, $5, now(), now(), now() + interval '1 day')`,
      [orgId, userId, id, { title: "Review" }, state],
    );
    // The same stable identity is independently owned in another workspace.
    await client.query(
      `INSERT INTO feed_items (org_id, user_id, id, type, priority, content, state, created_at, updated_at, expires_at) SELECT $1, user_id, id, type, priority, content, state, created_at, updated_at, expires_at
       FROM feed_items WHERE org_id = $2 AND user_id = $3 AND id = $4`,
      [`${orgId}-other`, orgId, userId, id],
    );
    await assert.rejects(
      client.query("UPDATE feed_items SET content = NULL WHERE org_id = $1", [
        orgId,
      ]),
      { code: "23514", constraint: "feed_items_suggestion_content" },
    );
    await assert.rejects(
      client.query(
        "UPDATE feed_items SET expires_at = NULL WHERE org_id = $1",
        [orgId],
      ),
      { code: "23514", constraint: "feed_items_suggestion_expiry" },
    );
    await assert.rejects(
      client.query("UPDATE feed_items SET state = $1 WHERE org_id = $2", [
        { status: "consumed", feedbacks: [] },
        orgId,
      ]),
      { code: "23514", constraint: "feed_items_suggestion_state" },
    );
    const retained = {
      status: "consumed",
      selectedOptionId: null,
      feedbacks: [feedback],
    };
    await client.query(
      "UPDATE feed_items SET state = $1, content = NULL WHERE org_id = $2",
      [retained, orgId],
    );
    const compacted = await client.query(
      "SELECT state, content FROM feed_items WHERE org_id = $1",
      [orgId],
    );
    assert.deepEqual(compacted.rows, [{ state: retained, content: null }]);
    await assert.rejects(
      client.query("UPDATE feed_items SET state = $1 WHERE org_id = $2", [
        {
          ...retained,
          feedbacks: Array.from({ length: 101 }, () => {
            return feedback;
          }),
        },
        orgId,
      ]),
      { code: "23514", constraint: "feed_items_suggestion_state" },
    );
  } finally {
    await client.query("DELETE FROM feed_items WHERE org_id IN ($1, $2)", [
      orgId,
      `${orgId}-other`,
    ]);
    await client.end();
  }
}
