import { http, HttpResponse } from "msw";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import enUSHalloweenUrl from "../../i18n/locales/en-US/halloween.json?url";

// Tests do not cover translated copy. Serve a placeholder resource for every
// non-default locale so i18next falls back to en-US strings while locale
// selection, persistence, and formatting still run through production code.
// The placeholder key keeps the bundle non-empty: i18next only resolves a
// language that has at least one translation.
const localeResourceUrls = import.meta.glob<string>(
  "../../i18n/locales/*/*.json",
  { eager: true, import: "default", query: "?url" },
);

// The Node-only MSW server serves the asset bytes without adding a typed JSON
// resource to the test module graph.
const enUSHalloween = readFileSync(
  resolve(import.meta.dirname, "../../i18n/locales/en-US/halloween.json"),
  "utf8",
);

export const localeResourceHandlers = [
  http.get(enUSHalloweenUrl, () => {
    return new HttpResponse(enUSHalloween, {
      headers: { "Content-Type": "application/json" },
    });
  }),
  ...Object.entries(localeResourceUrls)
    .filter(([path]) => {
      return !path.includes("/en-US/");
    })
    .map(([, url]) => {
      return http.get(url, () => {
        return HttpResponse.json({ testPlaceholder: "" });
      });
    }),
];
