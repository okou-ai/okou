import type { Frame, Page, Request, Response } from "@playwright/test";

const MAX_REQUESTS = 32;
const MAX_MAIN_NAVIGATIONS = 8;
const MAX_CHILD_NAVIGATIONS = 24;

export type StripeInputName =
  | "email"
  | "cardNumber"
  | "cardExpiry"
  | "cardCvc"
  | "billingName"
  | "billingPostalCode"
  | "other";

interface StripeFormEvents {
  readonly invalidFields: StripeInputName[];
  submitEvents: number;
  emailInputEvents: number;
  emailChangeEvents: number;
  emailBlurEvents: number;
  submitPointerDownEvents: number;
  submitPointerUpEvents: number;
  submitClickEvents: number;
}

declare global {
  interface Window {
    __okouStripeFormEvents?: StripeFormEvents;
  }
}

interface StripeRequestObservation {
  readonly kind:
    "confirm" | "init" | "payment-method" | "payment-intent" | "other";
  readonly origin: string;
  readonly startedMs: number;
  status?: number;
  outcome: "pending" | "finished" | "failed";
}

export interface StripeCheckoutObservation {
  readonly requests: readonly StripeRequestObservation[];
  readonly omittedRequests: number;
  readonly navigations: readonly {
    readonly origin: string;
    readonly main: boolean;
    readonly elapsedMs: number;
  }[];
  readonly omittedNavigations: number;
}

/** Observe only metadata; never retain URLs, headers, bodies or error text. */
export async function observeStripeCheckout(page: Page) {
  await page.addInitScript(() => {
    if (
      !["https://checkout.stripe.com", "https://js.stripe.com"].includes(
        location.origin,
      )
    )
      return;
    const events: StripeFormEvents = {
      invalidFields: [],
      submitEvents: 0,
      emailInputEvents: 0,
      emailChangeEvents: 0,
      emailBlurEvents: 0,
      submitPointerDownEvents: 0,
      submitPointerUpEvents: 0,
      submitClickEvents: 0,
    };
    window.__okouStripeFormEvents = events;
    document.addEventListener("submit", () => events.submitEvents++, true);
    document.addEventListener(
      "invalid",
      (event) => {
        if (events.invalidFields.length >= 16) return;
        const input = event.target;
        const name = input instanceof HTMLInputElement ? input.name : "";
        events.invalidFields.push(
          name === "email" ||
            name === "cardNumber" ||
            name === "cardExpiry" ||
            name === "cardCvc" ||
            name === "billingName" ||
            name === "billingPostalCode"
            ? name
            : "other",
        );
      },
      true,
    );
    for (const type of ["input", "change", "blur"] as const) {
      document.addEventListener(
        type,
        (event) => {
          if (
            !(event.target instanceof HTMLInputElement) ||
            (event.target.type !== "email" && event.target.name !== "email")
          )
            return;
          if (type === "input") events.emailInputEvents++;
          if (type === "change") events.emailChangeEvents++;
          if (type === "blur") events.emailBlurEvents++;
        },
        true,
      );
    }
    for (const type of ["pointerdown", "pointerup", "click"] as const) {
      document.addEventListener(
        type,
        (event) => {
          const button =
            event.target instanceof Element
              ? event.target.closest("button")
              : null;
          if (
            !button ||
            !/^(subscribe|start trial)$/iu.test(
              button.textContent?.trim() ?? "",
            )
          )
            return;
          if (type === "pointerdown") events.submitPointerDownEvents++;
          if (type === "pointerup") events.submitPointerUpEvents++;
          if (type === "click") events.submitClickEvents++;
        },
        true,
      );
    }
  });

  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const requests = new Map<Request, StripeRequestObservation>();
  const navigations: StripeCheckoutObservation["navigations"][number][] = [];
  let omittedRequests = 0;
  let omittedNavigations = 0;
  const onRequest = (request: Request) => {
    const url = new URL(request.url());
    if (
      request.method() !== "POST" ||
      !["https://api.stripe.com", "https://checkout.stripe.com"].includes(
        url.origin,
      )
    )
      return;
    if (requests.size >= MAX_REQUESTS) {
      omittedRequests++;
      return;
    }
    requests.set(request, {
      kind: /\/confirm$/u.test(url.pathname)
        ? "confirm"
        : /\/init$/u.test(url.pathname)
          ? "init"
          : /\/payment_methods$/u.test(url.pathname)
            ? "payment-method"
            : /\/(payment_intents|setup_intents)\//u.test(url.pathname)
              ? "payment-intent"
              : "other",
      origin: url.origin,
      startedMs: elapsed(),
      outcome: "pending",
    });
  };
  const onResponse = (response: Response) => {
    const observation = requests.get(response.request());
    if (observation) observation.status = response.status();
  };
  const onFinished = (request: Request) => {
    const observation = requests.get(request);
    if (observation) observation.outcome = "finished";
  };
  const onFailed = (request: Request) => {
    const observation = requests.get(request);
    if (observation) observation.outcome = "failed";
  };
  const onNavigated = (frame: Frame) => {
    const main = frame === page.mainFrame();
    const count = navigations.filter(
      (navigation) => navigation.main === main,
    ).length;
    if (count >= (main ? MAX_MAIN_NAVIGATIONS : MAX_CHILD_NAVIGATIONS)) {
      omittedNavigations++;
      return;
    }
    navigations.push({
      origin: new URL(frame.url()).origin,
      main,
      elapsedMs: elapsed(),
    });
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfinished", onFinished);
  page.on("requestfailed", onFailed);
  page.on("framenavigated", onNavigated);
  return {
    snapshot: (): StripeCheckoutObservation => ({
      requests: [...requests.values()].map((request) => ({ ...request })),
      omittedRequests,
      navigations: [...navigations],
      omittedNavigations,
    }),
    dispose: () => {
      page.off("request", onRequest);
      page.off("response", onResponse);
      page.off("requestfinished", onFinished);
      page.off("requestfailed", onFailed);
      page.off("framenavigated", onNavigated);
    },
  };
}
