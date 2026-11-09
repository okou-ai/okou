import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { Client } from "pg";
import { deliverPreviewSamples } from "./migrations/030-notification-preview-samples/backfill";
import { samples } from "./migrations/030-notification-preview-samples/samples";

/** Exercise the operator against real PostgreSQL and an HTTP Clerk peer. */
export async function validateNotificationPreviewSamples(databaseUrl: string) {
  const userId = `preview-sample-${randomUUID()}`;
  const orgId = `${userId}-org`;
  const otherUser = `${userId}-other`;
  const email = "notification-preview@example.com";
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    response.setHeader("Content-Type", "application/json");
    if (url.pathname === "/v1/users") {
      const requestedEmail = url.searchParams.get("email_address");
      const user = {
        id: userId,
        banned: false,
        locked: false,
        email_addresses: [
          { email_address: email, verification: { status: "verified" } },
        ],
      };
      if (requestedEmail === "ambiguous@example.com") {
        const duplicate = {
          ...user,
          email_addresses: [
            {
              email_address: requestedEmail,
              verification: { status: "verified" },
            },
          ],
        };
        response.end(
          JSON.stringify([duplicate, { ...duplicate, id: otherUser }]),
        );
      } else if (requestedEmail === "unverified@example.com") {
        response.end(
          JSON.stringify([
            {
              ...user,
              email_addresses: [
                {
                  email_address: requestedEmail,
                  verification: { status: "unverified" },
                },
              ],
            },
          ]),
        );
      } else {
        response.end(JSON.stringify(requestedEmail === email ? [user] : []));
      }
    } else if (
      url.pathname === `/v1/users/${userId}/organization_memberships`
    ) {
      // Pagination must preserve all personal organization overrides.
      const offset = url.searchParams.get("offset");
      response.end(
        JSON.stringify({
          data: [
            {
              organization: { id: offset === "0" ? orgId : `${orgId}-second` },
            },
          ],
          total_count: 2,
        }),
      );
    } else {
      response.statusCode = 404;
      response.end("{}");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const fetchClerk: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.clerk.com");
    return fetch(
      `http://127.0.0.1:${address.port}${url.pathname}${url.search}`,
      init,
    );
  };
  const options = {
    databaseUrl,
    clerkKey: "sk_test_notification_preview_fixture",
    environment: "preview",
    emails: [email],
    migrate: false,
    fetchClerk,
  };
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO user_feature_switches (org_id, user_id, switches)
       VALUES ($1, $2, '{"unrelatedFlag":true,"userNotifications":false}'),
              ($1, $3, '{"userNotifications":false}')`,
      [orgId, userId, otherUser],
    );
    for (const invalid of [
      { ...options, environment: "production", migrate: true },
      { ...options, clerkKey: "sk_live_rejected", migrate: true },
      { ...options, emails: [email, "missing@example.com"], migrate: true },
      { ...options, emails: ["ambiguous@example.com"], migrate: true },
      { ...options, emails: ["unverified@example.com"], migrate: true },
    ]) {
      await assert.rejects(deliverPreviewSamples(invalid));
    }
    const dryRun = await deliverPreviewSamples(options);
    assert.equal(dryRun.planned, samples.length);
    assert.equal(dryRun.recipients[0]!.stored, 0);
    const unchanged = await client.query(
      "SELECT switches->'userNotifications' AS enabled FROM user_feature_switches WHERE user_id=$1",
      [userId],
    );
    assert.equal(unchanged.rows[0].enabled, false);

    const first = await deliverPreviewSamples({ ...options, migrate: true });
    assert.equal(first.inserted, samples.length);
    assert.equal(first.recipients[0]!.unread, samples.length);
    const ordered = await client.query(
      "SELECT delivery_key FROM user_notifications WHERE user_id=$1 ORDER BY created_at DESC, id DESC",
      [userId],
    );
    assert.deepEqual(
      ordered.rows.map((row) => {
        return row.delivery_key;
      }),
      samples.map((sample) => {
        return sample.delivery_key;
      }),
    );
    assert.equal(first.recipients[0]!.organizations, 2);
    const flags = await client.query(
      "SELECT switches FROM user_feature_switches WHERE user_id=$1 ORDER BY org_id",
      [userId],
    );
    assert.equal(flags.rowCount, 2);
    assert.deepEqual(flags.rows[0].switches, {
      unrelatedFlag: true,
      userNotifications: true,
    });
    assert.deepEqual(flags.rows[1].switches, { userNotifications: true });

    await client.query(
      "UPDATE user_notifications SET read_at='2026-11-06 00:00:00' WHERE user_id=$1 AND delivery_key='notifications-demo-20261106-carousel'",
      [userId],
    );
    const repeated = await deliverPreviewSamples({ ...options, migrate: true });
    assert.equal(repeated.inserted, 0);
    assert.equal(repeated.recipients[0]!.stored, samples.length);
    assert.equal(repeated.recipients[0]!.unread, samples.length - 1);
    const receipt = await client.query(
      "SELECT read_at FROM user_notifications WHERE user_id=$1 AND delivery_key='notifications-demo-20261106-carousel'",
      [userId],
    );
    assert.deepEqual(receipt.rows[0].read_at, new Date("2026-11-06T00:00:00Z"));
    const other = await client.query(
      "SELECT switches FROM user_feature_switches WHERE user_id=$1",
      [otherUser],
    );
    assert.deepEqual(other.rows[0].switches, { userNotifications: false });
    const otherDeliveries = await client.query(
      "SELECT id FROM user_notifications WHERE user_id=$1",
      [otherUser],
    );
    assert.equal(otherDeliveries.rowCount, 0);

    await client.query(
      "UPDATE user_notifications SET title='Conflicting sample' WHERE user_id=$1",
      [userId],
    );
    await assert.rejects(
      deliverPreviewSamples({ ...options, migrate: true }),
      /ExistingDeliveryContentMismatch/,
    );
  } finally {
    await client.query("DELETE FROM user_notifications WHERE user_id=$1", [
      userId,
    ]);
    await client.query(
      "DELETE FROM user_feature_switches WHERE user_id IN ($1,$2)",
      [userId, otherUser],
    );
    await client.end();
    await new Promise<void>((resolve, reject) => {
      return server.close((error) => {
        return error ? reject(error) : resolve();
      });
    });
  }
}
