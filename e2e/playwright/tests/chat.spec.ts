import { resolveApiBackendUrl } from "../api-backend-url";
import { expect, test } from "../fixtures";
import { deriveAppUrl } from "../playwright.config";

const appUrl = deriveAppUrl(resolveApiBackendUrl());
const MOBILE_VIEWPORT = { width: 402, height: 874 } as const;

function dialogImageFixture() {
  // Upload through the composer so the preview URL resolves a registered file.
  return {
    name: "dialog-safe-area.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGMIqFhAEmIY1TCqYfhqAAATWWgQLeF+owAAAABJRU5ErkJggg==",
      "base64",
    ),
  };
}

test("dialog width caps preserve the sm breakpoint and shrink on narrow screens", async ({
  page,
}) => {
  await page.goto(new URL("/agents", appUrl).href);
  await page.getByRole("button", { name: "New agent", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Create a new agent",
    exact: true,
  });
  await expect(dialog).toBeVisible();

  for (const scenario of [
    { viewport: 639, expectedWidth: 512 },
    { viewport: 640, expectedWidth: 480 },
    { viewport: 1280, expectedWidth: 480 },
    { viewport: 390, expectedWidth: 342 },
  ]) {
    await page.setViewportSize({ width: scenario.viewport, height: 900 });
    await expect
      .poll(async () => {
        const box = await dialog.boundingBox();
        return box ? Math.round(box.width) : null;
      })
      .toBe(scenario.expectedWidth);
  }
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toBeHidden();
});

for (const scenario of [
  { width: 402, height: 874, top: 62, right: 0, bottom: 34, left: 0 },
  { width: 874, height: 402, top: 0, right: 62, bottom: 21, left: 62 },
  { width: 390, height: 640, top: 59, right: 0, bottom: 34, left: 0 },
  { width: 1920, height: 1200, top: 0, right: 0, bottom: 0, left: 0 },
]) {
  test(`artifact dialog controls stay inside safe areas at ${scenario.width}x${scenario.height}`, async ({
    page,
  }) => {
    await page.goto(appUrl);
    await page.waitForURL(/agents\/.*\/chat/, { timeout: 30_000 });
    await expect(page.getByTestId("chat-tagline")).toBeVisible({
      timeout: 20_000,
    });

    // The lane's disposable account owns this thread and is cleaned up by global teardown.
    const [created] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/api/chat-threads",
      ),
      page
        .getByRole("button", { name: "New chat", exact: true })
        .last()
        .click(),
    ]);
    expect(created.status()).toBe(201);
    const thread: unknown = await created.json();
    if (
      typeof thread !== "object" ||
      thread === null ||
      !("id" in thread) ||
      typeof thread.id !== "string"
    ) {
      throw new Error("Expected the created dialog-test thread id");
    }
    await expect(page).toHaveURL(new URL(`/chats/${thread.id}`, appUrl).href);
    // Wait for the destination composer before attaching the owned fixture.
    const threadPage = page.getByRole("region", {
      name: "Chat thread",
      exact: true,
    });
    await expect(
      threadPage.getByRole("textbox", { name: "Message", exact: true }),
    ).toBeEditable();
    await threadPage
      .locator('input[type="file"][multiple]')
      .setInputFiles(dialogImageFixture());
    const imagePreview = threadPage.getByRole("button", {
      name: "Open image preview for dialog-safe-area.png",
      exact: true,
    });
    await expect(imagePreview).toBeEnabled({ timeout: 30_000 });
    await imagePreview.click();
    const dialog = page.getByTestId("attachment-lightbox");
    await expect(dialog).toBeVisible();
    const zoom = dialog.getByTestId("artifact-dialog-image-zoom-level");
    await expect(zoom).toHaveText("100%");
    await dialog.getByRole("button", { name: "Zoom in", exact: true }).click();
    await expect(zoom).toHaveText("115%");

    await page.setViewportSize({
      width: scenario.width,
      height: scenario.height,
    });
    await page.evaluate((insets) => {
      const style = document.documentElement.style;
      style.setProperty("--sat", `${insets.top}px`);
      style.setProperty("--sar", `${insets.right}px`);
      style.setProperty("--sab", `${insets.bottom}px`);
      style.setProperty("--sal", `${insets.left}px`);
    }, scenario);
    await expect
      .poll(async () => {
        const box = await dialog.boundingBox();
        return (
          box !== null &&
          box.x >= scenario.left + 23 &&
          box.y >= scenario.top + 23 &&
          box.x + box.width <= scenario.width - scenario.right - 23 &&
          box.y + box.height <= scenario.height - scenario.bottom - 23 &&
          Math.abs(
            box.x +
              box.width / 2 -
              (scenario.width + scenario.left - scenario.right) / 2,
          ) < 0.5 &&
          Math.abs(
            box.y +
              box.height / 2 -
              (scenario.height + scenario.top - scenario.bottom) / 2,
          ) < 0.5
        );
      })
      .toBe(true);
    const box = await dialog.boundingBox();
    if (!box) throw new Error("Expected the windowed preview bounds");
    expect(box.x + box.width / 2).toBeCloseTo(
      (scenario.width + scenario.left - scenario.right) / 2,
      0,
    );
    expect(box.y + box.height / 2).toBeCloseTo(
      (scenario.height + scenario.top - scenario.bottom) / 2,
      0,
    );
    if (scenario.width === 1920) {
      expect(box.width).toBeCloseTo(1440, 0);
      expect(box.height).toBeCloseTo(1000, 0);
    }

    await dialog
      .getByRole("button", { name: "Enter fullscreen", exact: true })
      .click();
    const exitFullscreen = dialog.getByRole("button", {
      name: "Exit fullscreen",
      exact: true,
    });
    await expect(exitFullscreen).toBeVisible();
    await expect(zoom).toHaveText("115%");
    for (const control of [
      exitFullscreen,
      dialog.getByRole("button", { name: "Close", exact: true }),
    ]) {
      await expect
        .poll(async () => {
          const rect = await control.boundingBox();
          return (
            rect !== null &&
            rect.x >= scenario.left &&
            rect.y >= scenario.top &&
            rect.x + rect.width <= scenario.width - scenario.right &&
            rect.y + rect.height <= scenario.height - scenario.bottom
          );
        })
        .toBe(true);
    }
    await exitFullscreen.click();
    await expect(
      dialog.getByRole("button", { name: "Enter fullscreen", exact: true }),
    ).toBeVisible();
    await expect(zoom).toHaveText("115%");

    // Native outside-press ownership must distinguish a drag from a deliberate click.
    const panel = await dialog.boundingBox();
    if (!panel)
      throw new Error("Expected the preview before testing dismissal");
    await page.mouse.move(
      panel.x + panel.width / 2,
      panel.y + panel.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(5, 5);
    await page.mouse.up();
    await expect(dialog).toBeVisible();
    await page.mouse.click(5, 5);
    await expect(dialog).toBeHidden();
  });
}

test("a short nested avatar dialog keeps its footer reachable by scrolling", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 640 });
  await page.goto(new URL("/agents", appUrl).href);
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--sat", "59px");
    document.documentElement.style.setProperty("--sab", "34px");
  });
  await page.getByRole("button", { name: "New agent", exact: true }).click();
  const agent = page.getByRole("dialog", {
    name: "Create a new agent",
    exact: true,
  });
  await agent
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Safe area draft");
  await agent
    .getByRole("button", { name: "Customize avatar", exact: true })
    .click();
  const avatar = page.getByRole("dialog", {
    name: /^(Edit avatar|Give your agent a face)$/,
  });
  await expect(avatar).toBeVisible();
  const avatarBox = await avatar.boundingBox();
  if (!avatarBox) throw new Error("Expected the avatar dialog bounds");
  // Use native scrolling before clicking: click's automatic scrollIntoView can
  // otherwise reach an action even when overflow-hidden prevents user scrolling.
  await page.mouse.move(avatarBox.x + 8, avatarBox.y + avatarBox.height / 2);
  await page.mouse.wheel(0, 1000);
  const useAvatar = avatar.getByRole("button", {
    name: "Use this avatar",
    exact: true,
  });
  await expect(useAvatar).toBeInViewport({ ratio: 1 });
  await useAvatar.click();
  await expect(avatar).toBeHidden();
  await expect(
    agent.getByRole("textbox", { name: "Name", exact: true }),
  ).toHaveValue("Safe area draft");
});

test("a short agent dialog keeps footer actions reachable after landscape reflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 640 });
  await page.goto(new URL("/agents", appUrl).href);
  await page.getByRole("button", { name: "New agent", exact: true }).click();
  const agent = page.getByRole("dialog", {
    name: "Create a new agent",
    exact: true,
  });
  await agent
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Safe area draft");
  await page.setViewportSize({ width: 874, height: 402 });
  await page.evaluate(() => {
    const style = document.documentElement.style;
    style.setProperty("--sat", "0px");
    style.setProperty("--sab", "21px");
    style.setProperty("--sal", "62px");
    style.setProperty("--sar", "62px");
  });
  const agentBox = await agent.boundingBox();
  if (!agentBox) throw new Error("Expected the agent dialog bounds");
  await page.mouse.move(agentBox.x + 8, agentBox.y + agentBox.height / 2);
  await page.mouse.wheel(0, 1000);
  await expect(
    agent.getByRole("button", { name: "Create", exact: true }),
  ).toBeInViewport({ ratio: 1 });
  const cancel = agent.getByRole("button", { name: "Cancel", exact: true });
  await expect(cancel).toBeInViewport({ ratio: 1 });
  await cancel.click();
  await expect(agent).toBeHidden();
});

test("chat page displays tagline after onboarding", async ({ page }) => {
  await page.goto(appUrl);
  await page.waitForURL(/agents\/.*\/chat/, { timeout: 30_000 });
  await expect(page.getByTestId("chat-tagline")).toBeVisible({
    timeout: 20_000,
  });
});

test("sidebar scrollbar meets the workspace edge without a mobile inset", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 520 });
  await page.goto(appUrl);
  await page.waitForURL(/agents\/.*\/chat/, { timeout: 30_000 });

  const chatList = page.getByTestId("chat-list-column");
  const scrollViewport = page.getByRole("region", { name: "Chat threads" });
  const scrollbar = chatList.getByTestId("sidebar-scrollbar");
  const workspace = page.getByTestId("workspace-inset");
  await expect(chatList).toBeVisible({ timeout: 20_000 });
  await expect(scrollViewport).toBeVisible({ timeout: 20_000 });
  await expect(workspace).toBeVisible({ timeout: 20_000 });

  // Populate the list through the product instead of trying to make the empty
  // state overflow by shrinking the viewport while the sidebar is loading.
  const newChatButton = chatList
    .getByRole("button", { name: "New chat", exact: true })
    .last();
  for (let index = 0; index < 20; index++) {
    const [response] = await Promise.all([
      page.waitForResponse((response) => {
        return (
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/api/chat-threads"
        );
      }),
      newChatButton.click(),
    ]);
    expect(response.status()).toBe(201);
    const thread: unknown = await response.json();
    if (
      typeof thread !== "object" ||
      thread === null ||
      !("id" in thread) ||
      typeof thread.id !== "string"
    ) {
      throw new Error("Expected the created chat thread to have an id");
    }
    await expect(page).toHaveURL(new URL(`/chats/${thread.id}`, appUrl).href);
    await expect(
      scrollViewport.locator(`a[href="/chats/${thread.id}"]`),
    ).toBeVisible();
  }

  await expect
    .poll(async () => {
      return scrollViewport.evaluate((element) => {
        return (
          element.clientHeight > 0 &&
          element.scrollHeight > element.clientHeight
        );
      });
    })
    .toBe(true);
  await expect(scrollbar).toBeVisible();

  const [chatListBox, scrollbarBox, workspaceBox] = await Promise.all([
    chatList.boundingBox(),
    scrollbar.boundingBox(),
    workspace.boundingBox(),
  ]);
  if (!chatListBox || !scrollbarBox || !workspaceBox) {
    throw new Error("Expected visible desktop sidebar geometry");
  }
  const desktopWorkspace = await workspace.evaluate((element) => {
    const style = getComputedStyle(element);
    const backgroundStyle = getComputedStyle(element, "::before");
    return {
      borderLeftWidth: Number.parseFloat(style.borderLeftWidth),
      marginBottom: Number.parseFloat(style.marginBottom),
      marginLeft: Number.parseFloat(style.marginLeft),
      marginRight: Number.parseFloat(style.marginRight),
      marginTop: Number.parseFloat(style.marginTop),
      paddingLeft: Number.parseFloat(style.paddingLeft),
      backgroundLeft: Number.parseFloat(backgroundStyle.left),
    };
  });
  const chatListRight = chatListBox.x + chatListBox.width;
  const scrollbarRight = scrollbarBox.x + scrollbarBox.width;
  const workspaceSurfaceLeft = workspaceBox.x + desktopWorkspace.paddingLeft;
  expect(workspaceSurfaceLeft).toBeCloseTo(chatListRight, 0);
  expect(workspaceBox.x - scrollbarRight).toBeGreaterThanOrEqual(0);
  expect(workspaceBox.x - scrollbarRight).toBeLessThanOrEqual(2);
  expect(desktopWorkspace).toMatchObject({
    backgroundLeft: 0,
    marginBottom: 8,
    marginLeft: 0,
    marginRight: 8,
    marginTop: 8,
    paddingLeft: 0,
  });
  expect(desktopWorkspace.borderLeftWidth).toBeGreaterThan(0);

  await page.setViewportSize(MOBILE_VIEWPORT);
  await expect(chatList).toBeHidden();
  const mobileWorkspace = await workspace.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      borderLeftWidth: Number.parseFloat(style.borderLeftWidth),
      bottom: rect.bottom,
      left: rect.left,
      marginBottom: Number.parseFloat(style.marginBottom),
      marginLeft: Number.parseFloat(style.marginLeft),
      marginRight: Number.parseFloat(style.marginRight),
      marginTop: Number.parseFloat(style.marginTop),
      right: rect.right,
      top: rect.top,
    };
  });
  expect(mobileWorkspace).toEqual({
    borderLeftWidth: 0,
    bottom: MOBILE_VIEWPORT.height,
    left: 0,
    marginBottom: 0,
    marginLeft: 0,
    marginRight: 0,
    marginTop: 0,
    right: MOBILE_VIEWPORT.width,
    top: 0,
  });
});

test.describe("dark theme", () => {
  test.use({ colorScheme: "dark" });

  test("focused composer does not cast a dark veil", async ({ page }) => {
    await page.goto(`${appUrl}/agents?settings=preference`);
    const systemTheme = page
      .getByRole("dialog", { name: "Settings" })
      .getByRole("button", { name: "System", exact: true });
    await systemTheme.click();
    await expect(systemTheme).toHaveAttribute("aria-pressed", "true");

    await page.goto(appUrl);
    await page.waitForURL(/agents\/.*\/chat/, { timeout: 30_000 });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    const composer = page.locator('[data-slot="chat-composer-card"]');
    const editor = composer.getByRole("textbox", { name: "Message" });
    await editor.focus();
    await expect(editor).toBeFocused();
    await expect
      .poll(async () => {
        return composer.evaluate((element) => {
          return getComputedStyle(element, "::after").boxShadow;
        });
      })
      .toBe("none");
  });
});

test("send a message through the deployed runner", async ({ page }) => {
  test.setTimeout(120_000);
  const marker = `PRODUCT_CHAT_E2E_${Date.now()}`;

  await page.goto(appUrl);
  await page.waitForURL(/agents\/.*\/chat/, { timeout: 30_000 });

  const composer = page.locator('[data-slot="chat-composer-card"]');
  const editor = composer.getByRole("textbox", { name: "Message" });
  await expect(editor).toBeVisible();
  await editor.fill(`printf ${marker}`);
  await composer.getByRole("button", { name: "Send" }).click();

  await expect(
    page.locator('[data-role="assistant"]').filter({ hasText: marker }).first(),
  ).toBeVisible({ timeout: 90_000 });
});
