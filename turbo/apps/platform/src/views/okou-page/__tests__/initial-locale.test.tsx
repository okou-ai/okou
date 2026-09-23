import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { OKOU_LOCALE_COOKIE_NAME } from "../../../i18n/locale-fallback.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

test.each([
  {
    scenario: "the site cookie takes precedence over browser languages",
    cookie: "v1.fr-FR",
    languages: ["ja-JP"],
    locale: "fr-FR",
  },
  {
    scenario: "the first supported browser language family is selected",
    cookie: "v1.unsupported",
    languages: ["sv-SE", "de-AT", "ja-JP"],
    locale: "de-DE",
  },
  {
    scenario: "a Taiwan browser reaches the Traditional bundle, not Simplified",
    cookie: null,
    languages: ["zh-TW"],
    locale: "zh-Hant",
  },
  {
    scenario: "English is used when no locale hint is supported",
    cookie: "v0.fr-FR",
    languages: ["sv-SE", "ar-SA"],
    locale: "en-US",
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

  expect(screen.getByRole("heading")).toBeInTheDocument();
  expect(document.documentElement).toHaveAttribute("lang", scenario.locale);
});
