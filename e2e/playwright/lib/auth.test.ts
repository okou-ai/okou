import assert from "node:assert/strict";
import { test } from "node:test";

import { chromium, expect } from "@playwright/test";

import { expectClerkTestInstance, signInWithClerkEmailCode } from "./auth";

// Exercise the fixture guard in a browser without connecting test credentials
// to a live Clerk instance. Only the external SDK runtime is supplied here.
test("auth fixtures require a loaded Clerk test instance", async (context) => {
  const browser = await chromium.launch({
    executablePath: process.env.E2E_CHROMIUM_EXECUTABLE_PATH,
  });
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

test(
  "email-code sign-in fails promptly when the app bootstrap is unavailable",
  { timeout: 15_000 },
  async (context) => {
    const browser = await chromium.launch({
      executablePath: process.env.E2E_CHROMIUM_EXECUTABLE_PATH,
    });
    context.after(() => browser.close());
    const page = await browser.newPage();
    const appUrl = "https://clerk-auth-fixture.test";
    await page.route(`${appUrl}/**`, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><p>Application bootstrap did not load</p>",
      }),
    );

    await assert.rejects(
      () =>
        signInWithClerkEmailCode(page, "fixture@example.com", appUrl, {
          activeOrganizationId: "org_fixture",
        }),
      /Clerk core bootstrap is unavailable before email-code sign-in/u,
    );
  },
);

test("email-code sign-in enters the intended email after an inert startup", async (context) => {
  const browser = await chromium.launch({
    executablePath: process.env.E2E_CHROMIUM_EXECUTABLE_PATH,
  });
  context.after(() => browser.close());
  const page = await browser.newPage();
  const appUrl = "https://clerk-auth-fixture.test";
  const email = "fixture+clerk_test@example.com";

  await page.route(`${appUrl}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html>
        <p role="alert" hidden>Email is required</p>
        <main inert>
          <form>
            <label>Email address <input name="email" type="email" required></label>
            <button>Continue</button>
          </form>
        </main>
        <script>
          window.__okouClerkBootstrap = { runtime: Promise.resolve() };
          window.Clerk = {
            loaded: true,
            organization: { id: 'org_fixture' },
            client: { signIn: { firstFactorVerification: {
              strategy: 'email_code', status: 'unverified'
            } } },
          };
          document.addEventListener('invalid', () => {
            document.querySelector('[role="alert"]').hidden = false;
          }, true);
          document.querySelector('form').onsubmit = event => {
            event.preventDefault();
            const submittedEmail = new FormData(event.target).get('email');
            event.target.innerHTML = '<input aria-label="Enter verification code">';
            event.target.querySelector('input').oninput = event => {
              if (event.target.value !== '424242') return;
              window.Clerk.session = { getToken: async () => 'fixture-token' };
              history.replaceState(null, '', '/completed');
              document.body.innerHTML = '<h1>Signed in</h1><p></p>';
              document.querySelector('p').textContent = submittedEmail;
            };
          };
        </script>`,
    }),
  );

  // Keep the real browser actions. Release startup after the first input
  // action: a click can still be waiting, whereas an inert fill has returned
  // without entering anything. This reproduces the race without a sleep.
  const getByLabel = page.getByLabel.bind(page);
  const interactionStarted = new Promise<void>((resolve) => {
    page.getByLabel = (...args) => {
      const field = getByLabel(...args);
      const click = field.click.bind(field);
      field.click = (...options) => {
        const action = click(...options);
        resolve();
        return action;
      };
      const fill = field.fill.bind(field);
      field.fill = async (...options) => {
        await fill(...options);
        resolve();
      };
      return field;
    };
  });

  const [token] = await Promise.all([
    signInWithClerkEmailCode(page, email, appUrl, {
      activeOrganizationId: "org_fixture",
    }),
    (async () => {
      await interactionStarted;
      const field = getByLabel("Email address", { exact: true });
      await expect(field).toBeVisible();
      await expect(field).toHaveValue("");
      const invalidSubmission = page
        .getByRole("alert")
        .waitFor()
        .then(() => {
          throw new Error("Email was not entered before Continue");
        });
      await page.locator("main").evaluate((element) => {
        element.removeAttribute("inert");
      });
      await Promise.race([
        page.getByRole("heading", { name: "Signed in" }).waitFor(),
        invalidSubmission,
      ]);
    })(),
  ]);

  assert.equal(token, "fixture-token");
  await expect(page).toHaveURL(`${appUrl}/completed`);
  await expect(page.getByText(email, { exact: true })).toBeVisible();
});

test("email-code sign-in waits for preparation before submitting a visible code", async (context) => {
  const browser = await chromium.launch({
    executablePath: process.env.E2E_CHROMIUM_EXECUTABLE_PATH,
  });
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
          window.__okouClerkBootstrap = { runtime: Promise.resolve() };
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
