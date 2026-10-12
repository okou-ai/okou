import {
  errors,
  expect,
  type Frame,
  type Locator,
  type Page,
} from "@playwright/test";

const FIELD_TIMEOUT_MS = 10_000;

interface StripeFieldDefinition {
  readonly label: RegExp;
  readonly name: string;
  readonly placeholder: RegExp;
}

interface StripeLocatorState {
  readonly count: number;
  readonly visible: boolean;
}

interface StripeFrameState {
  readonly cardCvc: StripeLocatorState;
  readonly cardExpiry: StripeLocatorState;
  readonly cardNumber: StripeLocatorState;
  readonly main: boolean;
  readonly origin: string;
  readonly payWithCard: StripeLocatorState;
}

interface LocatedStripeControl {
  readonly frame: Frame;
  readonly locator: Locator;
}

interface StripeCardMethodControl extends LocatedStripeControl {
  readonly activation: "click" | "dispatch";
}

interface StripeFrameBaseline {
  readonly addedFrames: Locator;
  readonly attributeName: string;
}

export interface StripeCheckoutState {
  readonly frames: readonly StripeFrameState[];
  readonly pageOrigin: string;
  readonly title: string;
}

const CARD_NUMBER_FIELD: StripeFieldDefinition = {
  label: /card number/i,
  name: "cardNumber",
  placeholder: /1234 1234 1234 1234/i,
};

const CARD_EXPIRY_FIELD: StripeFieldDefinition = {
  label: /expiration|expiry/i,
  name: "cardExpiry",
  placeholder: /MM\s*\/\s*YY/i,
};

const CARD_CVC_FIELD: StripeFieldDefinition = {
  label: /security code|cvc/i,
  name: "cardCvc",
  placeholder: /CVC/i,
};

let stripeFrameBaselineSequence = 0;

async function fillFirst(
  locator: Locator,
  value: string,
  timeout = 5_000,
): Promise<boolean> {
  try {
    await locator.first().fill(value, { timeout });
    return true;
  } catch (error: unknown) {
    if (error instanceof errors.TimeoutError) {
      return false;
    }
    throw error;
  }
}

function stripeFieldLocator(
  frame: Frame,
  field: StripeFieldDefinition,
): Locator {
  return frame
    .getByLabel(field.label)
    .or(frame.getByPlaceholder(field.placeholder))
    .or(frame.locator(`input[name="${field.name}"]`));
}

function visibleStripeFieldLocator(
  frame: Frame,
  field: StripeFieldDefinition,
): Locator {
  return stripeFieldLocator(frame, field).filter({ visible: true }).first();
}

function payWithCardLocator(frame: Frame): Locator {
  return frame.getByRole("button", { name: /pay with card/i });
}

function checkoutSubmitLocator(page: Page): Locator {
  return page.getByRole("button", { name: /^(subscribe|start trial)$/i });
}

function frameDetachedDuringDiscovery(page: Page, frame: Frame): boolean {
  return !page.isClosed() && frame.isDetached();
}

async function locatorCount(
  page: Page,
  frame: Frame,
  locator: Locator,
): Promise<number> {
  try {
    return await locator.count();
  } catch (error: unknown) {
    if (frameDetachedDuringDiscovery(page, frame)) {
      return 0;
    }
    throw error;
  }
}

async function findStripeFieldInFrames(
  page: Page,
  frames: readonly Frame[],
  field: StripeFieldDefinition,
  visibility: "attached" | "visible",
): Promise<LocatedStripeControl | null> {
  for (const frame of frames) {
    const locator =
      visibility === "visible"
        ? visibleStripeFieldLocator(frame, field)
        : stripeFieldLocator(frame, field).first();
    if ((await locatorCount(page, frame, locator)) === 0) {
      continue;
    }
    return { frame, locator };
  }
  return null;
}

async function findStripeField(
  page: Page,
  field: StripeFieldDefinition,
  visibility: "attached" | "visible",
): Promise<LocatedStripeControl | null> {
  return await findStripeFieldInFrames(page, page.frames(), field, visibility);
}

async function findPayWithCard(
  page: Page,
): Promise<StripeCardMethodControl | null> {
  for (const frame of page.frames()) {
    const locator = payWithCardLocator(frame).filter({ visible: true }).first();
    if ((await locatorCount(page, frame, locator)) > 0) {
      return { activation: "click", frame, locator };
    }
  }

  for (const frame of page.frames()) {
    const locator = payWithCardLocator(frame).first();
    if ((await locatorCount(page, frame, locator)) > 0) {
      return { activation: "dispatch", frame, locator };
    }
  }
  return null;
}

async function createStripeFrameBaseline(
  frame: Frame,
): Promise<StripeFrameBaseline> {
  stripeFrameBaselineSequence += 1;
  const attributeName =
    `data-okou-stripe-frame-baseline-${Date.now()}-` +
    stripeFrameBaselineSequence;
  await frame.locator("iframe").evaluateAll((elements, attribute) => {
    for (const element of elements) {
      element.setAttribute(attribute, "");
    }
  }, attributeName);
  return {
    addedFrames: frame.locator(`iframe:not([${attributeName}])`),
    attributeName,
  };
}

async function removeStripeFrameBaseline(
  frame: Frame,
  baseline: StripeFrameBaseline,
): Promise<void> {
  if (frame.isDetached()) {
    return;
  }
  try {
    await frame
      .locator(`iframe[${baseline.attributeName}]`)
      .evaluateAll((elements, attribute) => {
        for (const element of elements) {
          element.removeAttribute(attribute);
        }
      }, baseline.attributeName);
  } catch (error: unknown) {
    if (frame.isDetached()) {
      return;
    }
    throw error;
  }
}

async function activateCardMethod(
  control: StripeCardMethodControl,
  deadline: number,
): Promise<void> {
  const timeout = remainingTimeout(deadline);
  if (control.activation === "click") {
    await control.locator.click({ timeout });
    return;
  }

  // Stripe's accordion layout keeps the Card control attached with a
  // zero-height box. It cannot pass normal actionability checks, so this is
  // the only layout that uses synthetic activation.
  await control.locator.dispatchEvent("click", undefined, { timeout });
}

async function addedStripeFrames(
  baseline: StripeFrameBaseline,
): Promise<readonly Frame[]> {
  const handles = await baseline.addedFrames.elementHandles();
  const frames = await Promise.all(
    handles.map(async (handle) => await handle.contentFrame()),
  );
  return frames.filter((frame): frame is Frame => frame !== null);
}

async function fillAddedStripeFrame(
  page: Page,
  baseline: StripeFrameBaseline,
  value: string,
  deadline: number,
): Promise<LocatedStripeControl | null> {
  const frames = await addedStripeFrames(baseline);
  const locatedField =
    (await findStripeFieldInFrames(
      page,
      frames,
      CARD_NUMBER_FIELD,
      "visible",
    )) ??
    (await findStripeFieldInFrames(
      page,
      frames,
      CARD_NUMBER_FIELD,
      "attached",
    ));
  if (locatedField) {
    return (await fillLocatedStripeField(locatedField, value, deadline))
      ? locatedField
      : null;
  }

  if (frames.length !== 1) {
    return null;
  }
  const frame = frames[0];
  const candidate = {
    frame,
    locator: stripeFieldLocator(frame, CARD_NUMBER_FIELD).first(),
  };
  return (await fillLocatedStripeField(candidate, value, deadline))
    ? candidate
    : null;
}

async function fillRevealedCardNumber(
  page: Page,
  control: StripeCardMethodControl,
  baseline: StripeFrameBaseline,
  value: string,
  deadline: number,
): Promise<LocatedStripeControl> {
  const immediateCardNumber = await findStripeField(
    page,
    CARD_NUMBER_FIELD,
    "visible",
  );
  if (
    immediateCardNumber &&
    (await fillLocatedStripeField(immediateCardNumber, value, deadline))
  ) {
    return immediateCardNumber;
  }

  // Card activation has exactly two valid lifecycle outcomes: the semantic
  // field becomes visible in the control's frame, or Stripe replaces/adds a
  // child field frame. Wait once on that observable boundary.
  try {
    await visibleStripeFieldLocator(control.frame, CARD_NUMBER_FIELD)
      .or(baseline.addedFrames)
      .first()
      .waitFor({ state: "attached", timeout: remainingTimeout(deadline) });
  } catch (error: unknown) {
    if (error instanceof errors.TimeoutError) {
      throw await stripeFieldError(page, CARD_NUMBER_FIELD);
    }
    throw error;
  }

  const revealedCardNumber = await findStripeField(
    page,
    CARD_NUMBER_FIELD,
    "visible",
  );
  if (
    revealedCardNumber &&
    (await fillLocatedStripeField(revealedCardNumber, value, deadline))
  ) {
    return revealedCardNumber;
  }

  const addedFrameCardNumber = await fillAddedStripeFrame(
    page,
    baseline,
    value,
    deadline,
  );
  if (addedFrameCardNumber) {
    return addedFrameCardNumber;
  }
  throw await stripeFieldError(page, CARD_NUMBER_FIELD);
}

async function fillCardNumber(
  page: Page,
  value: string,
): Promise<LocatedStripeControl> {
  const deadline = Date.now() + FIELD_TIMEOUT_MS;
  const visibleCardNumber = await findStripeField(
    page,
    CARD_NUMBER_FIELD,
    "visible",
  );
  if (visibleCardNumber) {
    if (await fillLocatedStripeField(visibleCardNumber, value, deadline)) {
      return visibleCardNumber;
    }
    throw await stripeFieldError(page, CARD_NUMBER_FIELD);
  }

  const attachedCardNumber = await findStripeField(
    page,
    CARD_NUMBER_FIELD,
    "attached",
  );
  const payWithCard = await findPayWithCard(page);
  if (payWithCard) {
    const baseline = await createStripeFrameBaseline(payWithCard.frame);
    try {
      await activateCardMethod(payWithCard, deadline);
      if (attachedCardNumber) {
        const visibleAfterActivation = await findStripeField(
          page,
          CARD_NUMBER_FIELD,
          "visible",
        );
        if (
          visibleAfterActivation &&
          (await fillLocatedStripeField(
            visibleAfterActivation,
            value,
            deadline,
          ))
        ) {
          return visibleAfterActivation;
        }

        try {
          if (
            await fillLocatedStripeField(attachedCardNumber, value, deadline)
          ) {
            return attachedCardNumber;
          }
          throw await stripeFieldError(page, CARD_NUMBER_FIELD);
        } catch (error: unknown) {
          if (!attachedCardNumber.frame.isDetached()) {
            throw error;
          }
          // Stripe replaced the exact field frame during Card activation.
          // Transfer ownership to the newly attached descendant once; do not
          // replay activation or retry the detached locator.
          return await fillRevealedCardNumber(
            page,
            payWithCard,
            baseline,
            value,
            deadline,
          );
        }
      }
      return await fillRevealedCardNumber(
        page,
        payWithCard,
        baseline,
        value,
        deadline,
      );
    } finally {
      await removeStripeFrameBaseline(payWithCard.frame, baseline);
    }
  }

  if (
    attachedCardNumber &&
    (await fillLocatedStripeField(attachedCardNumber, value, deadline))
  ) {
    return attachedCardNumber;
  }
  throw await stripeFieldError(page, CARD_NUMBER_FIELD);
}

async function fillStripeField(
  page: Page,
  preferredFrame: Frame,
  field: StripeFieldDefinition,
  value: string,
): Promise<LocatedStripeControl> {
  const deadline = Date.now() + FIELD_TIMEOUT_MS;
  const preferredFrames = preferredFrame.isDetached() ? [] : [preferredFrame];
  const locatedField =
    (await findStripeFieldInFrames(page, preferredFrames, field, "visible")) ??
    (await findStripeFieldInFrames(page, preferredFrames, field, "attached")) ??
    (await findStripeField(page, field, "visible")) ??
    (await findStripeField(page, field, "attached"));
  if (
    locatedField &&
    (await fillLocatedStripeField(locatedField, value, deadline))
  ) {
    return locatedField;
  }
  throw await stripeFieldError(page, field);
}

async function fillLocatedStripeField(
  field: LocatedStripeControl,
  value: string,
  deadline: number,
): Promise<boolean> {
  return await fillFirst(field.locator, value, remainingTimeout(deadline));
}

async function waitForCheckoutFormReady(page: Page): Promise<void> {
  try {
    await checkoutSubmitLocator(page).waitFor({
      state: "visible",
      timeout: FIELD_TIMEOUT_MS,
    });
  } catch (error: unknown) {
    if (error instanceof errors.TimeoutError) {
      throw await stripeFieldError(page, CARD_NUMBER_FIELD);
    }
    throw error;
  }
}

function remainingTimeout(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

async function stripeFieldError(
  page: Page,
  field: StripeFieldDefinition,
): Promise<Error> {
  const state = await collectStripeCheckoutState(page).catch(() => null);
  return new Error(
    `Unable to fill Stripe field ${field.name}; state=${state ? JSON.stringify(state) : "unavailable"}`,
  );
}

async function locatorState(locator: Locator): Promise<StripeLocatorState> {
  const count = await locator.count();
  return {
    count,
    visible: count > 0 && (await locator.filter({ visible: true }).count()) > 0,
  };
}

function sanitizedOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "unavailable";
  }
}

export async function collectStripeCheckoutState(
  page: Page,
): Promise<StripeCheckoutState> {
  const mainFrame = page.mainFrame();
  const frames = await Promise.all(
    page.frames().map(async (frame): Promise<StripeFrameState> => {
      const [cardNumber, cardExpiry, cardCvc, payWithCard] = await Promise.all([
        locatorState(stripeFieldLocator(frame, CARD_NUMBER_FIELD)),
        locatorState(stripeFieldLocator(frame, CARD_EXPIRY_FIELD)),
        locatorState(stripeFieldLocator(frame, CARD_CVC_FIELD)),
        locatorState(payWithCardLocator(frame)),
      ]);
      return {
        cardCvc,
        cardExpiry,
        cardNumber,
        main: frame === mainFrame,
        origin: sanitizedOrigin(frame.url()),
        payWithCard,
      };
    }),
  );

  return {
    frames,
    pageOrigin: sanitizedOrigin(page.url()),
    title: await page.title(),
  };
}

async function disableLinkSaveInfo(page: Page): Promise<void> {
  const saveInfo = page.getByRole("checkbox", {
    name: /save my information/i,
  });

  if (await saveInfo.isVisible()) {
    await saveInfo.uncheck();
  }
}

export async function fillStripeCheckout(page: Page): Promise<void> {
  await expect(page).toHaveURL(/checkout\.stripe\.com/, { timeout: 30_000 });

  // Stripe can commit the hosted Checkout navigation while its form is still
  // a skeleton. Use the final purchase control as the single layout-neutral
  // readiness boundary before inspecting Card controls or field frames.
  await waitForCheckoutFormReady(page);

  const cardNumber = await fillCardNumber(page, "4242424242424242");
  const cardExpiry = await fillStripeField(
    page,
    cardNumber.frame,
    CARD_EXPIRY_FIELD,
    "1234",
  );
  await fillStripeField(page, cardExpiry.frame, CARD_CVC_FIELD, "123");
  await fillFirst(
    page
      .getByLabel(/cardholder name|name on card/i)
      .or(page.locator('input[name="billingName"]')),
    "Okou Billing E2E",
  );
  await fillFirst(
    page
      .getByLabel(/zip|postal/i)
      .or(page.locator('input[name="billingPostalCode"]')),
    "94107",
  );

  // Fill email after the other form actions and verify it before payment.
  const email = page
    .getByLabel(/email/i)
    .or(page.locator('input[name="email"]'))
    .filter({ visible: true })
    .first();
  const emailAddress = `billing-e2e-${Date.now()}@vm0-e2e.ai`;
  await email.fill(emailAddress, { timeout: 5_000 });
  await expect(email).toHaveValue(emailAddress);

  // Card/email changes can reveal or reselect Link and require a phone number.
  // Set the optional save choice on the final form before the single purchase.
  await disableLinkSaveInfo(page);
  await checkoutSubmitLocator(page).click({ timeout: 30_000 });
}
