import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, type Page } from "@playwright/test";

import { fillStripeCheckout } from "./stripe-checkout";

const CHECKOUT_URL = "https://checkout.stripe.com/e2e-checkout-fixture";

// Mock only the external provider document; browser form and submit behavior
// is real. `revealLink` reproduces Link appearing selected after email entry,
// with a phone number required while it stays selected.
function checkoutDocument(revealLink: boolean): string {
  const linkScript = revealLink
    ? `document.querySelector('[name="email"]').addEventListener('input', function () {
        document.querySelector('#link').innerHTML =
          '<label><input id="save" type="checkbox" checked>Save my information with Link for faster checkout</label>' +
          '<label>Phone number <input id="phone" required pattern="[0-9]{10}"></label>';
        document.querySelector('#save').addEventListener('change', function () {
          document.querySelector('#phone').required = this.checked;
        });
      });`
    : "";
  return `<!doctype html>
    <form>
      <label>Email <input name="email" type="email" required></label>
      <label>Card number <input name="cardNumber" required></label>
      <label>Expiry <input name="cardExpiry" required></label>
      <label>CVC <input name="cardCvc" required></label>
      <label>Cardholder name <input name="billingName" required></label>
      <label>Postal code <input name="billingPostalCode" required></label>
      <div id="link"></div>
      <button type="submit">Subscribe</button>
    </form>
    <script>
      window.purchaseCount = 0;
      ${linkScript}
      document.querySelector('form').addEventListener('submit', function (event) {
        event.preventDefault();
        window.purchaseCount += 1;
        document.body.insertAdjacentHTML('beforeend', '<h1>Payment submitted</h1>');
      });
    </script>`;
}

async function submitCheckout(page: Page, revealLink: boolean): Promise<void> {
  await page.route(CHECKOUT_URL, async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: checkoutDocument(revealLink),
    });
  });
  await page.goto(CHECKOUT_URL);
  await fillStripeCheckout(page);
  assert.equal(
    await page.getByRole("heading", { name: "Payment submitted" }).count(),
    1,
  );
  assert.equal(await page.evaluate("window.purchaseCount"), 1);
}

test("checkout submits once after email reveals a selected Link phone requirement", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await submitCheckout(page, true);
    assert.equal(
      await page
        .getByRole("checkbox", { name: /save my information/i })
        .isChecked(),
      false,
    );
  } finally {
    await browser.close();
  }
});

test("checkout submits once when the form offers no Link choice", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await submitCheckout(page, false);
  } finally {
    await browser.close();
  }
});
