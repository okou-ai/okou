import { screen } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { OKOU_LOCALE_COOKIE_NAME } from "../../../i18n/locale-fallback.ts";
import frFRCommonUrl from "../../../i18n/locales/fr-FR/common.json?url";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

test.each([
  {
    scenario: "the site cookie takes precedence over browser languages",
    cookie: "v1.fr-FR",
    languages: ["ja-JP"],
    locale: "fr-FR",
    title: "Cette page n'est pas ici.",
  },
  {
    scenario: "the first supported browser language family is selected",
    cookie: "v1.unsupported",
    languages: ["zh-CN", "de-AT", "ja-JP"],
    locale: "de-DE",
    title: "Diese Seite ist nicht hier.",
  },
  {
    scenario: "browser language works before a site cookie exists",
    cookie: null,
    languages: ["fr-CA"],
    locale: "fr-FR",
    title: "Cette page n'est pas ici.",
  },
  {
    scenario: "English is used when no locale hint is supported",
    cookie: "v0.fr-FR",
    languages: ["zh-CN", "ar-SA"],
    locale: "en-US",
    title: "That page isn't here.",
  },
])("Initial page language: $scenario", async (scenario) => {
  context.mocks.browser.cookie(
    scenario.cookie === null
      ? ""
      : `${OKOU_LOCALE_COOKIE_NAME}=${scenario.cookie}`,
  );
  context.mocks.browser.languages(scenario.languages);

  await setupPage({
    context,
    host: "app.okou.ai",
    path: "/missing-locale-page",
    auth: null,
  });

  expect(screen.getByRole("heading", { name: scenario.title })).toBeVisible();
  expect(document.documentElement).toHaveAttribute("lang", scenario.locale);
});

test("Use the browser's single language when its language list is empty", async () => {
  context.mocks.browser.language("fr-FR");
  context.mocks.browser.languages([]);

  await setupPage({
    context,
    host: "app.okou.ai",
    path: "/missing-locale-page",
    auth: null,
  });

  expect(
    screen.getByRole("heading", { name: "Cette page n'est pas ici." }),
  ).toBeVisible();
  expect(document.documentElement).toHaveAttribute("lang", "fr-FR");
});

test("Use locale hints on the development host", async () => {
  context.mocks.browser.languages(["fr-FR"]);

  await setupPage({
    context,
    host: "app.vm7.ai",
    path: "/missing-locale-page",
    auth: null,
  });

  expect(
    screen.getByRole("heading", { name: "Cette page n'est pas ici." }),
  ).toBeVisible();
  expect(document.documentElement).toHaveAttribute("lang", "fr-FR");
});

test("Render the initial page in English when locale assets are unavailable", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  context.mocks.browser.languages(["fr-FR"]);
  context.mocks.http.get(frFRCommonUrl, () => {
    return new HttpResponse(null, { status: 503 });
  });

  await setupPage({
    context,
    host: "app.okou.ai",
    path: "/missing-locale-page",
    auth: null,
  });

  expect(
    screen.getByRole("heading", { name: "That page isn't here." }),
  ).toBeVisible();
  expect(document.documentElement).toHaveAttribute("lang", "en-US");
  expect(consoleError).toHaveBeenCalledWith(
    "[E][Locale]",
    "Failed to initialize fr-FR; falling back to en-US",
    expect.any(Error),
  );
});
