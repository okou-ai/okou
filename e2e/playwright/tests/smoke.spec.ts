import { resolveApiBackendUrl } from "../api-backend-url";
import { expect, test } from "../fixtures";
import { signInWithClerkEmailCode } from "../lib/auth";
import {
  createOrganization,
  createUser,
  generateTestEmail,
} from "../lib/clerk-api";
import { completeExploreOnboarding } from "../lib/onboarding";
import { deriveAppUrl, STORAGE_STATE } from "../playwright.config";

test("complete app onboarding to chat page", async ({ browser, page }) => {
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

  // Verify: landed on chat page
  await page.waitForURL("**/agents/*/chat", {
    timeout: 120_000,
    waitUntil: "domcontentloaded",
  });
  expect(page.url()).toMatch(/\/agents\/.*\/chat/);

  // Save storageState for feature tests (use absolute path to match playwright.config.ts)
  await page.context().storageState({ path: STORAGE_STATE });

  const verificationContext = await browser.newContext({
    storageState: STORAGE_STATE,
    ignoreHTTPSErrors: true,
  });
  try {
    const verificationPage = await verificationContext.newPage();
    await verificationPage.goto(`${appUrl}/agents`, {
      waitUntil: "domcontentloaded",
    });
    await expect(
      verificationPage.getByRole("heading", { name: "Agents" }),
    ).toBeVisible({ timeout: 20_000 });
    await verificationPage.waitForFunction(
      (organizationId) => window.Clerk?.organization?.id === organizationId,
      orgId,
      { timeout: 30_000 },
    );
  } finally {
    await verificationContext.close();
  }
});
