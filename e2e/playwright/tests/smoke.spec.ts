import { randomUUID } from "node:crypto";
import { Webhook } from "standardwebhooks";

import { resolveApiBackendUrl } from "../api-backend-url";
import { expect, test } from "../fixtures";
import { signInWithClerkEmailCode } from "../lib/auth";
import {
  createOrganization,
  createUser,
  generateTestEmail,
} from "../lib/clerk-api";
import {
  authHeadersForToken,
  completePromptOnboarding,
} from "../lib/onboarding";
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

  // Clerk sends this event to its standing endpoint. An isolated PR preview
  // needs the same delivery for its newly created test organization.
  const signingSecret = process.env.E2E_CLERK_WEBHOOK_SIGNING_SECRET;
  if (signingSecret) {
    const id = randomUUID();
    const created = new Date();
    const payload = JSON.stringify({
      object: "event",
      type: "organization.created",
      data: {
        id: orgId,
        name: "E2E Test Org",
        created_by: userId,
        created_at: created.getTime(),
      },
    });
    const delivery = await page.request.post(
      new URL("/api/webhooks/clerk", apiUrl).href,
      {
        headers: {
          "content-type": "application/json",
          "svix-id": id,
          "svix-timestamp": String(Math.floor(created.getTime() / 1000)),
          "svix-signature": new Webhook(signingSecret).sign(
            id,
            created,
            payload,
          ),
          ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET
            ? {
                "x-vercel-protection-bypass":
                  process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
              }
            : {}),
        },
        data: payload,
        maxRedirects: 0,
      },
    );
    expect(delivery.status()).toBe(200);
  }
  const token = await signInWithClerkEmailCode(page, email, appUrl, {
    activeOrganizationId: orgId,
  });

  await expect
    .poll(
      async () => {
        const billing = await page.request.get(
          new URL("/api/billing/status", apiUrl).href,
          {
            headers: authHeadersForToken(token),
          },
        );
        if (!billing.ok()) {
          throw new Error(
            `Read workspace billing status returned HTTP ${billing.status()}`,
          );
        }
        const status = await billing.json();
        return status.credits;
      },
      {
        timeout: 60_000,
        message: "The workspace's onboarding credits must be available",
      },
    )
    .toBeGreaterThan(0);

  // The onboarding prompt handoff sends the message as the first chat.
  await completePromptOnboarding(page, {
    appUrl,
    prompt: "Reply with only the word: SMOKE_OK",
  });

  await expect(
    page.locator('[data-role="assistant"] [data-chat-selection-source]').last(),
  ).toContainText("SMOKE_OK", { timeout: 90_000 });

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
