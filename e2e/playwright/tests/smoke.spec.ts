import { resolveApiBackendUrl } from "../api-backend-url";
import { expect, test } from "../fixtures";
import { signInWithClerkEmailCode } from "../lib/auth";
import {
  createOrganization,
  createUser,
  generateTestEmail,
} from "../lib/clerk-api";
import { completeExploreOnboarding } from "../lib/onboarding";
import { deriveAppUrl } from "../playwright.config";

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

  await completeExploreOnboarding(page, {
    appUrl,
  });

  await page.waitForURL("**/agents/*/chat", {
    timeout: 120_000,
    waitUntil: "domcontentloaded",
  });

  const marker = `PRODUCT_CHAT_E2E_${Date.now()}`;
  const composer = page.locator('[data-slot="chat-composer-card"]');
  await composer
    .getByRole("textbox", { name: "Message" })
    .fill(`printf '%s' '${marker}'`);
  await composer.getByRole("button", { name: "Send" }).click();

  await expect(
    page.locator('[data-role="assistant"]').filter({ hasText: marker }).first(),
  ).toContainText(marker, { timeout: 90_000 });
});
