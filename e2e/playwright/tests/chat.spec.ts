import { resolveApiBackendUrl } from "../api-backend-url";
import { expect, test } from "../fixtures";
import { deriveAppUrl } from "../playwright.config";

const appUrl = deriveAppUrl(resolveApiBackendUrl());
const MOBILE_VIEWPORT = { width: 402, height: 874 } as const;

interface GreetingFrame {
  readonly text: string;
  readonly rowLeft: number;
  readonly rowRight: number;
  readonly avatarWidth: number;
  readonly avatarHeight: number;
  readonly containerLeft: number;
  readonly containerRight: number;
  readonly lineCount: number;
}

interface GreetingCapture {
  readonly text: string;
  readonly frames: GreetingFrame[];
  /** The CSS animation on each word box, read once when the greeting appears. */
  readonly animationNames: string[];
  /** Each word box's animation-delay in milliseconds, in reading order. */
  readonly delays: number[];
}

declare global {
  interface Window {
    recordChatGreeting?: (capture: GreetingCapture) => Promise<void>;
  }
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

test("a mobile greeting arrives without moving its row or cutting its text", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  // Warm the actual product fonts before observing the entrance animation.
  await page.goto(new URL("/agents", appUrl).href);
  await expect(
    page.getByRole("button", { name: "New agent", exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => {
      return page.evaluate(async () => {
        const faces = await document.fonts.load("600 24px Geist");
        return faces.some((face) => face.status === "loaded");
      });
    })
    .toBe(true);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));

  const observed: { capture?: GreetingCapture } = {};
  await page.exposeFunction(
    "recordChatGreeting",
    (capture: GreetingCapture) => {
      observed.capture = capture;
    },
  );
  await page.addInitScript(() => {
    const frames: GreetingFrame[] = [];
    let text = "";
    let startedAt = 0;
    let animationNames: string[] = [];
    let delays: number[] = [];
    const sample = () => {
      const heading = document.querySelector('[data-testid="chat-tagline"]');
      const line = heading?.querySelector('[data-slot="chat-tagline-text"]');
      const row = heading?.closest('[data-slot="chat-greeting"]');
      const avatar = row?.querySelector("a");
      const container = row?.parentElement;
      const currentText = heading?.getAttribute("aria-label");
      // Setup creates this ordinary first name through Clerk before any
      // feature test starts; the product still chooses its own greeting.
      if (
        !currentText?.includes("Christopher") ||
        !line ||
        !row ||
        !avatar ||
        !container
      ) {
        requestAnimationFrame(sample);
        return;
      }
      if (currentText !== text) {
        text = currentText;
        frames.length = 0;
        startedAt = performance.now();
        const words = Array.from(
          row.querySelectorAll('[data-slot="chat-tagline-word"]'),
        );
        // Read the resolved animation once, at the start. The sentence itself
        // is complete in every frame, so this is the evidence that the
        // entrance is attached at all, and that each word waits longer than
        // the word before it.
        animationNames = words.map((word) => {
          return getComputedStyle(word).animationName;
        });
        delays = words.map((word) => {
          return Number.parseFloat(getComputedStyle(word).animationDelay) || 0;
        });
      }
      // The greeting row carries no animation of its own, so its box is the
      // layout answer to "did anything move?", unaffected by a word that is
      // still travelling inside it.
      const rowRect = row.getBoundingClientRect();
      const avatarRect = avatar.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      // Count lines from the per-word wrapper spans, not from a range over
      // the animated boxes inside them. A wrapper is laid out but never
      // transformed, while a rect taken over the boxes would carry each
      // word's own unfinished 14px rise and report a travelling word as an
      // extra line.
      const wordLines = Array.from(line.children)
        .flatMap((word) => {
          return Array.from(word.getClientRects());
        })
        .filter((rect) => rect.width > 0 && rect.height > 0);
      frames.push({
        text: line.textContent ?? "",
        rowLeft: rowRect.left,
        rowRight: rowRect.right,
        avatarWidth: avatarRect.width,
        avatarHeight: avatarRect.height,
        containerLeft: containerRect.left,
        containerRight: containerRect.right,
        lineCount: new Set(wordLines.map((rect) => Math.round(rect.top))).size,
      });
      // The last word starts at wordCount * 70ms and runs for 720ms; sample
      // past the end of it rather than waiting on a text change that no
      // longer happens.
      if (performance.now() - startedAt > 1800) {
        if (!window.recordChatGreeting) {
          throw new Error("The browser greeting recorder is not installed");
        }
        void window.recordChatGreeting({
          text,
          frames,
          animationNames,
          delays,
        });
        return;
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });

  await page.goto(appUrl);
  await expect.poll(() => observed.capture, { timeout: 30_000 }).toBeDefined();
  const capture = observed.capture;
  const first = capture?.frames[0];
  const last = capture?.frames.at(-1);
  if (!capture || !first || !last) {
    throw new Error("Expected the complete greeting animation");
  }
  await expect(page.locator('[data-slot="chat-tagline-text"]')).toBeVisible();
  await expect(page.getByTestId("chat-tagline")).toHaveAccessibleName(
    capture.text,
  );

  // The entrance really ran, one word box at a time, each later than the last.
  const words = capture.text.split(" ");
  expect(capture.delays.length).toBe(words.length);
  expect(new Set(capture.animationNames)).toEqual(
    new Set(["chat-greeting-token"]),
  );
  for (let index = 1; index < capture.delays.length; index++) {
    expect(capture.delays[index]).toBeGreaterThan(capture.delays[index - 1]);
  }

  // What the animation must never do: change the sentence, reflow it, or move
  // the row it sits in. The avatar snapping sideways while the line grew is
  // the defect this greeting was rebuilt to remove.
  expect(last.lineCount).toBeGreaterThan(1);
  for (const [index, frame] of capture.frames.entries()) {
    const label = `Greeting frame ${String(index)} of ${String(capture.frames.length)}`;
    expect(frame.text, label).toBe(capture.text);
    expect(frame.rowLeft, label).toBeCloseTo(first.rowLeft, 0);
    expect(frame.rowRight, label).toBeCloseTo(first.rowRight, 0);
    expect(frame.avatarWidth, label).toBeCloseTo(first.avatarWidth, 1);
    expect(frame.avatarHeight, label).toBeCloseTo(first.avatarHeight, 1);
    expect(frame.lineCount, label).toBe(last.lineCount);
    // The greeting stays inside the scrollport it is centered in. Measured on
    // the row rather than on glyph rects: a wrapper span's box includes the
    // trailing space it owns, which can hang past a wrapped line's edge.
    expect(frame.rowLeft, label).toBeGreaterThanOrEqual(
      frame.containerLeft - 1,
    );
    expect(frame.rowRight, label).toBeLessThanOrEqual(frame.containerRight + 1);
  }
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
