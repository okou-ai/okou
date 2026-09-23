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
      body: { timezone: "Asia/Tokyo", locale: "ja-JP" },
    }),
    [200],
  );
  expect(initialized.body.timezone).toBe("Asia/Tokyo");
  expect(initialized.body.locale).toBe("ja-JP");

  const after = await accept(client().get({ headers: headers() }), [200]);
  expect(after.body).toStrictEqual(initialized.body);

  const repeated = await accept(
    client().initialize({
      headers: headers(),
      body: { timezone: "America/Los_Angeles", locale: "en-US" },
    }),
    [200],
  );
  expect(repeated.body.timezone).toBe("Asia/Tokyo");
  expect(repeated.body.locale).toBe("ja-JP");
});

test("initialization fills only a missing locale", async () => {
  newMember();
  await accept(
    client().update({
      headers: headers(),
      body: { timezone: "Asia/Tokyo" },
    }),
    [200],
  );
  await accept(client().get({ headers: headers() }), [409]);

  const initialized = await accept(
    client().initialize({
      headers: headers(),
      body: { timezone: "America/Los_Angeles", locale: "fr-FR" },
    }),
    [200],
  );
  expect(initialized.body.timezone).toBe("Asia/Tokyo");
  expect(initialized.body.locale).toBe("fr-FR");
});

test("initialization fills only a missing timezone", async () => {
  newMember();
  await accept(
    client().update({ headers: headers(), body: { locale: "de-DE" } }),
    [200],
  );
  await accept(client().get({ headers: headers() }), [409]);

  const initialized = await accept(
    client().initialize({
      headers: headers(),
      body: { timezone: "Asia/Tokyo", locale: "fr-FR" },
    }),
    [200],
  );
  expect(initialized.body.timezone).toBe("Asia/Tokyo");
  expect(initialized.body.locale).toBe("de-DE");
});

test("initialization uses Pacific Time and English when no hints are provided", async () => {
  newMember();

  const initialized = await accept(
    client().initialize({ headers: headers(), body: {} }),
    [200],
  );
  expect(initialized.body.timezone).toBe(DEFAULT_USER_TIMEZONE);
  expect(initialized.body.locale).toBe("en-US");
  const persisted = await accept(client().get({ headers: headers() }), [200]);
  expect(persisted.body).toStrictEqual(initialized.body);
});
