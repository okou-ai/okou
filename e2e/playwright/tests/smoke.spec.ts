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

test("receive a reply and compose with an IME", async ({ page }) => {
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
  await completePromptOnboarding(page, {
    appUrl,
    prompt: "What is 1 + 2? Reply with only the number.",
  });

  await expect(
    page.locator('[data-role="assistant"] [data-chat-selection-source]').last(),
  ).toHaveText(/^\s*3\s*$/, { timeout: 90_000 });

  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.click();
  const cdp = await page.context().newCDPSession(page);
  try {
    // Use Chromium's native composition range: synthetic composition events
    // cannot detect an editor update that cancels an in-progress IME session.
    for (const text of ["s", "sh", "sha", "shai", "sha", "sh"]) {
      await cdp.send("Input.imeSetComposition", {
        text,
        selectionStart: text.length,
        selectionEnd: text.length,
      });
      // Let the editor's DOM observer and rendering settle between IME edits.
      await page.evaluate(() => {
        return new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              resolve();
            });
          });
        });
      });
      await expect(composer).toHaveText(text);
      if (text === "shai") {
        await page.keyboard.press("Backspace");
        await expect(composer).toHaveText("sha");
      }
    }
    await cdp.send("Input.insertText", { text: "啥" });
    await expect(composer).toHaveText("啥");
    await expect(composer).toBeFocused();
    await page.keyboard.press("Backspace");
    await expect(composer).toHaveText("");
  } finally {
    await cdp.detach();
  }
});
