import { resolveApiBackendUrl } from "../api-backend-url";
import { expect, test } from "../fixtures";
import { signInWithClerkEmailCode } from "../lib/auth";
import {
  createOrganization,
  createUser,
  deleteClerkTestOwnerResources,
  generateTestEmail,
} from "../lib/clerk-api";
import {
  startVideoOnboardingCheckout,
  waitForPaidOnboardingCompletion,
} from "../lib/onboarding";
import { fillStripeCheckout } from "../lib/stripe-checkout";
import { deriveAppUrl } from "../playwright.config";

test("paid onboarding completes through the video template deep link", async ({
  page,
}) => {
  test.setTimeout(240_000);

  const apiUrl = resolveApiBackendUrl();
  const appUrl = deriveAppUrl(apiUrl);
  const email = generateTestEmail("paid-onboarding");
  let organizationId: string | undefined;

  try {
    const userId = await createUser(email);
    organizationId = await createOrganization(
      "E2E Paid Onboarding Org",
      userId,
      "paid-onboarding",
    );

    await signInWithClerkEmailCode(page, email, appUrl, {
      activeOrganizationId: organizationId,
    });

    await startVideoOnboardingCheckout(page, { appUrl, apiUrl });
    await fillStripeCheckout(page);
    const completionUrl = await waitForPaidOnboardingCompletion(page, {
      appUrl,
    });

    expect(completionUrl.pathname).toMatch(
      /^\/(?:prompt|agents\/[^/]+\/chat|chats\/[^/]+)$/,
    );
  } finally {
    await deleteClerkTestOwnerResources(email, organizationId);
  }
});
