import { randomUUID } from "node:crypto";

import {
  cliAuthApproveContract,
  cliAuthDeviceContract,
  cliAuthTokenContract,
} from "@okouai/api-contracts/contracts/cli-auth";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import {
  USER_PREFERENCES_UNINITIALIZED,
  userPreferencesContract,
} from "@okouai/api-contracts/contracts/user-preferences";
import { DEFAULT_USER_TIMEZONE } from "@okouai/core/timezone";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { cliAuthRoutes } from "../cli-auth";
import { featureSwitchesRoutes } from "../feature-switches";
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

function newMember(orgId = `org_${randomUUID()}`) {
  const userId = `user_${randomUUID()}`;
  mocks.clerk.session(userId, orgId);
  return { userId, orgId };
}

const STAFF_ORG_ID = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";

function featureSwitches() {
  return setupApp({ context, routes: featureSwitchesRoutes })(
    featureSwitchesContract,
  );
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
  expect(initialized.body.presentationFormat).toBeNull();

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
    client().initialize({ headers: headers(), body: { locale: "en-US" } }),
    [200],
  );
  expect(initialized.body.timezone).toBe(DEFAULT_USER_TIMEZONE);
  expect(initialized.body.locale).toBe("en-US");
  const persisted = await accept(client().get({ headers: headers() }), [200]);
  expect(persisted.body).toStrictEqual(initialized.body);
});

test("presentation format updates are nullable and preserve unrelated preferences", async () => {
  newMember(STAFF_ORG_ID);
  const saved = await accept(
    client().update({
      headers: headers(),
      body: {
        timezone: "UTC",
        locale: "en-US",
        sendMode: "cmd-enter",
        cloudBrowserEnabledByDefault: false,
        theme: "dark",
        colorTheme: "golden-hour",
        captureNetworkBodiesRemaining: 3,
        presentationFormat: "pptx",
      },
    }),
    [200],
  );
  expect(saved.body.presentationFormat).toBe("pptx");
  expect(
    (await accept(client().get({ headers: headers() }), [200])).body,
  ).toStrictEqual(saved.body);

  const unrelated = await accept(
    client().update({ headers: headers(), body: { locale: "fr-FR" } }),
    [200],
  );
  expect(unrelated.body).toStrictEqual({ ...saved.body, locale: "fr-FR" });

  const html = await accept(
    client().update({
      headers: headers(),
      body: { presentationFormat: "html" },
    }),
    [200],
  );
  expect(html.body).toStrictEqual({
    ...unrelated.body,
    presentationFormat: "html",
  });

  const cleared = await accept(
    client().update({ headers: headers(), body: { presentationFormat: null } }),
    [200],
  );
  expect(cleared.body).toStrictEqual({
    ...html.body,
    presentationFormat: null,
  });
  expect(
    (await accept(client().get({ headers: headers() }), [200])).body,
  ).toStrictEqual(cleared.body);
});

test("presentation format stays scoped to the current member and workspace", async () => {
  const owner = newMember(STAFF_ORG_ID);
  await accept(
    client().update({
      headers: headers(),
      body: { timezone: "UTC", locale: "en-US", presentationFormat: "pptx" },
    }),
    [200],
  );

  newMember(owner.orgId);
  const peer = await accept(
    client().update({
      headers: headers(),
      body: { timezone: "UTC", locale: "en-US" },
    }),
    [200],
  );
  expect(peer.body.presentationFormat).toBeNull();

  mocks.clerk.session(owner.userId, `org_${randomUUID()}`);
  const otherWorkspace = await accept(
    client().update({
      headers: headers(),
      body: { timezone: "UTC", locale: "en-US" },
    }),
    [200],
  );
  expect(otherWorkspace.body.presentationFormat).toBeNull();

  mocks.clerk.session(owner.userId, owner.orgId);
  const original = await accept(client().get({ headers: headers() }), [200]);
  expect(original.body.presentationFormat).toBe("pptx");
});

test("a disabled presentation switch rejects format writes without blocking other preferences", async () => {
  newMember(STAFF_ORG_ID);
  const saved = await accept(
    client().update({
      headers: headers(),
      body: {
        timezone: "UTC",
        locale: "en-US",
        theme: "dark",
        presentationFormat: "pptx",
      },
    }),
    [200],
  );
  await accept(
    featureSwitches().update({
      headers: headers(),
      body: {
        switches: { [FeatureSwitchKey.PresentationOutputFormat]: false },
      },
    }),
    [200],
  );

  await accept(
    client().update({
      headers: headers(),
      body: { presentationFormat: "html", theme: "light" },
    }),
    [400],
  );
  await accept(
    client().update({ headers: headers(), body: { presentationFormat: null } }),
    [400],
  );
  expect(
    (await accept(client().get({ headers: headers() }), [200])).body,
  ).toStrictEqual(saved.body);

  const unrelated = await accept(
    client().update({ headers: headers(), body: { theme: "light" } }),
    [200],
  );
  expect(unrelated.body).toStrictEqual({ ...saved.body, theme: "light" });
});

test("external members cannot enable presentation format through a personal override", async () => {
  newMember();
  const saved = await accept(
    client().update({
      headers: headers(),
      body: { timezone: "UTC", locale: "en-US" },
    }),
    [200],
  );
  await accept(
    featureSwitches().update({
      headers: headers(),
      body: { switches: { [FeatureSwitchKey.PresentationOutputFormat]: true } },
    }),
    [200],
  );
  await accept(
    client().update({
      headers: headers(),
      body: { presentationFormat: "pptx", sendMode: "cmd-enter" },
    }),
    [400],
  );
  expect(
    (await accept(client().get({ headers: headers() }), [200])).body,
  ).toStrictEqual(saved.body);
});

test("a device-approved PAT can update other preferences but cannot set or clear presentation format", async () => {
  const owner = newMember(STAFF_ORG_ID);
  const saved = await accept(
    client().update({
      headers: headers(),
      body: {
        timezone: "UTC",
        locale: "en-US",
        theme: "dark",
        presentationFormat: "pptx",
      },
    }),
    [200],
  );
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [{ role: "org:admin", organization: { id: owner.orgId } }],
  });
  const auth = setupApp({ context, routes: cliAuthRoutes });
  const device = await accept(
    auth(cliAuthDeviceContract).create({ body: {} }),
    [200],
  );
  await accept(
    auth(cliAuthApproveContract).approve({
      headers: headers(),
      body: { device_code: device.body.device_code },
    }),
    [200],
  );
  const issued = await accept(
    auth(cliAuthTokenContract).exchange({
      body: { device_code: device.body.device_code },
    }),
    [200],
  );
  const personalHeaders = {
    authorization: `Bearer ${issued.body.access_token}`,
  };
  await accept(
    client().update({
      headers: personalHeaders,
      body: { presentationFormat: "html", theme: "light" },
    }),
    [400],
  );
  await accept(
    client().update({
      headers: personalHeaders,
      body: { presentationFormat: null },
    }),
    [400],
  );
  expect(
    (await accept(client().get({ headers: headers() }), [200])).body,
  ).toStrictEqual(saved.body);

  const unrelated = await accept(
    client().update({ headers: personalHeaders, body: { theme: "light" } }),
    [200],
  );
  expect(unrelated.body).toStrictEqual({ ...saved.body, theme: "light" });
  expect(
    (await accept(client().get({ headers: headers() }), [200])).body,
  ).toStrictEqual(unrelated.body);
});
