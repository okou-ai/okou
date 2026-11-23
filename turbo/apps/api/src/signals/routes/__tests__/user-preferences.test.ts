import { randomUUID } from "node:crypto";

import {
  USER_PREFERENCES_UNINITIALIZED,
  userPreferencesContract,
} from "@okouai/api-contracts/contracts/user-preferences";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { presentationFormatContract } from "@okouai/api-contracts/contracts/presentation-format";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { DEFAULT_USER_TIMEZONE } from "@okouai/core/timezone";
import { expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { userPreferencesRoutes } from "../user-preferences";
import { featureSwitchesRoutes } from "../feature-switches";
import { presentationFormatRoutes } from "../presentation-format";
import { createBddApi } from "./helpers/api-bdd";
import { createAuthDeviceApiActions } from "./helpers/api-bdd-auth-device";
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
    client().initialize({ headers: headers(), body: { locale: "en-US" } }),
    [200],
  );
  expect(initialized.body.timezone).toBe(DEFAULT_USER_TIMEZONE);
  expect(initialized.body.locale).toBe("en-US");
  const persisted = await accept(client().get({ headers: headers() }), [200]);
  expect(persisted.body).toStrictEqual(initialized.body);
});

test("for you covers persist per workspace member and can be reset", async () => {
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  mocks.clerk.session(userId, orgId);
  const initialized = await accept(
    client().initialize({
      headers: headers(),
      body: { timezone: "Asia/Shanghai", locale: "en-US" },
    }),
    [200],
  );
  expect(initialized.body.forYouCoverId).toBeNull();

  const saved = await accept(
    client().update({
      headers: headers(),
      body: { forYouCoverId: "cover-08" },
    }),
    [200],
  );
  expect(saved.body.forYouCoverId).toBe("cover-08");
  const persisted = await accept(client().get({ headers: headers() }), [200]);
  expect(persisted.body.forYouCoverId).toBe("cover-08");

  mocks.clerk.session(`user_${randomUUID()}`, orgId);
  const otherMember = await accept(
    client().initialize({
      headers: headers(),
      body: { locale: "en-US" },
    }),
    [200],
  );
  expect(otherMember.body.forYouCoverId).toBeNull();

  mocks.clerk.session(userId, `org_${randomUUID()}`);
  const otherWorkspace = await accept(
    client().initialize({
      headers: headers(),
      body: { locale: "en-US" },
    }),
    [200],
  );
  expect(otherWorkspace.body.forYouCoverId).toBeNull();

  mocks.clerk.session(userId, orgId);
  await accept(
    client().update({ headers: headers(), body: { theme: "dark" } }),
    [200],
  );
  const afterThemeChange = await accept(
    client().get({ headers: headers() }),
    [200],
  );
  expect(afterThemeChange.body.forYouCoverId).toBe("cover-08");

  await accept(
    client().update({ headers: headers(), body: { forYouCoverId: null } }),
    [200],
  );
  const reset = await accept(client().get({ headers: headers() }), [200]);
  expect(reset.body.forYouCoverId).toBeNull();
  expect(reset.body.theme).toBe("dark");
});

const presentationFormatKey = FeatureSwitchKey.PresentationOutputFormat;
const eligibleUserId = "user_3EWY21Oe3f15kfs3yYmbGgDb3NV";

function newPresentationMember() {
  const member = { userId: eligibleUserId, orgId: `org_${randomUUID()}` };
  mocks.clerk.session(member.userId, member.orgId);
  return member;
}

function featureClient() {
  return setupApp({ context, routes: featureSwitchesRoutes })(
    featureSwitchesContract,
  );
}

test("presentation preferences stay null until chosen and survive unrelated updates and initialization", async () => {
  newPresentationMember();
  const initialized = await accept(
    client().initialize({ headers: headers(), body: { locale: "en-US" } }),
    [200],
  );
  expect(initialized.body.presentationFormat).toBeNull();
  const html = await accept(
    client().update({
      headers: headers(),
      body: { presentationFormat: "html" },
    }),
    [200],
  );
  expect(html.body.presentationFormat).toBe("html");
  const pptx = await accept(
    client().update({
      headers: headers(),
      body: { presentationFormat: "pptx" },
    }),
    [200],
  );
  expect(pptx.body.presentationFormat).toBe("pptx");
  const theme = await accept(
    client().update({ headers: headers(), body: { theme: "dark" } }),
    [200],
  );
  expect(theme.body.presentationFormat).toBe("pptx");
  const repeated = await accept(
    client().initialize({ headers: headers(), body: { locale: "ja-JP" } }),
    [200],
  );
  expect(repeated.body.presentationFormat).toBe("pptx");
  expect(repeated.body.locale).toBe("en-US");
  const persisted = await accept(client().get({ headers: headers() }), [200]);
  expect(persisted.body.presentationFormat).toBe("pptx");
});

test("saving a presentation preference does not initialize timezone, locale, or memory", async () => {
  newPresentationMember();
  const saved = await accept(
    client().update({
      headers: headers(),
      body: { presentationFormat: "pptx" },
    }),
    [200],
  );
  expect(saved.body.presentationFormat).toBe("pptx");
  expect(saved.body.timezone).toBeNull();
  expect(saved.body.locale).toBeNull();
  expect(saved.body).toHaveProperty("memoryInitialized", false);
  const uninitialized = await accept(
    client().get({ headers: headers() }),
    [409],
  );
  expect(uninitialized.body.error.code).toBe(USER_PREFERENCES_UNINITIALIZED);
  const initialized = await accept(
    client().initialize({ headers: headers(), body: { locale: "en-US" } }),
    [200],
  );
  expect(initialized.body.presentationFormat).toBe("pptx");
});

test("opting out hides and ignores presentation preferences without erasing the saved value or legacy updates", async () => {
  newPresentationMember();
  await accept(
    client().initialize({ headers: headers(), body: { locale: "en-US" } }),
    [200],
  );
  await accept(
    client().update({
      headers: headers(),
      body: { presentationFormat: "pptx" },
    }),
    [200],
  );
  await accept(
    featureClient().update({
      headers: headers(),
      body: { switches: { [presentationFormatKey]: false } },
    }),
    [200],
  );
  const hidden = await accept(client().get({ headers: headers() }), [200]);
  expect(hidden.body).not.toHaveProperty("presentationFormat");
  const onlyFormat = await accept(
    client().update({
      headers: headers(),
      body: { presentationFormat: "html" },
    }),
    [400],
  );
  expect(onlyFormat.body.error.message).toBe(
    "At least one preference must be provided",
  );
  const mixed = await accept(
    client().update({
      headers: headers(),
      body: { theme: "dark", presentationFormat: "html" },
    }),
    [200],
  );
  expect(mixed.body.theme).toBe("dark");
  expect(mixed.body).not.toHaveProperty("presentationFormat");
  const reinitialized = await accept(
    client().initialize({ headers: headers(), body: { locale: "en-US" } }),
    [200],
  );
  expect(reinitialized.body).not.toHaveProperty("presentationFormat");
  await accept(
    featureClient().update({
      headers: headers(),
      body: { switches: { [presentationFormatKey]: true } },
    }),
    [200],
  );
  const restored = await accept(client().get({ headers: headers() }), [200]);
  expect(restored.body.presentationFormat).toBe("pptx");
  expect(restored.body.theme).toBe("dark");
});

test("out-of-audience callers retain legacy preferences without saving a presentation default", async () => {
  newMember();
  const initialized = await accept(
    client().initialize({ headers: headers(), body: { locale: "en-US" } }),
    [200],
  );
  expect(initialized.body).not.toHaveProperty("presentationFormat");
  const mixed = await accept(
    client().update({
      headers: headers(),
      body: { theme: "dark", presentationFormat: "pptx" },
    }),
    [200],
  );
  expect(mixed.body.theme).toBe("dark");
  expect(mixed.body).not.toHaveProperty("presentationFormat");
  await accept(
    client().update({
      headers: headers(),
      body: { presentationFormat: "pptx" },
    }),
    [400],
  );
});

test("cli PATs retain legacy preference access but cannot save the enabled presentation preference", async () => {
  const identity = newPresentationMember();
  const actor = createBddApi(context).user(identity);
  const devices = createAuthDeviceApiActions(context);
  const device = await devices.startCliDevice();
  await devices.requestCliApproval(
    actor,
    { device_code: device.device_code },
    [200],
  );
  const issued = await devices.requestCliToken(device.device_code, [200]);
  if (issued.status !== 200) {
    throw new Error("Expected the approved device to issue a CLI PAT");
  }
  const patHeaders = { authorization: `Bearer ${issued.body.access_token}` };
  const format = setupApp({ context, routes: presentationFormatRoutes })(
    presentationFormatContract,
  );
  const deniedRead = await accept(format.get({ headers: patHeaders }), [403]);
  expect(deniedRead.body.error.code).toBe("FORBIDDEN");
  const legacy = await accept(
    client().update({ headers: patHeaders, body: { theme: "dark" } }),
    [200],
  );
  expect(legacy.body.theme).toBe("dark");
  expect(legacy.body.presentationFormat).toBeNull();
  const denied = await accept(
    client().update({
      headers: patHeaders,
      body: { presentationFormat: "pptx", theme: "light" },
    }),
    [400],
  );
  expect(denied.body.error.message).toBe(
    "Presentation format preferences require a human session",
  );
  const afterDenial = await accept(
    client().update({ headers: patHeaders, body: { locale: "en-US" } }),
    [200],
  );
  expect(afterDenial.body.theme).toBe("dark");
  expect(afterDenial.body.presentationFormat).toBeNull();

  mocks.clerk.session(identity.userId, identity.orgId);
  await accept(
    featureClient().update({
      headers: headers(),
      body: { switches: { [presentationFormatKey]: false } },
    }),
    [200],
  );
  const disabledMixed = await accept(
    client().update({
      headers: patHeaders,
      body: { theme: "light", presentationFormat: "pptx" },
    }),
    [200],
  );
  expect(disabledMixed.body.theme).toBe("light");
  expect(disabledMixed.body).not.toHaveProperty("presentationFormat");
  const disabledFormat = await accept(
    client().update({
      headers: patHeaders,
      body: { presentationFormat: "pptx" },
    }),
    [400],
  );
  expect(disabledFormat.body.error.message).toBe(
    "At least one preference must be provided",
  );
  await accept(
    featureClient().update({
      headers: headers(),
      body: { switches: { [presentationFormatKey]: true } },
    }),
    [200],
  );
  const restored = await accept(
    client().update({ headers: patHeaders, body: { locale: "en-US" } }),
    [200],
  );
  expect(restored.body.theme).toBe("light");
  expect(restored.body.presentationFormat).toBeNull();
});
