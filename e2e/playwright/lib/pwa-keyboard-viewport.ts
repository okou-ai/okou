import { expect, type Page } from "@playwright/test";

import { authHeadersForToken } from "./onboarding";
import { refreshClerkSessionToken } from "./auth";

/**
 * Desktop Chromium cannot open a software keyboard or emulate display-mode.
 * Supply those browser inputs, keeping the deployed page, CSS declarations,
 * editor and layout engine real. This is not a native iOS acceptance test.
 */
export async function checkShortPwaComposer(
  page: Page,
  apiUrl: string,
): Promise<void> {
  const token = await refreshClerkSessionToken(page);
  const response = await page.request.post(
    new URL("/api/feature-switches", apiUrl).href,
    {
      headers: authHeadersForToken(token),
      data: { switches: { pwaKeyboardViewport: true } },
    },
  );
  expect(response.ok()).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    const matchMedia = window.matchMedia.bind(window);
    window.matchMedia = (query) => {
      const media = matchMedia(query);
      if (query === "(display-mode: standalone)") {
        Object.defineProperty(media, "matches", { value: true });
      }
      return media;
    };
    class KeyboardViewport extends EventTarget {
      height = 844;
      width = 390;
      offsetTop = 0;
      offsetLeft = 0;
      pageTop = 0;
      pageLeft = 0;
      scale = 1;
    }
    const viewport = new KeyboardViewport();
    Object.defineProperty(window, "visualViewport", { value: viewport });
    window.addEventListener("test:keyboard-viewport", (event) => {
      const { height, top } = (
        event as CustomEvent<{
          height: number;
          top: number;
        }>
      ).detail;
      viewport.height = height;
      viewport.offsetTop = top;
      viewport.pageTop = top;
      viewport.dispatchEvent(new Event("resize"));
    });
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  const editor = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(editor).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute(
    "data-pwa-keyboard-viewport",
    "true",
  );
  await page.evaluate(() => {
    let matched = 0;
    function enableStandaloneMedia(rules: CSSRuleList): void {
      for (const rule of rules) {
        if (
          rule instanceof CSSMediaRule &&
          rule.conditionText === "(display-mode: standalone)"
        ) {
          rule.media.mediaText = "all";
          matched += 1;
        }
        if (rule instanceof CSSGroupingRule) {
          enableStandaloneMedia(rule.cssRules);
        }
      }
    }
    for (const sheet of document.styleSheets) {
      // Vite loads app styles from the asset CDN with crossorigin. Unrelated
      // non-CORS sheets (such as hosted fonts) cannot expose their CSSOM.
      const owner = sheet.ownerNode;
      if (
        sheet.href &&
        new URL(sheet.href).origin !== location.origin &&
        !(owner instanceof HTMLLinkElement && owner.hasAttribute("crossorigin"))
      ) {
        continue;
      }
      enableStandaloneMedia(sheet.cssRules);
    }
    if (matched === 0) {
      throw new Error("The deployed standalone stylesheet was not loaded");
    }
  });
  const draft = Array.from(
    { length: 16 },
    (_, i) => `Draft line ${i + 1}`,
  ).join("\n");
  await editor.fill(draft);

  for (const height of [420, 200, 420]) {
    await editor.focus();
    await page.evaluate((height) => {
      window.dispatchEvent(
        new CustomEvent("test:keyboard-viewport", {
          detail: { height, top: 160 },
        }),
      );
    }, height);
    await expect
      .poll(() =>
        page.locator("#root").evaluate((root) => {
          const bounds = root.getBoundingClientRect();
          return { height: bounds.height, top: bounds.top };
        }),
      )
      .toEqual({ height, top: 160 });
    const scrollport = page.locator("[data-chat-composer] > div");
    await scrollport.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const send = page.getByRole("button", { name: "Send", exact: true });
    await expect(send).toBeEnabled();
    await expect
      .poll(() =>
        send.evaluate((button) => {
          const bounds = button.getBoundingClientRect();
          const root = document.getElementById("root")?.getBoundingClientRect();
          const hit = document.elementFromPoint(
            bounds.left + bounds.width / 2,
            bounds.top + bounds.height / 2,
          );
          return Boolean(
            root &&
            bounds.top >= root.top &&
            bounds.bottom <= root.bottom &&
            hit &&
            button.contains(hit),
          );
        }),
      )
      .toBe(true);
    await send.click({ trial: true });
    await expect
      .poll(async () => (await editor.innerText()).split(/\n+/u))
      .toEqual(draft.split("\n"));
  }
  await editor.evaluate((element) => element.blur());
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("test:keyboard-viewport", {
        detail: { height: 844, top: 0 },
      }),
    );
  });
  await expect
    .poll(() =>
      page
        .locator("#root")
        .evaluate((root) => root.getBoundingClientRect().height),
    )
    .toBe(844);
}
