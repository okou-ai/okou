import {
  userPreferencesContract,
  type UserPreferencesResponse,
} from "@okouai/api-contracts/contracts/user-preferences";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../__tests__/test-helpers.ts";

const context = testContext();

function preferences(timezone: string | null): UserPreferencesResponse {
  return {
    timezone,
    locale: "en-US",
    supportedLocales: ["en-US"],
    pinnedAgentIds: [],
    sendMode: "enter",
    cloudBrowserEnabledByDefault: true,
    theme: "system",
    colorTheme: "blue-horizon",
    captureNetworkBodiesRemaining: 0,
    voiceInputModel: null,
  };
}

function mockTimezonePreferences(
  initialTimezone: string | null,
  uninitializedStatus: 200 | 409 = 200,
) {
  let stored = preferences(initialTimezone);
  let initializationBody: { timezone?: string } | undefined;
  let reads = 0;
  context.mocks.api(userPreferencesContract.get, ({ respond }) => {
    reads += 1;
    if (stored.timezone === null && uninitializedStatus === 409) {
      return respond(409, {
        error: {
          code: "USER_PREFERENCES_UNINITIALIZED",
          message: "User preferences require timezone initialization",
        },
      });
    }
    return respond(200, stored);
  });
  context.mocks.api(userPreferencesContract.initialize, ({ body, respond }) => {
    initializationBody = body;
    if (stored.timezone === null && body.timezone !== undefined) {
      stored = { ...stored, timezone: body.timezone };
    }
    return respond(200, stored);
  });
  return {
    initializationBody: () => {
      return initializationBody;
    },
    reads: () => {
      return reads;
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
    });
  });
  expect(requests.reads()).toBe(1);
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
    });
  });
  expect(requests.reads()).toBe(1);
});
