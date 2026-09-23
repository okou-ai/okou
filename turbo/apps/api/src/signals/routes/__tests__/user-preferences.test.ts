import { randomUUID } from "node:crypto";

import {
  USER_PREFERENCES_UNINITIALIZED,
  userPreferencesContract,
} from "@okouai/api-contracts/contracts/user-preferences";
import { DEFAULT_USER_TIMEZONE } from "@okouai/core/timezone";
import { expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { userPreferencesRoutes } from "../user-preferences";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);

function headers() {
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context, routes: userPreferencesRoutes })(
    userPreferencesContract,
  );
}

function newMember() {
  mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
}

test("get requires initialization and post returns the saved preferences", async () => {
  newMember();

  const before = await accept(client().get({ headers: headers() }), [409]);
  expect(before.body.error.code).toBe(USER_PREFERENCES_UNINITIALIZED);

  const initialized = await accept(
    client().initialize({
      headers: headers(),
      body: { timezone: "Asia/Tokyo" },
    }),
    [200],
  );
  expect(initialized.body.timezone).toBe("Asia/Tokyo");

  const after = await accept(client().get({ headers: headers() }), [200]);
  expect(after.body).toStrictEqual(initialized.body);

  const repeated = await accept(
    client().initialize({
      headers: headers(),
      body: { timezone: "America/Los_Angeles" },
    }),
    [200],
  );
  expect(repeated.body.timezone).toBe("Asia/Tokyo");
});

test("initialization uses Pacific Time when no timezone is provided", async () => {
  newMember();

  const initialized = await accept(
    client().initialize({ headers: headers(), body: {} }),
    [200],
  );
  expect(initialized.body.timezone).toBe(DEFAULT_USER_TIMEZONE);
  const persisted = await accept(client().get({ headers: headers() }), [200]);
  expect(persisted.body.timezone).toBe(DEFAULT_USER_TIMEZONE);
});
