/**
 * MSW Node Server Setup
 *
 * This configures MSW to run in Node.js for testing.
 * The server intercepts requests at the network level without needing a browser.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { handlers } from "./handlers/index.ts";
import enUSAgentsUrl from "../i18n/locales/en-US/agents.json?url";
import enUSCommonUrl from "../i18n/locales/en-US/common.json?url";

// Serve the real default-language assets without importing JSON as typed modules.
// Non-default locales retain the shared placeholder/fallback behavior.
const defaultLocaleAssets = [
  [
    enUSAgentsUrl,
    resolve(import.meta.dirname, "../i18n/locales/en-US/agents.json"),
  ],
  [
    enUSCommonUrl,
    resolve(import.meta.dirname, "../i18n/locales/en-US/common.json"),
  ],
] as const;

export const server = setupServer(
  ...defaultLocaleAssets.map(([url, file]) => {
    const resource = readFileSync(file, "utf8");
    return http.get(url, () => {
      return new HttpResponse(resource, {
        headers: { "Content-Type": "application/json" },
      });
    });
  }),
  ...handlers,
);
