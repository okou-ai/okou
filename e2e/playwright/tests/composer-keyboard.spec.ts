import type { Locator, Page } from "@playwright/test";

import { resolveApiBackendUrl } from "../api-backend-url";
import { expect, test } from "../fixtures";
import { deriveAppUrl } from "../playwright.config";

const appUrl = deriveAppUrl(resolveApiBackendUrl());

test.use({ viewport: { width: 1440, height: 900 } });

const appleBrowsers = [
  {
    name: "iPhone",
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) " +
      "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 " +
      "Mobile/15E148 Safari/604.1",
    platform: "iPhone",
    maxTouchPoints: 5,
  },
  {
    name: "iPad desktop mode",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) " +
      "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
    platform: "MacIntel",
    maxTouchPoints: 5,
  },
] as const;

async function openEmptyChat(page: Page): Promise<Locator> {
  await page.goto(appUrl);
  await page.waitForURL(/agents\/.*\/chat/, { timeout: 30_000 });
  await page
    .getByTestId("chat-list-column")
    .getByRole("button", { name: "New chat", exact: true })
    .last()
    .click();
  await page.waitForURL(/\/chats\/[^/]+$/, { timeout: 20_000 });
  const editor = page.getByRole("textbox", { name: "Message", exact: true });
  await editor.fill("");
  return editor;
}

async function expectSingleNewline(
  page: Page,
  editor: Locator,
  firstLine: string,
): Promise<void> {
  await page.keyboard.press("Shift+Enter");
  // Real subsequent keystrokes span ProseMirror's delayed iOS Enter replay.
  // An immediate paragraph assertion alone misses the extra line it adds later.
  await page.keyboard.type("Second line", { delay: 40 });
  await expect
    .poll(() => editor.innerText())
    .toBe(`${firstLine}\n\nSecond line`);
  await expect(editor.locator("p")).toHaveText([firstLine, "Second line"]);
  await expect(editor.locator("br")).toHaveCount(0);
  await expect(editor).toBeFocused();
}

for (const browser of appleBrowsers) {
  test(`${browser.name} Shift+Enter inserts one paragraph and respects composition`, async ({
    context,
    page,
  }) => {
    // Chromium exercises ProseMirror's iOS compatibility path here, not native
    // WebKit or an operating-system IME. Its browser flags are fixed at module
    // initialization, so the environment must be present before page.goto().
    await page.addInitScript((environment) => {
      Object.defineProperties(navigator, {
        vendor: { configurable: true, get: () => "Apple Computer, Inc." },
        userAgent: {
          configurable: true,
          get: () => environment.userAgent,
        },
        platform: { configurable: true, get: () => environment.platform },
        maxTouchPoints: {
          configurable: true,
          get: () => environment.maxTouchPoints,
        },
      });
    }, browser);

    // These cases never request submission. Abort any event POST reaching this
    // context route if a shortcut regresses, rather than starting an agent run.
    // This guard does not establish coverage of every worker network path.
    let submissionAttempts = 0;
    await context.route(/\/api\/chat\/events(?:\?.*)?$/, async (route) => {
      if (route.request().method() === "POST") {
        submissionAttempts += 1;
        await route.abort();
        return;
      }
      await route.continue();
    });

    const editor = await openEmptyChat(page);
    const menu = page.getByTestId("slash-workflow-menu");

    await test.step("an ordinary draft gains exactly one new paragraph", async () => {
      await editor.fill("First line");
      await expect(menu).toBeHidden();
      await expectSingleNewline(page, editor, "First line");
    });

    await test.step("Shift+Enter leaves slash suggestions unselected", async () => {
      await editor.fill("/");
      await expect(menu).toBeVisible();
      await expectSingleNewline(page, editor, "/");
      await expect(menu).toBeHidden();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(
        editor.locator("[data-composer-inline-template]"),
      ).toHaveCount(0);
    });

    await test.step("composition Enter does not split or submit the draft", async () => {
      await editor.fill("Composition draft");
      // Playwright cannot drive an OS candidate window. These synthetic events
      // check the composition boundary, including Safari's keyCode 229 after
      // compositionend; they do not claim to verify native IME text insertion.
      await editor.dispatchEvent("compositionstart", { data: "" });
      await editor.dispatchEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        shiftKey: true,
        isComposing: true,
      });
      await editor.dispatchEvent("compositionend", { data: "" });
      await editor.dispatchEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 229,
        shiftKey: true,
        isComposing: false,
      });
      await page.keyboard.type(" continued", { delay: 40 });
      await expect
        .poll(() => editor.innerText())
        .toBe("Composition draft continued");
      await expect(editor.locator("p")).toHaveText([
        "Composition draft continued",
      ]);
      await expect(editor.locator("br")).toHaveCount(0);
      await expect(editor).toBeFocused();
    });

    await test.step("the first Enter after compositionend keeps the draft intact", async () => {
      await editor.fill("Confirmed composition");
      // Safari can finish composition before delivering the confirming Enter,
      // with neither isComposing nor keyCode 229. Dispatch this synthetic guard
      // scenario together so browser-command latency cannot leave the boundary.
      await editor.evaluate((element) => {
        element.dispatchEvent(
          new CompositionEvent("compositionstart", { bubbles: true }),
        );
        element.dispatchEvent(
          new CompositionEvent("compositionend", { bubbles: true }),
        );
        element.dispatchEvent(
          new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            shiftKey: true,
            isComposing: false,
          }),
        );
      });
      await expect.poll(() => editor.innerText()).toBe("Confirmed composition");
      await expect(editor.locator("p")).toHaveText(["Confirmed composition"]);
      await expect(editor.locator("br")).toHaveCount(0);
      // That first event only confirms composition. The next intentional
      // Shift+Enter must be usable immediately, without suppressing it again.
      await expectSingleNewline(page, editor, "Confirmed composition");
    });

    expect(submissionAttempts).toBe(0);
    await expect(page.locator('[data-role="user"]')).toHaveCount(0);
    await editor.fill("");
  });
}
