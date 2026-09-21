import type { Page } from "@playwright/test";

import { resolveApiBackendUrl } from "../api-backend-url";
import { expect, test } from "../fixtures";
import {
  refreshClerkSessionToken,
  signInWithClerkEmailCode,
} from "../lib/auth";
import {
  createOrganization,
  createUser,
  generateTestEmail,
} from "../lib/clerk-api";
import {
  authHeadersForToken,
  completeExploreOnboarding,
} from "../lib/onboarding";
import { deriveAppUrl } from "../playwright.config";

// Theme preferences must not race the shared feature-test account.
test.use({
  storageState: { cookies: [], origins: [] },
  viewport: { width: 1440, height: 900 },
});

async function throttleChatWorker(page: Page, orgId: string) {
  const browser = page.context().browser();
  if (!browser) throw new Error("Canvas verification requires Chromium");
  const session = await browser.newBrowserCDPSession();
  const { targetInfos } = await session.send("Target.getTargets");
  const worker = targetInfos.find((target) => {
    return (
      target.type === "shared_worker" &&
      new URL(target.url).searchParams.get("orgId") === orgId
    );
  });
  if (!worker) {
    await session.detach();
    throw new Error("Expected the account's chat database SharedWorker");
  }
  const { sessionId } = await session.send("Target.attachToTarget", {
    targetId: worker.targetId,
    flatten: false,
  });
  // Page routes do not intercept SharedWorker requests. Apply Chromium network
  // latency while loading; assertions still wait for visible states, not a timer.
  let commandId = 0;
  async function send(method: string, params: Record<string, unknown> = {}) {
    const id = ++commandId;
    const result = new Promise<void>((resolve, reject) => {
      const listener = (event: { sessionId: string; message: string }) => {
        if (event.sessionId !== sessionId) return;
        const data: unknown = JSON.parse(event.message);
        if (
          typeof data !== "object" ||
          data === null ||
          !("id" in data) ||
          data.id !== id
        )
          return;
        session.off("Target.receivedMessageFromTarget", listener);
        if ("error" in data) reject(new Error(`SharedWorker ${method} failed`));
        else resolve();
      };
      session.on("Target.receivedMessageFromTarget", listener);
    });
    await session.send("Target.sendMessageToTarget", {
      sessionId,
      message: JSON.stringify({ id, method, params }),
    });
    await result;
  }
  async function throttle(latency: number) {
    await send("Network.emulateNetworkConditions", {
      offline: false,
      latency,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
  }
  try {
    await send("Network.enable");
    await throttle(8000);
  } catch (error) {
    await session.detach();
    throw error;
  }
  return {
    release: () => throttle(0),
    close: async () => {
      try {
        await throttle(0);
      } finally {
        await session.detach();
      }
    },
  };
}

async function selectAppearance(page: Page, theme: string, palette: string) {
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: theme, exact: true }).click();
  const color = settings.getByRole("button", { name: palette, exact: true });
  if ((await color.getAttribute("aria-pressed")) !== "true") {
    const saved = page.waitForResponse((response) => {
      return (
        new URL(response.url()).pathname === "/api/user-preferences" &&
        response.request().method() === "POST"
      );
    });
    await color.click();
    expect((await saved).ok()).toBe(true);
  }
  await expect(color).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
}

test("the workspace canvas stays continuous while chat history loads", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const apiUrl = resolveApiBackendUrl();
  const appUrl = deriveAppUrl(apiUrl);
  const email = generateTestEmail("playwright");
  const userId = await createUser(email);
  const orgId = await createOrganization(
    "Chat canvas review",
    userId,
    "playwright",
  );
  await signInWithClerkEmailCode(page, email, appUrl, {
    activeOrganizationId: orgId,
  });
  await completeExploreOnboarding(page, { appUrl });
  const agentId = new URL(page.url()).pathname.match(
    /^\/agents\/([^/]+)\/chat$/,
  )?.[1];
  if (!agentId)
    throw new Error("Expected the new organization's default agent chat");

  await page.goto(`${appUrl}/_/lab`);
  const gradients = page.getByRole("switch", { name: /gradientColorThemes/ });
  if (!(await gradients.isChecked())) await gradients.click();
  await expect(gradients).toBeChecked();
  await expect(gradients).toBeEnabled();

  for (const palette of ["Default", "Blue horizon"]) {
    for (const theme of ["Light", "Dark"]) {
      const token = await refreshClerkSessionToken(page, {
        activeOrganizationId: orgId,
      });
      // Seed an unopened empty thread through the public API. No agent run or
      // cached transcript can bypass this first history request.
      const created = await page.request.post(
        new URL("/api/chat-threads", apiUrl).href,
        {
          headers: authHeadersForToken(token),
          data: {
            agentId,
            model: "gpt-5.6-luna",
            title: `${palette} ${theme} canvas`,
          },
        },
      );
      expect(created.status(), await created.text()).toBe(201);
      const body: unknown = await created.json();
      if (
        typeof body !== "object" ||
        body === null ||
        !("id" in body) ||
        typeof body.id !== "string"
      ) {
        throw new Error("Expected the created chat thread id");
      }
      const threadId = body.id;
      await page.goto(`${appUrl}/agents?settings=preference`);
      await selectAppearance(page, theme, palette);
      await expect(page.locator("html")).toHaveAttribute(
        "data-theme",
        theme.toLowerCase(),
      );
      if (palette === "Blue horizon") {
        await expect(page.locator("html")).toHaveAttribute(
          "data-gradient-color-themes",
          "",
        );
      }

      const network = await throttleChatWorker(page, orgId);
      try {
        await page.locator(`a[href="/chats/${threadId}"]`).click();
        const loading = page.locator("[data-chat-skeleton]");
        await expect(loading).toBeVisible();
        await expect(page.locator("[data-message-container]")).toBeHidden();
        const viewport = page.locator("[data-scroll-container]");
        const bounds = await viewport.boundingBox();
        if (!bounds) throw new Error("Expected the transcript viewport");
        // Sample actual painted pixels in empty gutters at both gradient
        // corners. An unchanged ::before style alone misses an opaque cover.
        const clips = [
          { x: bounds.x + 4, y: bounds.y + 4, width: 8, height: 8 },
          {
            x: bounds.x + bounds.width - 24,
            y: bounds.y + bounds.height - 12,
            width: 8,
            height: 8,
          },
        ];
        const pending = [];
        for (const clip of clips) pending.push(await page.screenshot({ clip }));
        await testInfo.attach(`${palette}-${theme}-loading`, {
          body: await page.screenshot(),
          contentType: "image/png",
        });
        await network.release();
        await expect(
          page.getByText("Send a message to start the conversation", {
            exact: true,
          }),
        ).toBeVisible();
        await expect(loading).toHaveCount(0);
        for (const [index, clip] of clips.entries()) {
          const ready = await page.screenshot({ clip });
          expect(
            ready.equals(pending[index]!),
            `${palette} ${theme} canvas corner ${index}`,
          ).toBe(true);
        }
      } finally {
        await network.close();
      }
    }
  }
});
