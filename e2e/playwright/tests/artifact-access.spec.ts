import { randomUUID } from "node:crypto";
import type { Locator } from "@playwright/test";
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

// Theme preferences belong to the account. Keep this visual journey isolated
// from the shared feature-test account and its parallel chat tests.
test.use({ storageState: { cookies: [], origins: [] } });

// Every denial answers with the same status so artifacts cannot be enumerated,
// which leaves the page unable to tell a missing reference from a withheld one.
// Neither recovery action is known to work, so neither may take the primary
// fill and present itself as the answer.
async function expectNoPrimaryFill(button: Locator) {
  await expect
    .poll(() =>
      button.evaluate((element) => {
        const style = getComputedStyle(element);
        const context = document.createElement("canvas").getContext("2d");
        if (!context) throw new Error("Canvas color conversion is unavailable");
        const rgba = (color: string) => {
          context.clearRect(0, 0, 1, 1);
          context.fillStyle = color;
          context.fillRect(0, 0, 1, 1);
          return Array.from(context.getImageData(0, 0, 1, 1).data).join(",");
        };
        return (
          rgba(style.backgroundColor) ===
          rgba(`hsl(${style.getPropertyValue("--primary")})`)
        );
      }),
    )
    .toBe(false);
}

async function buttonContrast(button: Locator): Promise<number> {
  return button.evaluate(async (element) => {
    await Promise.all(
      element.getAnimations().map((animation) => animation.finished),
    );
    const style = getComputedStyle(element);
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas color conversion is unavailable");
    const luminance = () => {
      const channels = Array.from(context.getImageData(0, 0, 1, 1).data)
        .slice(0, 3)
        .map((channel) => {
          const value = channel / 255;
          return value <= 0.04045
            ? value / 12.92
            : ((value + 0.055) / 1.055) ** 2.4;
        });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    // Outline controls use translucent interaction fills. Composite them over
    // their actual card surface before measuring the rendered text contrast.
    const layers: string[] = [];
    let ancestor: Element | null = element;
    while (ancestor) {
      layers.unshift(getComputedStyle(ancestor).backgroundColor);
      ancestor = ancestor.parentElement;
    }
    context.fillStyle = "white";
    context.fillRect(0, 0, 1, 1);
    for (const color of layers) {
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
    }
    const background = luminance();
    context.fillStyle = style.color;
    context.fillRect(0, 0, 1, 1);
    const foreground = luminance();
    return (
      (Math.max(foreground, background) + 0.05) /
      (Math.min(foreground, background) + 0.05)
    );
  });
}

test("unavailable artifacts recover access with readable actions that follow the selected theme", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const appUrl = deriveAppUrl(resolveApiBackendUrl());
  const email = generateTestEmail("playwright");
  const userId = await createUser(email);
  const orgId = await createOrganization(
    "Artifact access review",
    userId,
    "playwright",
  );
  await signInWithClerkEmailCode(page, email, appUrl, {
    activeOrganizationId: orgId,
  });
  await completeExploreOnboarding(page, { appUrl });

  await page.goto(`${appUrl}/_/lab`);
  for (const name of [/gradientColorThemes/, /privateArtifacts/]) {
    const control = page.getByRole("switch", { name });
    if (!(await control.isChecked())) {
      await control.click();
    }
    await expect(control).toBeChecked();
    await expect(control).toBeEnabled();
  }
  // Enabling the capability does not tint the document on its own: a workspace
  // starts on the default palette, which is the absence of both palette
  // attributes. The loop below asserts each preset's attributes once selected.
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-gradient-color-themes",
    "",
  );
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-color-theme",
    /.*/u,
  );

  // A fresh, valid reference exercises the resolver's real unavailable response
  // without depending on another user's artifact or revealing its metadata.
  const reference = randomUUID().replaceAll("-", "");
  const artifactUrl = `${appUrl}/artifacts/${reference}.html?source=access-review#detail`;
  const heading = page.getByRole("heading", {
    name: "You can’t view this artifact",
  });
  const switchAccount = page.getByRole("button", {
    name: "Switch account",
    exact: true,
  });
  const retry = page.getByRole("button", { name: "Try again", exact: true });
  const samples: {
    theme: string;
    palette: string;
    action: string;
    state: string;
    contrast: number;
  }[] = [];

  for (const palette of ["Blue horizon", "Golden hour"]) {
    for (const theme of ["Light", "Dark"]) {
      await page.setViewportSize({ width: 1440, height: 900 });
      // Open settings from a stable route: home redirects to chat, whose setup
      // waits for the agents list before opening the dialog.
      await page.goto(`${appUrl}/agents?settings=preference`);
      const settings = page.getByRole("dialog", { name: "Settings" });
      await expect(settings).toBeVisible();
      await settings.getByRole("button", { name: theme, exact: true }).click();
      const paletteButton = settings.getByRole("button", {
        name: palette,
        exact: true,
      });
      if ((await paletteButton.getAttribute("aria-pressed")) !== "true") {
        const saved = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === "/api/user-preferences" &&
            response.request().method() === "POST" &&
            response.ok(),
        );
        await paletteButton.click();
        await saved;
      }
      await page.goto(artifactUrl);
      await expect(heading).toBeVisible();
      await expect(
        page.getByText(`Signed in as ${email}`, { exact: true }),
      ).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute(
        "data-theme",
        theme.toLowerCase(),
      );
      await expect(page.locator("html")).toHaveAttribute(
        "data-color-theme",
        palette.toLowerCase().replaceAll(" ", "-"),
      );
      await expect(page.locator("iframe")).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Share", exact: true }),
      ).toHaveCount(0);
      for (const [action, button] of [
        ["switch", switchAccount],
        ["retry", retry],
      ] as const) {
        await page.mouse.move(0, 0);
        await expectNoPrimaryFill(button);
        await expect
          .poll(() => buttonContrast(button))
          .toBeGreaterThanOrEqual(4.5);
        samples.push({
          theme,
          palette,
          action,
          state: "rest",
          contrast: await buttonContrast(button),
        });
        await button.hover();
        await expect
          .poll(() => buttonContrast(button))
          .toBeGreaterThanOrEqual(4.5);
        samples.push({
          theme,
          palette,
          action,
          state: "hover",
          contrast: await buttonContrast(button),
        });
        await page.mouse.down();
        try {
          await expect
            .poll(() => buttonContrast(button))
            .toBeGreaterThanOrEqual(4.5);
          samples.push({
            theme,
            palette,
            action,
            state: "pressed",
            contrast: await buttonContrast(button),
          });
        } finally {
          // Release outside the control so this color check does not activate it.
          await page.mouse.move(0, 0);
          await page.mouse.up();
        }
      }
      await page.mouse.move(0, 0);
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await testInfo.attach(
        `artifact-access-${theme.toLowerCase()}-${palette.toLowerCase().replaceAll(" ", "-")}`,
        {
          body: await page.screenshot({ animations: "disabled" }),
          contentType: "image/png",
        },
      );
      if (palette === "Blue horizon") {
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(switchAccount).toBeInViewport();
        await expect(retry).toBeInViewport();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await testInfo.attach(`artifact-access-mobile-${theme.toLowerCase()}`, {
          body: await page.screenshot({ animations: "disabled" }),
          contentType: "image/png",
        });
      }
    }
  }

  const resolved = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
      `/api/artifact-references/${reference}.html`,
  );
  await retry.click();
  expect((await resolved).status()).toBe(404);
  await expect(heading).toBeVisible();
  expect(page.url()).toBe(artifactUrl);
  await expect(
    page.getByRole("link", { name: "Back to Okou" }),
  ).toHaveAttribute("href", "/");
  await switchAccount.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(page.url()).toBe(artifactUrl);
  await testInfo.attach("artifact-access-button-contrast", {
    body: JSON.stringify(samples, null, 2),
    contentType: "application/json",
  });
});
