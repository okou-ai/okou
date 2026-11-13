import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { chromium } from "@playwright/test";

import { capturePaidOnboardingFailure } from "./paid-onboarding-diagnostics";
import { collectStripeCheckoutState } from "./stripe-checkout";
import { observeStripeCheckout } from "./stripe-checkout-observation";

test(
  "unresponsive Checkout retains network evidence without waiting for renderer state",
  { timeout: 15_000 },
  async (context) => {
    const browser = await chromium.launch();
    context.after(() => browser.close());
    const directory = await mkdtemp(join(tmpdir(), "checkout-stalled-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const page = await browser.newPage();
    const observer = await observeStripeCheckout(page);
    context.after(() => observer.dispose());
    const sentinel = "private-checkout-sentinel";
    await page.route("https://checkout.stripe.com/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><script>
      fetch('/${sentinel}/confirm?secret=${sentinel}', { method: 'POST', body: '${sentinel}' })
        .then(response => response.text()).then(() => {
          console.log('checkout-renderer-blocked');
          while (true) {}
        });
    </script>`,
      }),
    );
    await page.route("https://checkout.stripe.com/**/confirm?*", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: "{}",
      }),
    );
    const blocked = page.waitForEvent("console", {
      predicate: (message) => message.text() === "checkout-renderer-blocked",
    });
    const finished = page.waitForEvent("requestfinished", {
      predicate: (request) => request.method() === "POST",
    });
    await page.goto(`https://checkout.stripe.com/c/pay/${sentinel}`, {
      waitUntil: "commit",
    });
    await Promise.all([blocked, finished]);

    // Readiness/field errors collect the same optional state before reaching
    // the outer failure writer; that path must have a deadline as well.
    await assert.rejects(
      collectStripeCheckoutState(page),
      /state capture deadline exceeded/u,
    );
    await capturePaidOnboardingFailure(
      page,
      "fixture.json",
      directory,
      observer.snapshot(),
    );

    const json = await readFile(
      join(directory, "e2e-runner-checkout-diagnostics", "fixture.json"),
      "utf8",
    );
    const report = JSON.parse(json);
    assert.deepEqual(report.clerk, { kind: "unavailable" });
    assert.equal(report.stripe, null);
    assert.equal(report.checkoutObservation.requests.length, 1);
    assert.equal(report.checkoutObservation.requests[0].kind, "confirm");
    assert.equal(report.checkoutObservation.requests[0].status, 200);
    assert.equal(report.checkoutObservation.requests[0].outcome, "finished");
    assert.doesNotMatch(json, new RegExp(sentinel, "u"));
  },
);
