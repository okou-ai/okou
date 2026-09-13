import assert from "node:assert/strict";
import { test } from "node:test";

import { chromium, expect } from "@playwright/test";

import { expectClerkTestInstance, signInWithClerkEmailCode } from "./auth";

// Exercise the fixture guard in a browser without connecting test credentials
// to a live Clerk instance. Only the external SDK runtime is supplied here.
test("auth fixtures require a loaded Clerk test instance", async (context) => {
  const browser = await chromium.launch();
  try {
    await context.test(
      "accepts a test instance after script cleanup",
      async () => {
        const page = await browser.newPage();
        try {
          await page.setContent(`
          <script data-clerk-publishable-key="pk_test_fixture">
            window.Clerk = { loaded: true, publishableKey: "pk_test_fixture" };
            document.currentScript.remove();
          </script>
        `);
          await expectClerkTestInstance(page);
        } finally {
          await page.close();
        }
      },
    );

    for (const scenario of [
      {
        name: "a production instance",
        runtime: { loaded: true, publishableKey: "pk_live_fixture" },
      },
      { name: "a missing instance", runtime: undefined },
      {
        name: "an unloaded test instance",
        runtime: { loaded: false, publishableKey: "pk_test_fixture" },
      },
      { name: "a missing key", runtime: { loaded: true } },
      {
        name: "an empty key",
        runtime: { loaded: true, publishableKey: "" },
      },
      {
        name: "an invalid key",
        runtime: { loaded: true, publishableKey: "invalid" },
      },
      {
        name: "a non-string key",
        runtime: { loaded: true, publishableKey: 42 },
      },
    ]) {
      await context.test(
        `rejects ${scenario.name} despite a test script`,
        async () => {
          const page = await browser.newPage();
          try {
            await page.setContent(`
            <script data-clerk-publishable-key="pk_test_fixture">
              window.Clerk = ${JSON.stringify(scenario.runtime)};
            </script>
          `);
            await assert.rejects(
              () => expectClerkTestInstance(page),
              /Auth fixtures require a loaded Clerk test instance/u,
            );
          } finally {
            await page.close();
          }
        },
      );
    }
  } finally {
    await browser.close();
  }
});

test("email-code sign-in waits for preparation before submitting a visible code", async (context) => {
  const browser = await chromium.launch();
  context.after(() => browser.close());
  const page = await browser.newPage();
  const appUrl = "https://clerk-auth-fixture.test";

  // Model the external Clerk UI: the OTP mounts before preparation completes,
  // and six digits immediately attempt verification. Reading the SDK resource
  // exposes a synchronization point so preparation needs no timer or sleep.
  await page.route(`${appUrl}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html>
        <label>Email address <input type="email"></label>
        <button onclick="showCode()">Continue</button>
        <script>
          let prepared = false;
          window.Clerk = {
            loaded: true,
            publishableKey: 'pk_test_fixture',
            organization: { id: 'org_fixture' },
            client: { signIn: {
              get firstFactorVerification() {
                document.querySelector('[role="status"]').textContent =
                  'Waiting for preparation';
                return prepared
                  ? { strategy: 'email_code', status: 'unverified' }
                  : null;
              },
            } },
          };
          window.addEventListener('clerk-prepared', () => {
            prepared = true;
          }, { once: true });
          function showCode() {
            document.body.innerHTML =
              '<p role="status">Code input mounted</p>' +
              '<input aria-label="Enter verification code" oninput="submitCode(this.value)">';
          }
          function submitCode(code) {
            if (code.length !== 6) return;
            if (!prepared) {
              document.querySelector('[role="status"]').textContent =
                'verification_not_sent';
              return;
            }
            if (code !== '424242') throw new Error('Unexpected test code');
            window.Clerk.session = { getToken: async () => 'fixture-token' };
            history.replaceState(null, '', '/onboarding');
            document.body.innerHTML = '<h1>Onboarding</h1>';
          }
        </script>`,
    }),
  );

  const [token] = await Promise.all([
    signInWithClerkEmailCode(page, "fixture+clerk_test@example.com", appUrl, {
      activeOrganizationId: "org_fixture",
    }),
    (async () => {
      const status = page.getByRole("status");
      await expect(status).toHaveText(
        /Waiting for preparation|verification_not_sent/,
      );
      await expect(status).toHaveText("Waiting for preparation");
      await expect(
        page.getByRole("textbox", { name: "Enter verification code" }),
      ).toHaveValue("");
      await page.evaluate(() => {
        window.dispatchEvent(new Event("clerk-prepared"));
      });
    })(),
  ]);

  assert.equal(token, "fixture-token");
  await expect(page).toHaveURL(`${appUrl}/onboarding`);
  await expect(page.getByRole("heading", { name: "Onboarding" })).toBeVisible();
});
