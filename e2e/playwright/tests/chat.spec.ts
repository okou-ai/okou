import { resolveApiBackendUrl } from "../api-backend-url";
import { expect, test } from "../fixtures";
import { deriveAppUrl } from "../playwright.config";

const appUrl = deriveAppUrl(resolveApiBackendUrl());
const MOBILE_VIEWPORT = { width: 402, height: 874 } as const;

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

test("sidebar scrollbar thumb meets the workspace edge without a mobile inset", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 520 });
  await page.goto(appUrl);
  await page.waitForURL(/agents\/.*\/chat/, { timeout: 30_000 });

  const chatList = page.getByTestId("chat-list-column");
  const scrollViewport = page.getByRole("region", { name: "Chat threads" });
  const scrollbar = chatList.getByTestId("sidebar-scrollbar");
  const scrollbarThumb = scrollbar.locator('[data-slot="scroll-area-thumb"]');
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
  await scrollViewport.hover();
  await expect(scrollbar).toHaveCSS("opacity", "1");
  await expect(scrollbarThumb).toBeVisible();

  const [chatListBox, scrollbarBox, scrollbarThumbBox, workspaceBox] =
    await Promise.all([
      chatList.boundingBox(),
      scrollbar.boundingBox(),
      scrollbarThumb.boundingBox(),
      workspace.boundingBox(),
    ]);
  if (!chatListBox || !scrollbarBox || !scrollbarThumbBox || !workspaceBox) {
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
  const scrollbarThumbRight = scrollbarThumbBox.x + scrollbarThumbBox.width;
  const workspaceSurfaceLeft = workspaceBox.x + desktopWorkspace.paddingLeft;
  expect(workspaceSurfaceLeft).toBeCloseTo(chatListRight, 0);
  expect(workspaceBox.x - scrollbarRight).toBeGreaterThanOrEqual(0);
  expect(workspaceBox.x - scrollbarRight).toBeLessThanOrEqual(2);
  expect(workspaceBox.x - scrollbarThumbRight).toBeGreaterThanOrEqual(0);
  expect(workspaceBox.x - scrollbarThumbRight).toBeLessThanOrEqual(2);
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

test("send a long reply through the deployed runner and scroll its messages", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 800 });
  const marker = `PRODUCT_CHAT_E2E_${Date.now()}`;
  const replyLines = Array.from({ length: 40 }, (_, index) => {
    return `${marker} line ${index + 1}`;
  });

  await page.goto(appUrl);
  await page.waitForURL(/agents\/.*\/chat/, { timeout: 30_000 });

  const composer = page.locator('[data-slot="chat-composer-card"]');
  const editor = composer.getByRole("textbox", { name: "Message" });
  await expect(editor).toBeVisible();
  await editor.fill(`printf '${replyLines.join("\\n\\n")}'`);
  await composer.getByRole("button", { name: "Send" }).click();

  await expect(
    page.locator('[data-role="assistant"]').filter({ hasText: marker }).first(),
  ).toContainText(`${marker} line 40`, { timeout: 90_000 });

  const threadPage = page.getByRole("region", {
    name: "Chat thread",
    exact: true,
  });
  const viewport = threadPage.locator("[data-scroll-container]");
  const scrollbar = threadPage.getByTestId("chat-message-scrollbar");
  const thumb = scrollbar.locator('[data-slot="scroll-area-thumb"]');
  await composer.hover();
  await expect(scrollbar).toHaveCSS("opacity", "0");
  await expect(scrollbar).toHaveCSS("pointer-events", "none");
  await viewport.hover();
  await expect(scrollbar).toHaveCSS("opacity", "1");
  await expect(scrollbar).toHaveCSS("pointer-events", "auto");
  await expect(thumb).toBeVisible();
  await expect
    .poll(async () => {
      return viewport.evaluate((element) => {
        return element.scrollHeight - element.scrollTop - element.clientHeight;
      });
    })
    .toBeLessThanOrEqual(10);

  const [viewportBox, thumbBox] = await Promise.all([
    viewport.boundingBox(),
    thumb.boundingBox(),
  ]);
  if (!viewportBox || !thumbBox) {
    throw new Error("Expected the message viewport and scrollbar thumb");
  }
  const thumbGap =
    viewportBox.x + viewportBox.width - (thumbBox.x + thumbBox.width);
  expect(thumbGap).toBeGreaterThanOrEqual(0);
  expect(thumbGap).toBeLessThanOrEqual(2);

  const scrollTopBeforeDrag = await viewport.evaluate((element) => {
    return element.scrollTop;
  });
  const thumbX = thumbBox.x + thumbBox.width / 2;
  const thumbY = thumbBox.y + thumbBox.height / 2;
  await page.mouse.move(thumbX, thumbY);
  await page.mouse.down();
  await page.mouse.move(thumbX, thumbY - 80);
  await page.mouse.up();
  await expect
    .poll(async () => {
      return viewport.evaluate((element) => {
        return element.scrollTop;
      });
    })
    .toBeLessThan(scrollTopBeforeDrag);

  await composer.hover();
  await expect(scrollbar).toHaveCSS("opacity", "0");
  await expect(scrollbar).toHaveCSS("pointer-events", "none");

  const scrollToBottom = threadPage.locator("[data-scroll-to-bottom]");
  await expect(scrollToBottom).toBeVisible();
  await scrollToBottom.click();
  await expect(scrollToBottom).toBeHidden();
  await expect
    .poll(async () => {
      return viewport.evaluate((element) => {
        return element.scrollHeight - element.scrollTop - element.clientHeight;
      });
    })
    .toBeLessThanOrEqual(10);
});
