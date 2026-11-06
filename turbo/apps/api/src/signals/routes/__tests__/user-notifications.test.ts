import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { userNotificationsContract } from "@okouai/api-contracts/contracts/user-notifications";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { userNotificationRoutes } from "../user-notifications";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const STAFF_ORG_ID = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";
function client() {
  return setupApp({ context, routes: userNotificationRoutes })(
    userNotificationsContract,
  );
}

test("A staff user can read an empty personal inbox and safely mark all as read", async () => {
  mocks.clerk.session(`user_${randomUUID()}`, STAFF_ORG_ID);
  const api = client();
  expect((await accept(api.summary({ headers }), [200])).body).toStrictEqual({
    unreadCount: 0,
  });
  expect((await accept(api.list({ headers }), [200])).body).toStrictEqual({
    items: [],
    nextCursor: null,
  });
  const marked = await accept(api.markAllRead({ headers }), [200]);
  expect(Number.isNaN(Date.parse(marked.body.readThrough))).toBe(false);
  expect((await accept(api.summary({ headers }), [200])).body.unreadCount).toBe(
    0,
  );
});

test("Missing notification details and receipts return the same scoped not-found result", async () => {
  mocks.clerk.session(`user_${randomUUID()}`, STAFF_ORG_ID);
  const api = client();
  const id = randomUUID();
  expect((await api.get({ headers, params: { id } })).status).toBe(404);
  expect((await api.markRead({ headers, params: { id } })).status).toBe(404);
});

test("A partial paging cursor is rejected", async () => {
  mocks.clerk.session(`user_${randomUUID()}`, STAFF_ORG_ID);
  expect(
    (await client().list({ headers, query: { beforeId: randomUUID() } }))
      .status,
  ).toBe(400);
});

test("The rollout gate rejects every notification operation for an external workspace", async () => {
  mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
  const api = client();
  expect((await api.summary({ headers })).status).toBe(403);
  expect((await api.list({ headers })).status).toBe(403);
  expect(
    (await api.get({ headers, params: { id: randomUUID() } })).status,
  ).toBe(403);
  expect(
    (await api.markRead({ headers, params: { id: randomUUID() } })).status,
  ).toBe(403);
  expect((await api.markAllRead({ headers })).status).toBe(403);
});

test("Requests without authentication cannot read notifications", async () => {
  const api = client();
  expect((await api.summary({ headers: {} })).status).toBe(401);
  expect((await api.list({ headers: {} })).status).toBe(401);
});
