import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { userNotificationsContract } from "@okouai/api-contracts/contracts/user-notifications";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { userNotificationRoutes } from "../user-notifications";
import { createRouteMocks } from "./helpers/route-test";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const STAFF_ORG_ID = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";
function client() {
  return setupApp({ context, routes: userNotificationRoutes })(
    userNotificationsContract,
  );
}

async function enabledClient() {
  await updateFeatureSwitchesForUser(
    context,
    { userId: `user_${randomUUID()}`, orgId: STAFF_ORG_ID },
    { [FeatureSwitchKey.UserNotifications]: true },
  );
  return client();
}

test("a staff user can explicitly enable an empty personal inbox and safely mark all as read", async () => {
  const api = await enabledClient();
  expect((await accept(api.summary({ headers }), [200])).body).toStrictEqual({
    unreadCount: 0,
  });
  expect((await accept(api.list({ headers }), [200])).body).toStrictEqual({
    items: [],
    nextCursor: null,
  });
  const marked = await accept(api.markAllRead({ headers }), [200]);
  expect(Number.isNaN(Date.parse(marked.body.readThrough))).toBeFalsy();
  expect((await accept(api.summary({ headers }), [200])).body.unreadCount).toBe(
    0,
  );
});

test("missing notification details and receipts return the same scoped not-found result", async () => {
  const api = await enabledClient();
  const id = randomUUID();
  expect((await api.get({ headers, params: { id } })).status).toBe(404);
  expect((await api.markRead({ headers, params: { id } })).status).toBe(404);
});

test("a partial paging cursor is rejected", async () => {
  const api = await enabledClient();
  expect(
    (await api.list({ headers, query: { beforeId: randomUUID() } })).status,
  ).toBe(400);
});

test.each([STAFF_ORG_ID, `org_${randomUUID()}`])(
  "the rollout gate rejects every notification operation by default in %s",
  async (orgId) => {
    mocks.clerk.session(`user_${randomUUID()}`, orgId);
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
  },
);

test("requests without authentication cannot read notifications", async () => {
  const api = client();
  expect((await api.summary({ headers: {} })).status).toBe(401);
  expect((await api.list({ headers: {} })).status).toBe(401);
});
