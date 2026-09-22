import type { Locator } from "@playwright/test";

import { resolveApiBackendUrl } from "../api-backend-url";
import { expect, test } from "../fixtures";
import { deriveAppUrl } from "../playwright.config";

const appUrl = deriveAppUrl(resolveApiBackendUrl());

test.use({ viewport: { width: 1440, height: 900 } });

async function slashTokenBox(editor: Locator) {
  return editor.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      if (node.textContent === "/") {
        const range = document.createRange();
        range.setStart(node, 0);
        range.setEnd(node, 1);
        const rect = range.getBoundingClientRect();
        return { top: rect.top, right: rect.right, height: rect.height };
      }
      node = walker.nextNode();
    }
    throw new Error("Expected the slash token in the composer draft");
  });
}

async function expectMenuAtSlash(editor: Locator, menu: Locator) {
  await expect
    .poll(async () => {
      const token = await slashTokenBox(editor);
      const box = await menu.boundingBox();
      if (!box) {
        throw new Error("Expected visible suggestion menu geometry");
      }
      return Math.abs(token.top - (box.y + box.height) - 8);
    })
    .toBeLessThan(1);
}

test("slash suggestions follow the text when the composer itself scrolls", async ({
  page,
}) => {
  await page.goto(appUrl);
  await page.waitForURL(/agents\/.*\/chat/, { timeout: 30_000 });
  await page
    .getByTestId("chat-list-column")
    .getByRole("button", { name: "New chat", exact: true })
    .last()
    .click();
  await page.waitForURL(/\/chats\/[^/]+$/, { timeout: 20_000 });

  const editor = page.getByRole("textbox", { name: "Message", exact: true });
  const menu = page.getByTestId("slash-workflow-menu");
  await editor.fill("");
  // A long ordinary draft makes the editable area scroll. The slash remains
  // visible in its middle; no workflows or generated content are needed.
  for (let line = 0; line < 17; line++) {
    if (line > 0) {
      await page.keyboard.press("Shift+Enter");
    }
    await page.keyboard.insertText(line === 8 ? "/" : `Draft line ${line}`);
  }
  await expect(menu).toBeHidden();

  const viewport = await page.evaluate(() => {
    return { width: innerWidth, height: innerHeight, scrollX, scrollY };
  });

  // Exercise both directions and a fresh open after Escape so each menu owns
  // its tracking lifetime, while the editor keeps keyboard focus throughout.
  for (const scrollDelta of [-48, 48]) {
    const token = await slashTokenBox(editor);
    await page.mouse.click(token.right + 2, token.top + token.height / 2);
    await expect(menu).toBeVisible();
    await expect(
      menu.getByText("Loading workflows...", { exact: true }),
    ).toBeHidden();
    await expect(editor).toBeFocused();
    await expectMenuAtSlash(editor, menu);

    const before = await slashTokenBox(editor);
    const scrollTop = await editor.evaluate((element) => element.scrollTop);
    if (scrollDelta < 0) {
      expect(scrollTop).toBeGreaterThan(-scrollDelta);
    }

    // This is native DOM scrolling, which emits the browser's scroll event.
    // No typing, selection change, window scroll, or resize can reposition the
    // popup on its behalf while the token moves inside the editable area.
    await editor.evaluate((element, delta) => {
      element.scrollBy({ top: delta, behavior: "instant" });
    }, scrollDelta);
    await expect
      .poll(() => editor.evaluate((element) => element.scrollTop))
      .toBeCloseTo(scrollTop + scrollDelta, 1);
    await expect
      .poll(async () => (await slashTokenBox(editor)).top)
      .toBeCloseTo(before.top - scrollDelta, 1);
    await expectMenuAtSlash(editor, menu);
    await expect(editor).toBeFocused();
    expect(
      await page.evaluate(() => {
        return { width: innerWidth, height: innerHeight, scrollX, scrollY };
      }),
    ).toEqual(viewport);

    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(editor).toBeFocused();
    await page.keyboard.press("ArrowLeft");
  }
  await editor.fill("");
});
