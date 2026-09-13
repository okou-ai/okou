import { randomUUID } from "node:crypto";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures";
import { expectClerkTestInstance } from "../lib/auth";
import {
  createUser,
  deleteUserByEmail,
  generateTestEmail,
} from "../lib/clerk-api";

async function openAuth(
  page: Page,
  path: "/sign-in" | "/sign-up",
  theme: "light" | "dark",
): Promise<void> {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("Email address", { exact: true })).toBeVisible();
  await expectClerkTestInstance(page);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  const toggle = page.getByRole("button", { name: "Toggle theme" });
  if (
    (await toggle.getAttribute("aria-pressed")) !== String(theme === "dark")
  ) {
    await toggle.click();
  }
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await expectLogo(page);
}

async function expectLogo(page: Page): Promise<void> {
  const logo = page.locator(".cl-logoImage");
  await expect(logo).toBeVisible();
  await expect(logo).toHaveJSProperty("complete", true);
  await expect
    .poll(async () => {
      return logo.evaluate((element: HTMLImageElement) => element.naturalWidth);
    })
    .toBeGreaterThan(0);
}

async function expectPrimary(page: Page, button: Locator): Promise<void> {
  await page.mouse.move(0, 0);
  await expect(button).toHaveCSS("background-color", "rgb(255, 165, 0)");
  await expect(button).toHaveCSS("color", "rgb(36, 35, 33)");
  await expect(button).toHaveCSS("height", "36px");
  await expect(button).toHaveCSS("text-decoration-line", "none");
}

async function expectInputBoundary(
  input: Locator,
  theme: "light" | "dark",
): Promise<void> {
  const expectedBorderColor =
    theme === "light" ? "rgb(207, 204, 203)" : "rgb(86, 84, 84)";
  await expect(input).toHaveCSS("border-color", expectedBorderColor);
}

async function expectSeparated(above: Locator, below: Locator): Promise<void> {
  await expect(above).toBeVisible();
  await expect(below).toBeVisible();
  await expect
    .poll(async () => {
      const upper = await above.boundingBox();
      const lower = await below.boundingBox();
      if (!upper || !lower) {
        throw new Error("Expected both adjacent controls to be rendered");
      }
      return lower.y - (upper.y + upper.height);
    })
    .toBeGreaterThanOrEqual(4);
}

async function expectPasswordControlFits(
  input: Locator,
  toggle: Locator,
): Promise<void> {
  await expect
    .poll(async () => {
      const field = await input.boundingBox();
      const button = await toggle.boundingBox();
      if (!field || !button) {
        throw new Error("Expected the password field and reveal control");
      }
      const trailingSpace = await input.evaluate((element) => {
        return parseFloat(getComputedStyle(element).paddingInlineEnd);
      });
      // Clerk owns the native inset. Keep the reveal button inside the field
      // and outside the space available to password text.
      return Math.min(
        button.x - field.x,
        button.y - field.y,
        field.y + field.height - button.y - button.height,
        field.x + field.width - button.x - button.width,
        button.x - (field.x + field.width - trailingSpace),
      );
    })
    .toBeGreaterThanOrEqual(0);
}

async function expectAuthBackgroundCoversViewport(page: Page): Promise<void> {
  const background = page.getByTestId("app-auth-background");
  await expect(background).toBeVisible();
  await expect
    .poll(async () => {
      return background.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return (
          box.top <= 0 &&
          box.right >= window.innerWidth &&
          box.bottom >= window.innerHeight &&
          box.left <= 0
        );
      });
    })
    .toBe(true);
}

/**
 * Clerk prepares the verification after the code card mounts. A code entered
 * before that response lands is rejected with a card-level error instead of
 * the field feedback under the inputs, so wait for the prepared factor.
 */
async function clickAndAwaitPreparedFactor(action: Locator): Promise<void> {
  const prepared = action.page().waitForResponse((response) => {
    return response.url().includes("/prepare_first_factor") && response.ok();
  });
  await action.click();
  await prepared;
}

async function enterInvalidCode(page: Page, code: string): Promise<void> {
  // Clerk's six visible slots are not inputs. The accessible textbox owns
  // typing/paste and resets after a rejected attempt. Wait for that visible
  // reset so retries cannot pass by observing the previous error.
  const input = page.getByRole("textbox", { name: "Enter verification code" });
  await expect(input).toHaveValue("");
  await input.fill(code);
  await expect(input).toHaveValue(code);
  await expect(input).toHaveValue("");
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`narrow footer ${theme}`, () => {
    test.use({
      colorScheme: theme,
      isMobile: true,
      hasTouch: true,
      viewport: { width: 320, height: 568 },
    });

    for (const route of [
      { path: "/sign-up", action: "Sign in", target: "/sign-in" },
      { path: "/sign-in", action: "Sign up", target: "/sign-up" },
    ] as const) {
      test(`${route.path} keeps its native footer action in the viewport and keyboard reachable`, async ({
        page,
      }) => {
        await openAuth(page, route.path, theme);
        const action = page.getByRole("link", {
          exact: true,
          name: route.action,
        });

        for (const width of [320, 390]) {
          await page.setViewportSize({ width, height: 568 });
          await action.scrollIntoViewIfNeeded();
          const fits = await action.evaluate((element) => {
            const box = element.getBoundingClientRect();
            return (
              box.left >= 0 &&
              box.right <= document.documentElement.clientWidth &&
              document.documentElement.scrollWidth <=
                document.documentElement.clientWidth
            );
          });
          expect(fits).toBe(true);
        }

        await action.focus();
        await page.keyboard.press("Shift+Tab");
        await expect(action).not.toBeFocused();
        await page.keyboard.press("Tab");
        await expect(action).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(new RegExp(`${route.target}(?:\\?.*)?$`));
        await expect(
          page.getByLabel("Email address", { exact: true }),
        ).toBeVisible();
      });
    }
  });
}

for (const device of [
  { name: "desktop light", theme: "light", width: 1440, height: 900 },
  { name: "mobile dark", theme: "dark", width: 390, height: 844 },
] as const) {
  test.describe(device.name, () => {
    test.use({
      colorScheme: device.theme,
      isMobile: device.name === "mobile dark",
      hasTouch: device.name === "mobile dark",
      viewport: { width: device.width, height: device.height },
    });

    test("hosted auth recovers from a UI resource failure", async ({
      page,
    }) => {
      const uiRequests: string[] = [];
      page.on("request", (request) => {
        if (/\/assets\/clerk-ui-[^/]+\.js$/u.test(request.url())) {
          uiRequests.push(request.url());
        }
      });
      const uiAsset = "**/assets/clerk-ui-*.js";
      await page.route(uiAsset, (route) => route.abort());
      await page.goto("/sign-in", { waitUntil: "domcontentloaded" });
      const failure = page.getByRole("alert");
      await expect(failure).toContainText("Oops! Something went sideways");
      await expect(page.locator(".cl-signIn-root")).toHaveCount(0);
      await expect(page.locator("#app-bootstrap-skeleton")).toHaveAttribute(
        "aria-hidden",
        "true",
      );
      await expectPrimary(
        page,
        failure.getByRole("button", { exact: true, name: "Refresh" }),
      );
      expect(uiRequests.length).toBeGreaterThan(0);

      await page.unroute(uiAsset);
      await failure
        .getByRole("button", { exact: true, name: "Refresh" })
        .click();
      await expect(
        page.getByLabel("Email address", { exact: true }),
      ).toBeVisible();
      await expectLogo(page);
      await expect(failure).toHaveCount(0);
    });

    test("hosted entry logos follow theme changes without resetting the form", async ({
      page,
    }) => {
      for (const path of ["/sign-in", "/sign-up"] as const) {
        await openAuth(page, path, "light");
        const logo = page.locator(".cl-logoImage");
        const lightLogoSrc = await logo.getAttribute("src");
        if (!lightLogoSrc) throw new Error("Expected the dashboard logo URL");

        const email = page.getByLabel("Email address", { exact: true });
        await email.fill("theme-preview@example.com");
        const toggle = page.getByRole("button", { name: "Toggle theme" });
        await toggle.click();
        await expect(page.locator("html")).toHaveAttribute(
          "data-theme",
          "dark",
        );
        await expect(logo).toHaveAttribute(
          "src",
          "https://static.okou.io/public/okou-logo-wordmark-light-1ebf9d0e7a50.svg",
        );
        await expectLogo(page);
        await expect(email).toHaveValue("theme-preview@example.com");
        await expectInputBoundary(email, "dark");

        await toggle.click();
        await expect(page.locator("html")).toHaveAttribute(
          "data-theme",
          "light",
        );
        await expect(logo).toHaveAttribute("src", lightLogoSrc);
        await expectLogo(page);
        await expect(email).toHaveValue("theme-preview@example.com");
        await expectInputBoundary(email, "light");
      }
    });

    test("hosted password feedback remains clear after reflow", async ({
      page,
    }) => {
      await openAuth(page, "/sign-up", device.theme);
      const password = page.getByLabel("Password", { exact: true });
      const error = page.locator(".cl-formFieldErrorText:visible");
      const legalConsent = page.getByRole("checkbox");

      await password.fill("a");
      await page.getByLabel("Email address", { exact: true }).focus();
      await expect(error).toContainText(/password/i);
      await expectSeparated(password, error);
      await expectSeparated(error, legalConsent);
      await page.setViewportSize({ width: 375, height: 812 });
      await expectSeparated(password, error);
      await expectSeparated(error, legalConsent);

      await page.setViewportSize({ width: 375, height: 568 });
      await page
        .getByRole("link", { exact: true, name: "Sign in" })
        .scrollIntoViewIfNeeded();
      await expect
        .poll(() => {
          return page
            .getByTestId("app-auth-layout")
            .evaluate((element) => element.scrollTop);
        })
        .toBeGreaterThan(0);
      await expectAuthBackgroundCoversViewport(page);
    });

    test("hosted password reveal preserves the password and fits a short viewport", async ({
      page,
    }) => {
      await openAuth(page, "/sign-up", device.theme);
      await page.setViewportSize({ width: 375, height: 568 });
      const password = page.getByLabel("Password", { exact: true });
      const longPassword = "A-Long-Password-For-Reveal-Layout!2026";
      await password.fill(longPassword);
      const show = page.getByRole("button", {
        exact: true,
        name: "Show password",
      });
      await expectPasswordControlFits(password, show);

      await show.focus();
      await page.keyboard.press("Enter");
      const hide = page.getByRole("button", {
        exact: true,
        name: "Hide password",
      });
      await expect(password).toHaveAttribute("type", "text");
      await expect(password).toHaveValue(longPassword);
      await expectPasswordControlFits(password, hide);
      await hide.click();
      await expect(password).toHaveAttribute("type", "password");
      await expectPasswordControlFits(password, show);
    });

    test("hosted legal consent remains keyboard accessible in a short viewport", async ({
      page,
    }) => {
      await openAuth(page, "/sign-up", device.theme);
      await page.setViewportSize({ width: 375, height: 568 });
      const legalConsent = page.getByRole("checkbox");
      await legalConsent.focus();
      await page.keyboard.press("Space");
      await expect(legalConsent).toBeChecked();
      await page.keyboard.press("Space");
      await expect(legalConsent).not.toBeChecked();
      const legalLinks = page.locator(".cl-formFieldCheckboxLabel a");
      await expect(legalLinks).toHaveCount(2);
      for (const link of await legalLinks.all()) {
        await expect(link).toBeVisible();
        await expect(link).toHaveAttribute("href", /^https:\/\//);
      }
    });

    test("hosted signup keeps native OTP feedback clear of inputs and resend on retry", async ({
      page,
    }) => {
      await openAuth(page, "/sign-up", device.theme);
      await page
        .getByLabel("Email address", { exact: true })
        .fill(`auth-v1-${randomUUID()}+clerk_test@example.com`);
      await page
        .getByLabel("Password", { exact: true })
        .fill("A-Strong-Password-For-OTP-Layout!2026");
      const legalConsent = page.getByRole("checkbox");
      await legalConsent.click();
      await expect(legalConsent).toBeChecked();
      await expect(
        page.getByRole("button", { exact: true, name: "Continue" }),
      ).toBeEnabled();
      await page.getByRole("button", { exact: true, name: "Continue" }).click();

      const inputs = page.locator(".cl-otpCodeFieldInputs");
      const error = page.locator(".cl-otpCodeFieldErrorText:visible");
      const resend = page.locator(".cl-formResendCodeLink");
      await expect(inputs).toBeVisible();
      const primaryAction = page.getByRole("button", {
        exact: true,
        name: "Continue",
      });
      await expect(primaryAction).toHaveCSS(
        "background-color",
        "rgb(255, 165, 0)",
      );
      await expect(primaryAction).toHaveCSS("color", "rgb(36, 35, 33)");
      const slots = page.locator(".cl-otpCodeFieldInput");
      await expect(slots).toHaveCount(6);
      const expectedBorderColor =
        device.theme === "light" ? "rgb(207, 204, 203)" : "rgb(86, 84, 84)";
      for (const slot of await slots.all()) {
        await expect(slot).toHaveCSS("border-color", expectedBorderColor);
      }
      const code = page.getByRole("textbox", {
        name: "Enter verification code",
      });
      await code.fill("1");
      await expect(code).toBeFocused();
      await expect(code).toHaveValue("1");
      const activeSlot = page.locator(
        '.cl-otpCodeFieldInput[data-focus-within="true"]',
      );
      await expect(activeSlot).toHaveCount(1);
      await expect(activeSlot).toHaveCSS("box-shadow", /3px/u);
      await code.clear();
      await enterInvalidCode(page, "000000");
      await expect(error).not.toBeEmpty();
      await expectSeparated(inputs, error);
      await expectSeparated(error, resend);
      for (const slot of await page.locator(".cl-otpCodeFieldInput").all()) {
        await expect(slot).toHaveAttribute("aria-invalid", "true");
      }

      await page.setViewportSize({ width: 375, height: 812 });
      await expectSeparated(inputs, error);
      await expectSeparated(error, resend);
      await enterInvalidCode(page, "000001");
      await expect(error).not.toBeEmpty();
      await expectSeparated(inputs, error);
      await expectSeparated(error, resend);
      // Do not verify the signup: no user or active session is created.
    });

    test("hosted sign-in preserves help and recovery hierarchy through navigation", async ({
      page,
    }) => {
      const email = generateTestEmail("playwright");
      const password = `Auth-Layout!${randomUUID()}`;
      if (!process.env.CLERK_SECRET_KEY?.startsWith("sk_test_")) {
        throw new Error("Auth layout fixtures require a development Clerk key");
      }
      if (process.env.CI) {
        console.log(`::add-mask::${email}`);
        console.log(`::add-mask::${password}`);
      }
      try {
        await createUser(email, password);
        await openAuth(page, "/sign-in", device.theme);
        const documentMarker = randomUUID();
        await page.evaluate((marker) => {
          Reflect.set(window, "__okouAuthV1DocumentMarker", marker);
        }, documentMarker);
        const passkey = page.locator(
          ".cl-footerAction__usePasskey .cl-footerActionLink",
        );
        if (await passkey.count()) {
          await expect(passkey).toBeVisible();
          await expect(passkey).toBeEnabled();
        }
        await page.getByLabel("Email address", { exact: true }).fill(email);
        await page
          .getByRole("button", { exact: true, name: "Continue" })
          .click();
        await expect(
          page.getByLabel("Password", { exact: true }),
        ).toBeVisible();
        expect(
          await page.evaluate(() => {
            return Reflect.get(window, "__okouAuthV1DocumentMarker");
          }),
        ).toBe(documentMarker);

        const otherMethod = page.getByRole("link", {
          name: "Use another method",
        });
        await otherMethod.click();
        const emailMethod = page.getByRole("button", { name: /email code/i });
        await expect(emailMethod).toBeVisible();

        await page.getByRole("link", { name: "Get help" }).click();
        await expect(
          page.getByRole("button", { name: /email support/i }),
        ).toBeEnabled();
        const back = page.getByRole("link", { exact: true, name: "Back" });
        await expect(back).toBeVisible();
        await back.click();
        await page.getByRole("link", { name: "Back", exact: true }).click();
        await expect(
          page.getByLabel("Password", { exact: true }),
        ).toBeVisible();

        await page.getByRole("link", { name: /forgot password/i }).click();
        const reset = page.getByRole("button", {
          name: /reset your password/i,
        });
        await expect(reset).toBeEnabled();
        await clickAndAwaitPreparedFactor(reset);
        await enterInvalidCode(page, "000000");
        await expectSeparated(
          page.locator(".cl-otpCodeFieldInputs"),
          page.locator(".cl-otpCodeFieldErrorText:visible"),
        );
        // Do not complete a reset or activate a session. The exact test user
        // is removed below, with the CI generation finalizer as crash cleanup.
      } finally {
        await deleteUserByEmail(email);
      }
    });
  });
}
