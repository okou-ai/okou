import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

/** The operator's DB-only delivery format, on replayed and generated schemas. */
export async function validateUserNotificationStorage(databaseUrl: string) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const userId = `notification-user-${randomUUID()}`;
  const otherUser = `${userId}-other`;
  const payload = {
    type: "rich_text",
    markdown: "Hello\n\n![Overview](https://example.com/overview.png)",
  };
  try {
    const delivered = await client.query(
      "INSERT INTO user_notifications (user_id, title, summary, payload, delivery_key) VALUES ($1, $2, $3, $4, $5) RETURNING id, read_at",
      [userId, "An update", "A short summary", payload, "launch-1"],
    );
    assert.equal(delivered.rowCount, 1);
    assert.equal(delivered.rows[0].read_at, null);
    await assert.rejects(
      client.query(
        "INSERT INTO user_notifications (user_id, title, summary, payload, delivery_key) VALUES ($1, 'Repeat', '', $2, 'launch-1')",
        [userId, payload],
      ),
      { code: "23505", constraint: "uq_user_notifications_delivery" },
    );
    // The same announcement can be delivered to another user; unkeyed rows
    // remain independent deliveries rather than accidentally deduplicated.
    await client.query(
      "INSERT INTO user_notifications (user_id, title, summary, payload, delivery_key) VALUES ($1, 'Other recipient', '', $2, 'launch-1')",
      [otherUser, payload],
    );
    await client.query(
      "INSERT INTO user_notifications (user_id, title, summary, payload) VALUES ($1, 'First', '', $2), ($1, 'Second', '', $2)",
      [userId, payload],
    );
    await client.query(
      "INSERT INTO user_notifications (user_id, title, summary, payload) VALUES ($1, 'A walkthrough', '', $2)",
      [
        userId,
        {
          type: "carousel",
          pages: [
            { markdown: "First page" },
            { markdown: "Second page" },
            { markdown: "Third page" },
          ],
        },
      ],
    );
    for (const invalid of [
      { markdown: "Missing type" },
      { type: "approval", markdown: "Approve this" },
      { type: "rich_text", markdown: "" },
      { type: "rich_text", markdown: null },
      { type: "carousel", pages: [{ markdown: "Only one page" }] },
      {
        type: "carousel",
        pages: [{ markdown: "First page" }, { markdown: "" }],
      },
      { type: "carousel", pages: [{ markdown: "First page" }, {}] },
      { type: "carousel", pages: "Not a page list" },
      {
        type: "carousel",
        pages: Array.from({ length: 11 }, () => {
          return { markdown: "A page" };
        }),
      },
    ]) {
      await assert.rejects(
        client.query(
          "INSERT INTO user_notifications (user_id, title, summary, payload) VALUES ($1, 'Invalid', '', $2)",
          [userId, invalid],
        ),
        { code: "23514", constraint: "chk_user_notification_payload" },
      );
    }
    await assert.rejects(
      client.query(
        "INSERT INTO user_notifications (user_id, title, summary, payload) VALUES ($1, '  ', '', $2)",
        [userId, payload],
      ),
      { code: "23514", constraint: "chk_user_notification_title" },
    );
    await assert.rejects(
      client.query(
        "INSERT INTO user_notifications (user_id, title, summary, payload) VALUES ($1, 'Too long', $2, $3)",
        [userId, "x".repeat(501), payload],
      ),
      { code: "23514", constraint: "chk_user_notification_summary" },
    );
  } finally {
    await client.query(
      "DELETE FROM user_notifications WHERE user_id IN ($1, $2)",
      [userId, otherUser],
    );
    await client.end();
  }
}
