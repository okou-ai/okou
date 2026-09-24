import {
  userPreferencesContract,
  type UserPreferencesResponse,
} from "@okouai/api-contracts/contracts/user-preferences";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../__tests__/test-helpers.ts";

const context = testContext();

function preferences(
  timezone: string | null,
  locale: UserPreferencesResponse["locale"] = "en-US",
): UserPreferencesResponse {
  return {
    timezone,
    locale,
    supportedLocales: ["en-US"],
    pinnedAgentIds: [],
    sendMode: "enter",
    cloudBrowserEnabledByDefault: true,
    theme: "system",
    colorTheme: "blue-horizon",
    captureNetworkBodiesRemaining: 0,
  };
}

function mockTimezonePreferences(
  initialTimezone: string | null,
  uninitializedStatus: 200 | 409 = 200,
  initialLocale: UserPreferencesResponse["locale"] = "en-US",
  legacyTimezoneOnly = false,
) {
  let stored = preferences(initialTimezone, initialLocale);
  let initializationBody:
    | { timezone?: string; locale?: UserPreferencesResponse["locale"] }
    | undefined;
  let reads = 0;
  let updates = 0;
  context.mocks.api(userPreferencesContract.get, ({ respond }) => {
    reads += 1;
    if (
      (stored.timezone === null || stored.locale === null) &&
      uninitializedStatus === 409
    ) {
      return respond(409, {
        error: {
          code: "USER_PREFERENCES_UNINITIALIZED",
          message: "User preferences require timezone or locale initialization",
        },
      });
    }
    return respond(200, stored);
  });
  context.mocks.api(userPreferencesContract.initialize, ({ body, respond }) => {
    initializationBody = body;
    stored = {
      ...stored,
      timezone: stored.timezone ?? body.timezone ?? null,
      locale: legacyTimezoneOnly
        ? stored.locale
        : (stored.locale ?? body.locale ?? null),
    };
    return respond(200, stored);
  });
  context.mocks.api(userPreferencesContract.update, ({ body, respond }) => {
    updates += 1;
    stored = { ...stored, ...body };
    return respond(200, stored);
  });
  return {
    initializationBody: () => {
      return initializationBody;
    },
    reads: () => {
      return reads;
    },
    updates: () => {
      return updates;
    },
    stored: () => {
      return stored;
    },
  };
}

function setBrowserTimezone(timezone: string): void {
  const resolved = new Intl.DateTimeFormat().resolvedOptions();
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
    ...resolved,
    timeZone: timezone,
  });
}

test("A member's first organization visit stores the browser timezone", async () => {
  const requests = mockTimezonePreferences(null, 409);
  setBrowserTimezone("Asia/Shanghai");

  await setupPage({ context, path: "/agents", host: "app.okou.ai" });

  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeVisible();
  await waitFor(() => {
    expect(requests.initializationBody()).toStrictEqual({
      timezone: "Asia/Shanghai",
      locale: "en-US",
    });
  });
  expect(requests.reads()).toBe(1);
  expect(requests.updates()).toBe(0);
});

test("A stored organization timezone is not replaced on a later visit", async () => {
  const requests = mockTimezonePreferences("America/Los_Angeles");
  setBrowserTimezone("Asia/Shanghai");

  await setupPage({
    context,
    path: "/agents?settings=preference",
    host: "app.okou.ai",
  });

  const settings = await screen.findByRole("dialog", { name: "Settings" });
  await expect(
    within(settings).findByText(/Pacific Time \(PT\)/u),
  ).resolves.toBeVisible();
  expect(requests.initializationBody()).toBeUndefined();
  expect(requests.reads()).toBe(1);
  expect(requests.updates()).toBe(0);
});

test("A missing locale initializes without replacing the stored timezone", async () => {
  const requests = mockTimezonePreferences("America/Los_Angeles", 409, null);
  setBrowserTimezone("Asia/Shanghai");
  context.mocks.browser.languages(["fr-FR"]);

  await setupPage({ context, path: "/agents", host: "app.okou.ai" });
  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeVisible();
  await waitFor(() => {
    expect(requests.initializationBody()).toStrictEqual({
      timezone: "Asia/Shanghai",
      locale: "fr-FR",
    });
  });
  expect(requests.reads()).toBe(1);
  expect(requests.updates()).toBe(0);
  expect(requests.stored().timezone).toBe("America/Los_Angeles");
  expect(requests.stored().locale).toBe("fr-FR");
});

test("An older API still yields complete preferences after a locale update", async () => {
  const requests = mockTimezonePreferences("Asia/Tokyo", 200, null, true);
  context.mocks.browser.languages(["fr-FR"]);

  await setupPage({ context, path: "/agents", host: "app.okou.ai" });
  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeVisible();
  expect(requests.reads()).toBe(1);
  expect(requests.updates()).toBe(1);
  expect(requests.stored().timezone).toBe("Asia/Tokyo");
  expect(requests.stored().locale).toBe("fr-FR");
});

test("An invalid browser timezone falls back to Pacific Time", async () => {
  const requests = mockTimezonePreferences(null, 409);
  setBrowserTimezone("Invalid/Timezone");

  await setupPage({ context, path: "/agents", host: "app.okou.ai" });
  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeVisible();
  await waitFor(() => {
    expect(requests.initializationBody()).toStrictEqual({
      timezone: "America/Los_Angeles",
      locale: "en-US",
    });
  });
});

test("An older API returning a null timezone still initializes preferences", async () => {
  const requests = mockTimezonePreferences(null);
  setBrowserTimezone("Asia/Tokyo");

  await setupPage({ context, path: "/agents", host: "app.okou.ai" });
  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeVisible();
  await waitFor(() => {
    expect(requests.initializationBody()).toStrictEqual({
      timezone: "Asia/Tokyo",
      locale: "en-US",
    });
  });
  expect(requests.reads()).toBe(1);
});
