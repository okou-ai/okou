import { screen, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import {
  userPreferencesContract,
  type UserPreferencesResponse,
} from "@okouai/api-contracts/contracts/user-preferences";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
const context = testContext();

function preferences(timezone: string | null) {
  const defaults = new Intl.DateTimeFormat().resolvedOptions();
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
    ...defaults,
    timeZone: "Asia/Shanghai",
  });
  context.mocks.browser.language("en-US");
  const current: UserPreferencesResponse = {
    timezone,
    locale: "en-US",
    memoryInitialized: true,
    supportedLocales: ["en-US"],
    sendMode: "enter",
    theme: "system",
    colorTheme: null,
    cloudBrowserEnabledByDefault: true,
    chatResourcesEnabledByDefault: false,
    captureNetworkBodiesRemaining: 0,
  };
  const calls: string[] = [];
  context.mocks.api(userPreferencesContract.get, ({ respond }) => {
    calls.push("read");
    return current.timezone
      ? respond(200, current)
      : respond(409, {
          error: {
            code: "USER_PREFERENCES_UNINITIALIZED",
            message: "No time zone yet",
          },
        });
  });
  context.mocks.api(userPreferencesContract.initialize, ({ body, respond }) => {
    calls.push("initialize");
    current.timezone ??= body.timezone ?? null;
    current.locale = body.locale;
    return respond(200, current);
  });
  context.mocks.api(userPreferencesContract.update, ({ body, respond }) => {
    calls.push("update");
    Object.assign(current, body);
    return respond(200, current);
  });
  return { current, calls };
}

test("user-timezone-initialization-001 A first visit to Workflows saves the member's Shanghai timezone and English locale", async () => {
  const saved = preferences(null);
  await setupPage({ context, path: "/workflows" });
  await expect(
    screen.findByRole("heading", { name: "Workflows" }),
  ).resolves.toBeVisible();
  expect(saved.current).toMatchObject({
    timezone: "Asia/Shanghai",
    locale: "en-US",
  });
  expect(saved.calls).toStrictEqual(["read", "initialize"]);
});

test("user-timezone-initialization-003 Account preferences show the saved Pacific timezone on a Shanghai device", async () => {
  const saved = preferences("America/Los_Angeles");
  await setupPage({ context, path: "/?settings=preference" });
  const settings = within(await screen.findByRole("dialog"));
  await expect(
    settings.findByRole("combobox", { name: /time zone/i }),
  ).resolves.toHaveTextContent("Pacific Time (PT)");
  expect(saved.calls).toStrictEqual(["read"]);
});
