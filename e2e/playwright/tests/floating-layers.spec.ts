import type { Locator } from "@playwright/test";

import { resolveApiBackendUrl } from "../api-backend-url";
import { expect, test } from "../fixtures";
import { deriveAppUrl } from "../playwright.config";

const appUrl = deriveAppUrl(resolveApiBackendUrl());

test.use({ viewport: { width: 1440, height: 900 } });

async function centerOf(locator: Locator) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error("Expected visible element geometry");
  }
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function expectHitWithin(
  surface: Locator,
  point: { x: number; y: number },
) {
  // Visibility and z-index alone do not tell us which surface receives input.
  await expect
    .poll(async () => {
      return surface.evaluate((element, position) => {
        const hit = document.elementFromPoint(position.x, position.y);
        return hit !== null && element.contains(hit);
      }, point);
    })
    .toBe(true);
}

test("fullscreen artifacts cover sidebar actions and restore their interaction on exit", async ({
  page,
}) => {
  await page.goto(appUrl);
  await page.waitForURL(/agents\/.*\/chat/, { timeout: 30_000 });
  const chatList = page.getByTestId("chat-list-column");
  const newChat = chatList
    .getByRole("button", { name: "New chat", exact: true })
    .last();
  await newChat.click();
  await page.waitForURL(/\/chats\/[^/]+$/, { timeout: 20_000 });

  const listMenu = chatList.getByRole("button", {
    name: "Open chat list menu",
  });
  const sidebarPoints = [await centerOf(newChat), await centerOf(listMenu)];
  await page
    .getByRole("button", { name: "Open artifacts", exact: true })
    .click();
  const panel = page.getByRole("complementary", { name: "Artifacts" });
  await expect(panel).toBeVisible();

  // An empty catalog is sufficient: the regression is the shell's paint order,
  // independent of artifact generation or which preview format is loaded.
  for (let toggle = 0; toggle < 2; toggle++) {
    await panel.getByRole("button", { name: "Enter fullscreen" }).click();
    const exit = panel.getByRole("button", { name: "Exit fullscreen" });
    await expect(exit).toBeVisible();
    for (const point of sidebarPoints) {
      await expectHitWithin(panel, point);
    }

    // The public rename shortcut opens a body-level dialog while the app's
    // fullscreen layer is still present. Its controls must win that overlap.
    await page.keyboard.press("F2");
    const rename = page.getByRole("dialog");
    const title = rename.getByRole("textbox");
    await expectHitWithin(title, await centerOf(title));
    await title.fill("Unsaved fullscreen title");
    await rename.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(rename).toBeHidden();
    await expect(exit).toBeVisible();

    await exit.click();
    await expect(
      panel.getByRole("button", { name: "Enter fullscreen" }),
    ).toBeVisible();
    await expectHitWithin(listMenu, await centerOf(listMenu));
    await listMenu.click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    const item = menu.getByRole("menuitem").first();
    await expectHitWithin(item, await centerOf(item));
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(panel).toBeVisible();
  }
});

test("a nested avatar dialog receives input above its parent and dismisses independently", async ({
  page,
}) => {
  await page.goto(`${appUrl}/agents`);
  await page.getByRole("radio", { name: "Private", exact: true }).click();
  await page
    .getByRole("button", { name: /^(New agent|Create agent)$/ })
    .first()
    .click();
  const parent = page.getByRole("dialog", { name: "Create a new agent" });
  const name = parent.getByPlaceholder("e.g. Research Assistant");
  await name.fill("Floating layer draft");
  const customize = parent.getByRole("button", { name: "Customize avatar" });
  await customize.click();

  const nested = page.getByRole("dialog", { name: "Give your agent a face" });
  const next = nested.getByRole("button", { name: "Next step" });
  await expectHitWithin(next, await centerOf(next));
  await next.click();
  await expect(nested.getByText("Hair", { exact: true })).toBeVisible();
  const option = nested.getByRole("button", { name: "High bun" });
  await expectHitWithin(option, await centerOf(option));
  await option.click();

  await page.keyboard.press("Escape");
  await expect(nested).toBeHidden();
  await expect(parent).toBeVisible();
  await expect(name).toHaveValue("Floating layer draft");
  await expect(customize).toBeFocused();
  await expectHitWithin(customize, await centerOf(customize));
  await parent.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(parent).toBeHidden();
});

test("a select receives input above its settings dialog and Escape closes only the select", async ({
  page,
}) => {
  await page.goto(`${appUrl}/agents?settings=preference`);
  const settings = page.getByRole("dialog", { name: "Settings" });
  const timezone = settings
    .locator('[data-slot="timezone-setting"]')
    .getByRole("combobox");
  await timezone.click();
  const listbox = page.getByRole("listbox");
  await expect(listbox).toBeVisible();
  const option = listbox.getByRole("option", { selected: true });
  await expectHitWithin(option, await centerOf(option));

  // Dismiss without changing the shared test account's timezone preference.
  await page.keyboard.press("Escape");
  await expect(listbox).toBeHidden();
  await expect(settings).toBeVisible();
  await expect(timezone).toBeFocused();
  await expectHitWithin(timezone, await centerOf(timezone));
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
});
