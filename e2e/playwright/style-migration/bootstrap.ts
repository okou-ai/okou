import type { Page } from "@playwright/test";

// The App Worker can embed API responses in the document before browser fetches.
// Keep those external responses consistent with the same API fixtures.
export async function fixtureBootstrap(
  page: Page,
  appOrigin: string,
  fixtures: () => Record<string, unknown>,
  artifactOrigin = appOrigin,
) {
  await page.route(
    (url) => url.origin === appOrigin,
    async (route) => {
      if (route.request().resourceType() !== "document") {
        await route.fallback();
        return;
      }
      const requested = new URL(route.request().url());
      const artifactUrl = new URL(
        `${requested.pathname}${requested.search}`,
        artifactOrigin,
      );
      const response = await route.fetch({ url: artifactUrl.href });
      const body = (await response.text())
        .replaceAll(`${artifactOrigin}/`, `${appOrigin}/`)
        .replace(
          /(<script\b[^>]*data-okou-api-bootstrap[^>]*>)([\s\S]*?)(<\/script>)/g,
          (script: string, open: string, _json: string, close: string) => {
            const encodedPath = /data-path="([^"]+)"/.exec(open)?.[1];
            if (!encodedPath) return script;
            const value = fixtures()[decodeURIComponent(encodedPath)];
            if (value === undefined) return script;
            return `${open}${JSON.stringify(value)
              .replaceAll("<", "\\u003c")
              .replaceAll("\u2028", "\\u2028")
              .replaceAll("\u2029", "\\u2029")}${close}`;
          },
        );
      await route.fulfill({ response, body });
    },
  );
}
