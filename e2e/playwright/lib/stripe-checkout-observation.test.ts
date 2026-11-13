import assert from "node:assert/strict";
import { test } from "node:test";

import { chromium } from "@playwright/test";

import { collectStripeCheckoutState } from "./stripe-checkout";
import { observeStripeCheckout } from "./stripe-checkout-observation";

test("checkout observations distinguish invalid submission from a completed request without retaining capabilities or inputs", async (context) => {
  const browser = await chromium.launch();
  context.after(() => browser.close());
  const page = await browser.newPage();
  const observer = await observeStripeCheckout(page);
  context.after(() => observer.dispose());
  const sentinel = "private-checkout-sentinel";
  await page.route("https://checkout.stripe.com/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Checkout fixture</title>
      <form>
        <label>Email<input name="email" type="email" required></label>
        <input name="${sentinel}" value="${sentinel}">
        <input type="hidden" value="${sentinel}">
        <button type="submit">Subscribe</button>
      </form>
      <script>
        document.querySelector('form').addEventListener('submit', async (event) => {
          event.preventDefault();
          const response = await fetch('https://api.stripe.com/v1/payment_pages/${sentinel}/confirm?secret=${sentinel}', {
            method: 'POST', body: '${sentinel}',
          });
          await response.text();
          location.href = 'https://app.example.com/?session=${sentinel}';
        });
      </script>`,
    }),
  );
  await page.route("https://api.stripe.com/**", (route) =>
    route.fulfill({
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ status: "complete", secret: sentinel }),
    }),
  );
  await page.route("https://app.example.com/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "Checkout completed",
    }),
  );
  await page.goto(`https://checkout.stripe.com/c/pay/${sentinel}#${sentinel}`);
  await page.getByLabel("Email", { exact: true }).fill(sentinel);
  await page.getByRole("button", { name: "Subscribe" }).click();

  const invalid = await collectStripeCheckoutState(page);
  const email = invalid.frames[0].inputs.find(
    (input) => input.name === "email",
  );
  assert.equal(email?.typeMismatch, true);
  assert.equal(email?.focused, true);
  assert.deepEqual(invalid.frames[0].formEvents?.invalidFields, ["email"]);
  assert.equal(invalid.frames[0].formEvents?.submitEvents, 0);
  assert.deepEqual(observer.snapshot().requests, []);
  // Reading validity must not invoke checkValidity/reportValidity or change
  // focus, inputs or validation events while collecting failure evidence.
  const repeated = await collectStripeCheckoutState(page);
  assert.deepEqual(repeated, invalid);
  assert.equal(
    await page.getByLabel("Email", { exact: true }).inputValue(),
    sentinel,
  );

  await page
    .getByLabel("Email", { exact: true })
    .fill(`${sentinel}@example.com`);
  const finished = page.waitForEvent("requestfinished", {
    predicate: (request) =>
      new URL(request.url()).origin === "https://api.stripe.com",
  });
  await page.getByRole("button", { name: "Subscribe" }).click();
  await page.waitForURL((url) => url.origin === "https://app.example.com");
  await finished;
  const completed = observer.snapshot();
  assert.equal(completed.requests.length, 1);
  assert.equal(completed.requests[0].kind, "confirm");
  assert.equal(completed.requests[0].origin, "https://api.stripe.com");
  assert.equal(completed.requests[0].status, 200);
  assert.equal(completed.requests[0].outcome, "finished");
  assert.ok(
    completed.navigations.some(
      (navigation) =>
        navigation.main && navigation.origin === "https://app.example.com",
    ),
  );
  assert.doesNotMatch(
    JSON.stringify({ invalid, completed }),
    new RegExp(sentinel, "u"),
  );
});
