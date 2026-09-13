import { randomUUID } from "node:crypto";

import { apiFailureMessage } from "./api-response";
import { authHeadersForToken } from "./onboarding";

interface RunnerOnboardingOptions {
  readonly apiUrl: string;
  readonly clerkSessionToken: string;
  readonly vercelAutomationBypassSecret?: string;
}

export async function completeRunnerOnboarding(
  options: RunnerOnboardingOptions,
): Promise<void> {
  const result = await requestRunnerApi(
    options,
    "/api/onboarding/complete",
    {},
  );
  if (
    !isObject(result) ||
    result.onboardingComplete !== true ||
    result.needsOnboarding !== false
  ) {
    throw new Error("Runner onboarding did not return completed onboarding");
  }
}

export async function createRunnerCheckout(
  options: RunnerOnboardingOptions & {
    readonly appUrl: string;
    readonly memberId: string;
  },
): Promise<string> {
  const result = await requestRunnerApi(
    options,
    "/api/billing/usage-pack-checkout",
    {
      tier: "pro",
      memberUsagePacks: [{ memberId: options.memberId, usagePackUsd: 20 }],
      successUrl: new URL(
        "/?billing=pro&billing_session_id={CHECKOUT_SESSION_ID}",
        options.appUrl,
      ).toString(),
      cancelUrl: new URL("/", options.appUrl).toString(),
    },
  );
  if (!isObject(result) || typeof result.url !== "string") {
    throw new Error("Runner checkout did not return a checkout URL");
  }
  const url = new URL(result.url);
  if (url.origin !== "https://checkout.stripe.com") {
    throw new Error("Runner checkout did not return hosted Stripe Checkout");
  }
  return url.toString();
}

export async function readRunnerPaidEntitlement(
  options: RunnerOnboardingOptions,
): Promise<boolean> {
  const result = await requestRunnerApi(options, "/api/billing/status");
  if (!isObject(result) || typeof result.tier !== "string") {
    throw new Error("Runner billing status returned an invalid response");
  }
  return (
    result.tier === "pro" &&
    result.onboardingPaymentPending === false &&
    result.supportByok === true &&
    // Surface: new client -> old API. APIs from before #33658 step 1 send only
    // the retired brand alias. Remove once no such API is serving or retained
    // for rollback: step 2.
    (result.restrictedBuiltInModels ?? result.restrictedVm0Models) === false
  );
}

async function requestRunnerApi(
  options: RunnerOnboardingOptions,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const requestId = randomUUID();
  const response = await fetch(new URL(path, options.apiUrl), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...authHeadersForToken(
        options.clerkSessionToken,
        options.vercelAutomationBypassSecret,
      ),
      "Content-Type": "application/json",
      "x-client-request-id": requestId,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      apiFailureMessage(
        path,
        response.status,
        requestId,
        response.headers.get("retry-after"),
      ),
    );
  }
  return await response.json();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
