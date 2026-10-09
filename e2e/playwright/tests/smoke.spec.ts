import type { Locator } from "@playwright/test";

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
  completePromptOnboarding,
} from "../lib/onboarding";
import { deriveAppUrl } from "../playwright.config";

async function expectChatShellInPlace(workspace: Locator): Promise<void> {
  // Returning from Lab mounts the workspace before the chat finishes loading.
  // Wait for the visible layout before reading its geometry.
  await expect(
    workspace.locator("[data-chat-thread-container-id] > header"),
  ).toBeVisible();
  await expect(
    workspace.locator('[data-chat-composer] [data-slot="chat-composer-card"]'),
  ).toBeVisible();
  await expect
    .poll(() =>
      workspace.evaluate((pane) => {
        const header = pane.querySelector(
          "[data-chat-thread-container-id] > header",
        );
        const composer = pane.querySelector("[data-chat-composer]");
        const card = composer?.querySelector(
          '[data-slot="chat-composer-card"]',
        );
        if (!header || !composer || !card) {
          throw new Error("Expected the chat header and composer");
        }
        const top = pane.getBoundingClientRect().top + pane.clientTop;
        return {
          scrollTop: pane.scrollTop,
          overflow: pane.scrollHeight - pane.clientHeight,
          headerInset: Math.round(header.getBoundingClientRect().top - top),
          composerInset: Math.round(
            top + pane.clientHeight - composer.getBoundingClientRect().bottom,
          ),
          bottomGap: Math.round(
            composer.getBoundingClientRect().bottom -
              card.getBoundingClientRect().bottom,
          ),
        };
      }),
    )
    .toEqual({
      scrollTop: 0,
      overflow: 0,
      headerInset: 0,
      composerInset: 0,
      bottomGap: 16,
    });
}

test("send a message and receive the assistant reply", async ({ page }) => {
  test.setTimeout(240_000);

  const email = generateTestEmail("playwright");
  const userId = await createUser(email, undefined, {
    firstName: "Christopher",
  });
  const orgId = await createOrganization("E2E Test Org", userId, "playwright");
  const apiUrl = resolveApiBackendUrl();
  const appUrl = deriveAppUrl(apiUrl);

  await signInWithClerkEmailCode(page, email, appUrl, {
    activeOrganizationId: orgId,
  });

  // The onboarding prompt handoff sends the message as the first chat.
  const expectedAnswer = "RESULT=3";
  await completePromptOnboarding(page, {
    appUrl,
    prompt: "1 + 2. Reply only RESULT=<answer>.",
  });

  await expect(
    page
      .locator('[data-role="assistant"]')
      .filter({ hasText: expectedAnswer })
      .first(),
  ).toContainText(expectedAnswer, { timeout: 90_000 });

  const chatUrl = page.url();
  await test.step("opt into the composer layout from Lab", async () => {
    const token = await refreshClerkSessionToken(page);
    const response = await page.request.post(
      new URL("/api/feature-switches", apiUrl).toString(),
      {
        headers: authHeadersForToken(token),
        data: { switches: { _lab: true } },
      },
    );
    expect(response.status()).toBe(200);
    await page.goto(new URL("/_/lab", appUrl).toString());
    const control = page.getByRole("switch", { name: /^chatComposerLayout\b/ });
    await expect(control).not.toBeChecked();
    await control.click();
    await expect(control).toBeChecked();
    await expect(control).toBeEnabled();
    await page.goto(chatUrl);
  });

  await test.step("keep the chat shell fixed while editing and resizing", async () => {
    const workspace = page.getByTestId("workspace-inset");
    const editor = workspace.locator(
      '[data-chat-composer] [contenteditable="true"]',
    );
    await expectChatShellInPlace(workspace);

    const draft = Array.from(
      { length: 40 },
      (_, index) => `Draft line ${index + 1}`,
    ).join("\n");
    for (const height of [800, 600]) {
      await page.setViewportSize({ width: 1280, height });
      await editor.fill(draft);
      await expect(editor).toBeFocused();
      await expect
        .poll(() =>
          editor.evaluate(
            (element) => element.scrollHeight - element.clientHeight,
          ),
        )
        .toBeGreaterThan(0);
      await editor.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect
        .poll(() => editor.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(0);
      await expectChatShellInPlace(workspace);

      // A focus-reveal path must not be able to scroll the workspace shell.
      await workspace.evaluate((pane) => {
        pane.scrollTop = pane.scrollHeight;
      });
      await expectChatShellInPlace(workspace);
      await editor.fill("");
      await expectChatShellInPlace(workspace);
    }
  });

  await test.step("share the composer gutter with the mobile safe area", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    const workspace = page.getByTestId("workspace-inset");
    const composer = workspace.locator("[data-chat-composer]");
    const card = composer.locator('[data-slot="chat-composer-card"]');

    // Desktop CI has no home indicator. Supply its environment inset and
    // exercise both directions of the keyboard's safe-area transition.
    for (const inset of [0, 24, 0, 34, 0]) {
      await page.evaluate((value) => {
        document.documentElement.style.setProperty("--sab", `${value}px`);
      }, inset);
      await expect
        .poll(async () => {
          const footerBounds = await composer.boundingBox();
          const cardBounds = await card.boundingBox();
          if (!footerBounds || !cardBounds) {
            throw new Error("Expected the chat composer to be rendered");
          }
          return Math.round(
            footerBounds.y +
              footerBounds.height -
              cardBounds.y -
              cardBounds.height,
          );
        })
        .toBe(Math.max(16, inset));
    }
    await page.evaluate(() => {
      document.documentElement.style.removeProperty("--sab");
    });
  });

  await test.step("restore the original layout when opted out", async () => {
    await page.goto(new URL("/_/lab", appUrl).toString());
    const control = page.getByRole("switch", { name: /^chatComposerLayout\b/ });
    await expect(control).toBeChecked();
    await control.click();
    await expect(control).not.toBeChecked();
    await expect(control).toBeEnabled();
    await page.goto(chatUrl);
    const workspace = page.getByTestId("workspace-inset");
    await expect(
      workspace.locator('[data-slot="chat-composer-card"]'),
    ).toBeVisible();
    await page.evaluate(() => {
      document.documentElement.style.setProperty("--sab", "24px");
    });
    await expect
      .poll(() =>
        workspace.evaluate((pane) => {
          const footer = pane.querySelector("[data-chat-composer]");
          const card = footer?.querySelector(
            '[data-slot="chat-composer-card"]',
          );
          if (!footer || !card) throw new Error("Expected the chat composer");
          return Math.round(
            footer.getBoundingClientRect().bottom -
              card.getBoundingClientRect().bottom,
          );
        }),
      )
      .toBe(32);
    await page.evaluate(() => {
      document.documentElement.style.removeProperty("--sab");
    });
  });
});
