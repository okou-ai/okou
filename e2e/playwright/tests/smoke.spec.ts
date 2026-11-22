import { randomUUID } from "node:crypto";
import { Webhook } from "standardwebhooks";
import { previewClerkWebhookKey } from "../../scripts/preview-clerk-webhook-key";
import { resolveApiBackendUrl } from "../api-backend-url";
import { expect, test } from "../fixtures";
import { signInWithClerkEmailCode } from "../lib/auth";
import {
  createOrganizationRecord,
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
  const name = "E2E Test Org";
  const organization = await createOrganizationRecord(
    name,
    userId,
    "playwright",
  );
  const orgId = organization.id;
  const apiUrl = resolveApiBackendUrl();
  const appUrl = deriveAppUrl(apiUrl);

  if (
    process.env.GITHUB_EVENT_NAME === "pull_request" ||
    process.env.GITHUB_EVENT_NAME === "merge_group"
  ) {
    // The isolated preview consumes only the organization this test just created.
    expect(organization.created_at, "Clerk organization creation time").toEqual(
      expect.any(Number),
    );
    const id = randomUUID();
    const timestamp = new Date();
    const body = JSON.stringify({
      object: "event",
      type: "organization.created",
      data: {
        id: orgId,
        name,
        created_at: organization.created_at,
        created_by: userId,
      },
    });
    const response = await fetch(new URL("/api/webhooks/clerk", apiUrl), {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        "svix-id": id,
        "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
        "svix-signature": new Webhook(previewClerkWebhookKey()).sign(
          id,
          timestamp,
          body,
        ),
        ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET
          ? {
              "x-vercel-protection-bypass":
                process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
            }
          : {}),
      },
      body,
    });
    expect(
      response.status,
      "Deliver the test organization's creation to its preview",
    ).toBe(200);
  }

  const token = await signInWithClerkEmailCode(page, email, appUrl, {
    activeOrganizationId: orgId,
  });

  await expect
    .poll(
      async () => {
        const billing = await page.request.get(
          new URL("/api/billing/usage-pack-credits", apiUrl).href,
          {
            headers: authHeadersForToken(token),
          },
        );
        if (!billing.ok()) {
          throw new Error(
            `Read creator credit balance returned HTTP ${billing.status()}`,
          );
        }
        const balance = await billing.json();
        return balance.bonusCredits;
      },
      {
        timeout: 60_000,
        message: "The workspace creator must receive the onboarding bonus",
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
