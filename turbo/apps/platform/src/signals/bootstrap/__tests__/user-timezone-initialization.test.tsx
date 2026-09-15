import {
  userPreferencesContract,
  type UserPreferencesResponse,
} from "@okouai/api-contracts/contracts/user-preferences";
import { screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { HttpResponse } from "msw";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../__tests__/test-helpers.ts";

const context = testContext();

function preferences(timezone: string | null): UserPreferencesResponse {
  return {
    timezone,
    locale: "en-US",
    translationLanguage: null,
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

function mockTimezonePreferences(initialTimezone: string | null) {
  let stored = preferences(initialTimezone);
  let initializationBody: { timezone?: string } | undefined;
  context.mocks.api(userPreferencesContract.get, ({ respond }) => {
    return respond(200, stored);
  });
  context.mocks.api(userPreferencesContract.initialize, ({ body, respond }) => {
    initializationBody = body;
    if (stored.timezone === null && body.timezone !== undefined) {
      stored = { ...stored, timezone: body.timezone };
    }
    return respond(200, stored);
  });
  return () => {
    return initializationBody;
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
  const initializationBody = mockTimezonePreferences(null);
  setBrowserTimezone("Asia/Shanghai");

  await setupPage({ context, path: "/agents", host: "app.okou.ai" });

  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeVisible();
  await waitFor(() => {
    expect(initializationBody()).toStrictEqual({ timezone: "Asia/Shanghai" });
  });
});

test("A stored organization timezone is not replaced on a later visit", async () => {
  mockTimezonePreferences("America/Los_Angeles");
  setBrowserTimezone("Asia/Shanghai");

  await setupPage({
    context,
    path: "/agents?settings=preference",
    host: "app.okou.ai",
  });

  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeVisible();
  await expect(
    screen.findByText(/Pacific Time \(PT\)/u),
  ).resolves.toBeVisible();
});

test("An API without timezone initialization still opens the application", async () => {
  context.mocks.http.post("*/api/user-preferences/initialize", () => {
    return new HttpResponse(null, { status: 404 });
  });
  await setupPage({ context, path: "/agents", host: "app.okou.ai" });
  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeVisible();
});
