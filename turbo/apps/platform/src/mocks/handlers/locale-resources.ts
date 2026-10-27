import { http, HttpResponse } from "msw";
import enUSHalloween from "../../i18n/locales/en-US/halloween.json";
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

export const localeResourceHandlers = [
  http.get(enUSHalloweenUrl, () => {
    return HttpResponse.json(enUSHalloween);
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
