import { test } from "node:test";

import { chromium, expect } from "@playwright/test";

import { fillStripeCheckout } from "./stripe-checkout";

test("card checkout stays opted out of Link after email updates", async (context) => {
  const browser = await chromium.launch();
  context.after(() => browser.close());
  const page = await browser.newPage();
  await page.route("https://checkout.stripe.com/fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html>
        <form>
          <label for="email">Email</label><input id="email" name="email" type="email" required>
          <label for="cardNumber">Card number</label><input id="cardNumber" name="cardNumber" required>
          <label for="cardExpiry">Expiry</label><input id="cardExpiry" name="cardExpiry" required>
          <label for="cardCvc">CVC</label><input id="cardCvc" name="cardCvc" required>
          <label for="billingName">Cardholder name</label><input id="billingName" name="billingName">
          <label for="billingPostalCode">ZIP</label><input id="billingPostalCode" name="billingPostalCode">
          <label><input id="saveInfo" type="checkbox" checked>Save my information with Link</label>
          <label id="phoneLabel">Phone number<input id="phone" type="tel" required></label>
          <button type="submit">Subscribe</button>
        </form>
        <output></output>
        <script>
          const email = document.getElementById('email');
          const saveInfo = document.getElementById('saveInfo');
          const phone = document.getElementById('phone');
          const phoneLabel = document.getElementById('phoneLabel');
          function updateLink() {
            phone.required = saveInfo.checked;
            phoneLabel.hidden = !saveInfo.checked;
          }
          saveInfo.addEventListener('change', updateLink);
          email.addEventListener('input', () => {
            saveInfo.checked = true;
            updateLink();
          });
          document.querySelector('form').addEventListener('submit', (event) => {
            event.preventDefault();
            document.querySelector('output').textContent = saveInfo.checked
              ? 'Checkout completed with Link'
              : 'Checkout completed without Link';
          });
        </script>`,
    }),
  );
  await page.goto("https://checkout.stripe.com/fixture");

  await fillStripeCheckout(page);

  await expect(page.getByRole("status")).toHaveText(
    "Checkout completed without Link",
  );
});
