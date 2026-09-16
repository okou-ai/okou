import { randomUUID } from "node:crypto";

import { apiFailureMessage } from "./api-response";
import { authHeadersForToken } from "./onboarding";

const RUNNER_API_ERROR_CODES = new Set([
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "CONFLICT",
  "TOO_MANY_REQUESTS",
  "INTERNAL_SERVER_ERROR",
  "PROVIDER_UNAVAILABLE",
  "BILLING_CHECKOUT_DIRECTORY_RATE_LIMITED",
]);
const ERROR_BODY_MAX_BYTES = 4096;
const ERROR_BODY_TIMEOUT_MS = 1000;

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
    result.restrictedBuiltInModels === false
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
    const errorCode = await readRunnerApiErrorCode(response);
    throw new Error(
      apiFailureMessage(
        path,
        response.status,
        requestId,
        response.headers.get("retry-after"),
      ) +
        "; error_code=" +
        errorCode,
    );
  }
  return await response.json();
}

async function readRunnerApiErrorCode(response: Response): Promise<string> {
  if (!response.body) {
    return "unavailable";
  }
  const reader = response.body.getReader();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    if (
      response.headers
        .get("content-type")
        ?.split(";")[0]
        .trim()
        .toLowerCase() !== "application/json"
    ) {
      return "unavailable";
    }
    return await Promise.race([
      readBoundedErrorCode(reader),
      new Promise<string>((resolve) => {
        timeout = setTimeout(
          () => resolve("unavailable"),
          ERROR_BODY_TIMEOUT_MS,
        );
      }),
    ]);
  } catch {
    // Diagnostics must retain the HTTP failure even when its body is unreadable.
    return "unavailable";
  } finally {
    clearTimeout(timeout);
    try {
      await reader.cancel();
    } catch {
      // A broken response stream must not replace the original HTTP failure.
    } finally {
      reader.releaseLock();
    }
  }
}

async function readBoundedErrorCode(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > ERROR_BODY_MAX_BYTES) {
      return "unavailable";
    }
    chunks.push(value);
  }
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
  if (
    isObject(body) &&
    isObject(body.error) &&
    typeof body.error.code === "string" &&
    RUNNER_API_ERROR_CODES.has(body.error.code)
  ) {
    return body.error.code;
  }
  return "unavailable";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
