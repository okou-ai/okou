import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { chromium, expect } from "@playwright/test";

import { formatErrorReport } from "./error-report";
import { capturePaidOnboardingFailure } from "./paid-onboarding-diagnostics";
import {
  collectStripeCheckoutState,
  fillStripeCheckout,
} from "./stripe-checkout";
import { observeStripeCheckout } from "./stripe-checkout-observation";

function gate() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((release) => {
    resolve = release;
  });
  return { promise, resolve };
}

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

test("checkout completes in a late nested Stripe form with collapsed Card controls", async (context) => {
  const browser = await chromium.launch();
  context.after(() => browser.close());
  const page = await browser.newPage();
  const observer = await observeStripeCheckout(page);
  context.after(() => observer.dispose());
  const attachRequested = gate();
  const attachReleased = gate();
  const cardRequested = gate();
  const cardReleased = gate();
  await page.route("https://checkout.stripe.com/fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html>
        <button hidden>Subscribe</button>
        <iframe src="https://js.stripe.com/controller"></iframe>
        <output></output>
        <script>
          addEventListener('message', (event) => {
            if (event.origin === 'https://js.stripe.com') {
              document.querySelector('output').textContent = event.data;
            }
          });
        </script>`,
    }),
  );
  await page.route("https://js.stripe.com/controller", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><button>Pay securely with Link</button><script>
        fetch('/attach-form').then(() => {
          const form = document.createElement('iframe');
          form.src = '/form';
          document.body.append(form);
        });
      </script>`,
    }),
  );
  await page.route("https://js.stripe.com/attach-form", async (route) => {
    attachRequested.resolve();
    await attachReleased.promise;
    await route.fulfill({ body: "ready" });
  });
  await page.route("https://js.stripe.com/form", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html>
        <form>
          <label>Email<input name="email" type="text" inputmode="email" required></label>
          <button type="button" id="card">Card</button>
          <section id="fields"></section>
          <label><input id="saveInfo" type="checkbox" checked>Save my information for faster checkout</label>
          <label id="phoneLabel">Phone number<input id="phone" type="tel" required></label>
          <button type="submit">Subscribe</button>
        </form>
        <script>
          const saveInfo = document.getElementById('saveInfo');
          const phone = document.getElementById('phone');
          const phoneLabel = document.getElementById('phoneLabel');
          function updateLink() {
            phone.required = saveInfo.checked;
            phoneLabel.hidden = !saveInfo.checked;
          }
          saveInfo.addEventListener('change', updateLink);
          document.querySelector('[name=email]').addEventListener('input', () => {
            saveInfo.checked = true;
            updateLink();
          });
          document.getElementById('card').addEventListener('click', (event) => {
            if (!event.isTrusted) return;
            fetch('/card-fields').then(response => response.text()).then(html => {
              document.getElementById('fields').innerHTML = html;
            });
          }, {once: true});
          document.querySelector('form').addEventListener('submit', (event) => {
            event.preventDefault();
            window.top.postMessage(saveInfo.checked
              ? 'Checkout completed with Link'
              : 'Checkout completed without Link', 'https://checkout.stripe.com');
          });
        </script>`,
    }),
  );
  await page.route("https://js.stripe.com/card-fields", async (route) => {
    cardRequested.resolve();
    await cardReleased.promise;
    await route.fulfill({
      contentType: "text/html",
      body: `<label>Card number<input name="cardNumber" required></label>
        <label>Expiration (MM/YY)<input name="cardExpiry" required></label>
        <label>Security code<input name="cardCvc" required></label>
        <label>Name on card<input name="billingName" required></label>
        <label>ZIP code<input name="billingPostalCode" required></label>`,
    });
  });

  try {
    await page.goto("https://checkout.stripe.com/fixture", {
      waitUntil: "domcontentloaded",
    });
    await attachRequested.promise;
    const checkout = fillStripeCheckout(page);
    attachReleased.resolve();
    // Observe Card activation before releasing the delayed fields. A timeout
    // must also release the fixture gates so teardown can drain the routes.
    await Promise.race([cardRequested.promise, checkout]);
    cardReleased.resolve();
    await checkout;
    await expect(page.getByRole("status")).toHaveText(
      "Checkout completed without Link",
    );
    const state = await collectStripeCheckoutState(page);
    const form = state.frames.find((frame) => frame.submit.visible);
    assert.equal(form?.formEvents?.emailInputEvents, 1);
    assert.equal(form?.formEvents?.emailChangeEvents, 1);
    assert.equal(form?.formEvents?.emailBlurEvents, 1);
  } finally {
    attachReleased.resolve();
    cardReleased.resolve();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("missing submit readiness retains its cause and sanitized payment diagnostics", async (context) => {
  const browser = await chromium.launch();
  context.after(() => browser.close());
  const directory = await mkdtemp(join(tmpdir(), "checkout-diagnostics-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const page = await browser.newPage();
  const sentinel = "private-checkout-sentinel";
  await page.route("https://checkout.stripe.com/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Checkout fixture</title>
        <label>Email<input value="${sentinel}@example.com"></label>
        <iframe src="https://js.stripe.com/${sentinel}?secret=${sentinel}"></iframe>`,
    }),
  );
  await page.route("https://js.stripe.com/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html>
        <button>Card</button><button hidden>Start trial</button>
        <label>Card number<input name="cardNumber" value="${sentinel}"></label>`,
    }),
  );
  await page.goto(
    `https://checkout.stripe.com/c/pay/${sentinel}?secret=${sentinel}#${sentinel}`,
  );

  await assert.rejects(fillStripeCheckout(page), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Stripe Checkout form did not become ready/u);
    assert.ok(error.cause instanceof Error);
    assert.match(
      error.cause.message,
      /Stripe Checkout submit control must be visible/u,
    );
    assert.doesNotMatch(formatErrorReport(error), new RegExp(sentinel, "u"));
    return true;
  });
  await capturePaidOnboardingFailure(page, "fixture.json", directory);
  const output = join(directory, "e2e-runner-checkout-diagnostics", "fixture");
  const json = await readFile(`${output}.json`, "utf8");
  assert.doesNotMatch(json, new RegExp(sentinel, "u"));
  const report = JSON.parse(json);
  assert.equal(report.clerk.state.route, "https://checkout.stripe.com");
  assert.equal(report.stripe.frames[0].readyState, "complete");
  assert.deepEqual(report.stripe.frames[0].submit, {
    count: 0,
    visible: false,
  });
  const embedded = report.stripe.frames.find(
    (frame: { origin: string }) => frame.origin === "https://js.stripe.com",
  );
  assert.deepEqual(embedded.submit, { count: 0, visible: false });
  assert.deepEqual(embedded.payWithCard, { count: 1, visible: true });
  assert.deepEqual(
    (await readFile(`${output}.png`)).subarray(1, 4),
    Buffer.from("PNG"),
  );
});
