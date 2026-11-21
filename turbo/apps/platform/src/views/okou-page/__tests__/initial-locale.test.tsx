import { waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

test.each([
  { id: "001", cookie: "v1.fr-FR", languages: ["ja-JP"], lang: "fr-FR" },
  {
    id: "002",
    cookie: "v1.unknown",
    languages: ["sv-SE", "de-AT", "ja-JP"],
    lang: "de-DE",
  },
])(
  "initial-locale-$id opens sign-in in $lang",
  async ({ cookie, languages, lang }) => {
    context.mocks.browser.languages(languages);
    context.mocks.browser.cookie(`__Secure-okou-locale=${cookie}`);
    await setupPage({ context, path: "/sign-in", auth: null });
    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute("lang", lang);
    });
  },
);
