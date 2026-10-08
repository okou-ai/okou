import type { Locator } from "@playwright/test";

import { resolveApiBackendUrl } from "../api-backend-url";
import { expect, test } from "../fixtures";
import { signInWithClerkEmailCode } from "../lib/auth";
import {
  createOrganization,
  createUser,
  generateTestEmail,
} from "../lib/clerk-api";
import { completePromptOnboarding } from "../lib/onboarding";
import { deriveAppUrl } from "../playwright.config";

async function expectChatShellInPlace(workspace: Locator): Promise<void> {
  await expect
    .poll(() =>
      workspace.evaluate((pane) => {
        const header = pane.querySelector(
          "[data-chat-thread-container-id] > header",
        );
        const composer = pane.querySelector("[data-chat-composer]");
        if (!header || !composer) {
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
        };
      }),
    )
    .toEqual({ scrollTop: 0, overflow: 0, headerInset: 0, composerInset: 0 });
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
});
