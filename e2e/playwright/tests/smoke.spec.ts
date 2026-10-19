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
  await completePromptOnboarding(page, {
    appUrl,
    prompt: "What is 1 + 2? Reply with only the number.",
  });

  await expect(
    page.locator('[data-role="assistant"] [data-chat-selection-source]').last(),
  ).toHaveText(/^\s*3\s*$/, { timeout: 90_000 });
});
