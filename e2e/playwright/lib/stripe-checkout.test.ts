import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "@playwright/test";

import { fillStripeCheckout } from "./stripe-checkout";

test("checkout submits once after email reveals a selected Link phone requirement", async () => {
  const browser = await chromium.launch({
    executablePath: process.env.STRIPE_TEST_CHROMIUM_PATH,
  });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const checkoutUrl = "https://checkout.stripe.com/e2e-late-link";
    // Mock the external provider document; browser form/action behavior is real.
    await page.route(checkoutUrl, async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: `<!doctype html>
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
            document.querySelector('[name="email"]').addEventListener('input', function () {
              document.querySelector('#link').innerHTML =
                '<label><input id="save" type="checkbox" checked>Save my information with Link for faster checkout</label>' +
                '<label>Phone number <input id="phone" required pattern="[0-9]{10}"></label>';
              document.querySelector('#save').addEventListener('change', function () {
                document.querySelector('#phone').required = this.checked;
              });
            });
            document.querySelector('form').addEventListener('submit', function (event) {
              event.preventDefault();
              window.purchaseCount += 1;
              document.body.insertAdjacentHTML('beforeend', '<h1>Payment submitted</h1>');
            });
          </script>`,
      });
    });
    await page.goto(checkoutUrl);
    await fillStripeCheckout(page);
    assert.equal(
      await page.getByRole("heading", { name: "Payment submitted" }).count(),
      1,
    );
    assert.equal(await page.evaluate("window.purchaseCount"), 1);
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
