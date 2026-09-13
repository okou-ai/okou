import { expect, type Page } from "@playwright/test";

import { waitForClerkReadiness } from "./clerk-readiness";

const CLERK_TEST_EMAIL_CODE = "424242";

export async function expectClerkTestInstance(page: Page): Promise<void> {
  // Clerk can remove its loader script after successfully initializing.
  // Check the running instance before interacting with auth fixtures.
  const isTestInstance = await page.evaluate(() => {
    const clerk = window.Clerk;
    return (
      clerk?.loaded === true &&
      typeof clerk.publishableKey === "string" &&
      clerk.publishableKey.startsWith("pk_test_")
    );
  });
  expect(
    isTestInstance,
    "Auth fixtures require a loaded Clerk test instance",
  ).toBe(true);
}

export interface ClerkEmailCodeSignInOptions {
  readonly activeOrganizationId: string;
}

export async function signInWithClerkEmailCode(
  page: Page,
  email: string,
  appUrl: string,
  options: ClerkEmailCodeSignInOptions,
): Promise<string> {
  const signInUrl = new URL("/sign-in", appUrl);
  await page.goto(signInUrl.toString(), { waitUntil: "domcontentloaded" });
  const emailAddress = page.getByLabel("Email address", { exact: true });
  await expect(emailAddress).toBeVisible({ timeout: 30_000 });
  await emailAddress.fill(email);
  await page.getByRole("button", { exact: true, name: "Continue" }).click();
  await submitClerkEmailCode(page);
  await page.waitForURL(
    (url) =>
      url.origin === signInUrl.origin && !url.pathname.startsWith("/sign-in"),
    { timeout: 30_000, waitUntil: "domcontentloaded" },
  );
  await waitForClerkReadiness(
    page,
    "the Clerk client to load and expose a session on the page reached after email-code sign-in",
    () =>
      page.waitForFunction(
        () => Boolean(window.Clerk?.loaded && window.Clerk.session),
        undefined,
        { timeout: 30_000 },
      ),
  );
  await activateClerkOrganization(page, options.activeOrganizationId);
  await waitForClerkReadiness(
    page,
    `Clerk to activate organization ${options.activeOrganizationId}`,
    () =>
      page.waitForFunction(
        (organizationId) => {
          return Boolean(
            window.Clerk?.loaded &&
            window.Clerk.session &&
            window.Clerk.organization?.id === organizationId,
          );
        },
        options.activeOrganizationId,
        { timeout: 30_000 },
      ),
  );

  const token = await refreshClerkSessionToken(page, {
    activeOrganizationId: options.activeOrganizationId,
  });
  return token;
}

async function submitClerkEmailCode(page: Page): Promise<void> {
  const codeInput = page.getByRole("textbox", {
    name: "Enter verification code",
  });
  const emailCodeButton = page
    .getByRole("button", { name: /email code/i })
    .first();
  const useAnotherMethodLink = page.getByRole("link", {
    name: /use another method/i,
  });

  // Clerk keeps the alternate-method link visible beside the code input. Poll
  // each candidate independently so multiple valid states do not violate
  // Playwright's strict locator contract.
  await expect
    .poll(
      async () => {
        const [codeInputVisible, emailCodeButtonVisible, anotherMethodVisible] =
          await Promise.all([
            codeInput.isVisible(),
            emailCodeButton.isVisible(),
            useAnotherMethodLink.isVisible(),
          ]);
        return (
          codeInputVisible || emailCodeButtonVisible || anotherMethodVisible
        );
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  if (!(await codeInput.isVisible())) {
    if (await useAnotherMethodLink.isVisible()) {
      await useAnotherMethodLink.click();
    }
    await expect(emailCodeButton).toBeVisible({ timeout: 30_000 });
    await emailCodeButton.click();
  }

  await expect(codeInput).toBeVisible({ timeout: 30_000 });
  await codeInput.fill(CLERK_TEST_EMAIL_CODE);
}

async function activateClerkOrganization(
  page: Page,
  organizationId: string,
): Promise<void> {
  const activeOrganizationId = await page.evaluate(() => {
    return window.Clerk?.organization?.id ?? null;
  });
  if (activeOrganizationId === organizationId) {
    return;
  }

  await page.evaluate((targetOrganizationId) => {
    const clerk = window.Clerk;
    if (!clerk?.session) {
      throw new Error("Clerk session unavailable for organization activation");
    }
    void clerk.setActive({ organization: targetOrganizationId });
  }, organizationId);
}

export async function refreshClerkSessionToken(
  page: Page,
  options: { readonly activeOrganizationId?: string } = {},
): Promise<string> {
  await waitForClerkReadiness(
    page,
    "a Clerk session before refreshing its token",
    () =>
      page.waitForFunction(() => Boolean(window.Clerk?.session), undefined, {
        timeout: 30_000,
      }),
  );
  if (options.activeOrganizationId) {
    await waitForClerkReadiness(
      page,
      `Clerk to report organization ${options.activeOrganizationId} before refreshing its token`,
      () =>
        page.waitForFunction(
          (organizationId) => window.Clerk?.organization?.id === organizationId,
          options.activeOrganizationId,
          { timeout: 30_000 },
        ),
    );
  }
  const token = await page.evaluate(async () => {
    return (await window.Clerk?.session?.getToken({ skipCache: true })) ?? null;
  });
  if (!token) {
    throw new Error("Clerk session token unavailable after refresh");
  }
  return token;
}
