import { expect, test as base } from "@playwright/test";

import { seedPreviewBypassCookie } from "./lib/preview-bypass";
import { browserHttpProxy } from "./lib/http-proxy";

interface PreviewBypassFixtures {
  readonly previewBypassCookie: void;
}

const test = base.extend<PreviewBypassFixtures>({
  proxy: async ({ proxy }, use) => {
    await use(browserHttpProxy() ?? proxy);
  },
  page: async ({ page }, use) => {
    try {
      await use(page);
    } finally {
      // UI assertions can finish while an intercepted upstream fetch is pending.
      await page.unrouteAll({ behavior: "wait" });
    }
  },
  previewBypassCookie: [
    async ({ baseURL, context }, use) => {
      if (!baseURL) {
        throw new Error("Playwright baseURL is required");
      }
      await seedPreviewBypassCookie(context, baseURL);
      await use();
    },
    { auto: true },
  ],
});

export { expect, test };
