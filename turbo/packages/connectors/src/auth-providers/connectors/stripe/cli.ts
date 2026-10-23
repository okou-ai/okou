import * as z from "zod";

import type { ConnectorDeviceAuthStartOptions } from "@okouai/connectors/connector-config";
import type {
  OAuthDeviceAuthPollResult,
  OAuthDeviceAuthStartResult,
} from "../../provider-flow-types";

const STRIPE_DASHBOARD_ORIGIN = "https://dashboard.stripe.com";
const STRIPE_CLI_AUTH_PATH = "/stripecli/auth";
const STRIPE_CLI_CONFIRM_AUTH_PATH = "/stripecli/confirm_auth";
const STRIPE_CLI_CLIENT_VERSION = "1.42.1";
const STRIPE_CLI_DEVICE_NAME = "vm0-stripe-connector";
const STRIPE_CLI_AUTH_START_EXPIRES_IN_SECONDS = 10 * 60;
const STRIPE_CLI_AUTH_POLL_INTERVAL_SECONDS = 1;
const STRIPE_CLI_KEY_EXPIRES_IN_SECONDS = 90 * 24 * 60 * 60;
const STRIPE_CLI_AUTH_RESPONSE_MAX_BYTES = 16 * 1024;
const STRIPE_CLI_DEVICE_CODE = "stripe-cli-dashboard-auth";

const stripeCliModeSchema = z.enum(["test", "live"]);

const stripeCliStartResponseSchema = z.object({
  browser_url: z.string().min(1),
  poll_url: z.string().min(1),
  verification_code: z.string().min(1),
});

const stripeCliPollResponseSchema = z.object({
  redeemed: z.boolean(),
  account_id: z.string().nullish(),
  account_display_name: z.string().nullish(),
  livemode_key_secret: z.string().nullish(),
  livemode_key_publishable: z.string().nullish(),
  testmode_key_secret: z.string().nullish(),
  testmode_key_publishable: z.string().nullish(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

const stripeCliPollStateSchema = z.object({
  version: z.literal(1),
  mode: stripeCliModeSchema,
  pollUrl: z.string().min(1),
});

type StripeCliMode = z.infer<typeof stripeCliModeSchema>;

type StripeCliPollState = z.infer<typeof stripeCliPollStateSchema>;

type StripeCliPollResponse = z.infer<typeof stripeCliPollResponseSchema>;

function redactStripeCliDashboardAuthText(value: string): string {
  return value
    .replace(
      /https:\/\/dashboard\.stripe\.com\/stripecli\/[^\s"'<>)]*/gu,
      "https://dashboard.stripe.com/stripecli/[redacted]",
    )
    .replace(/\b(?:sk|rk)_(?:test|live)_[^\s"'<>),]+/gu, "[stripe-key]");
}

async function readBoundedResponseText(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const parsedContentLength = Number.parseInt(contentLength, 10);
    if (
      Number.isFinite(parsedContentLength) &&
      parsedContentLength > STRIPE_CLI_AUTH_RESPONSE_MAX_BYTES
    ) {
      throw new Error("Stripe CLI auth response exceeded the size limit");
    }
  }

  if (!response.body) {
    const text = await response.text();
    if (
      new TextEncoder().encode(text).byteLength >
      STRIPE_CLI_AUTH_RESPONSE_MAX_BYTES
    ) {
      throw new Error("Stripe CLI auth response exceeded the size limit");
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }
    receivedBytes += value.byteLength;
    if (receivedBytes > STRIPE_CLI_AUTH_RESPONSE_MAX_BYTES) {
      await reader.cancel();
      throw new Error("Stripe CLI auth response exceeded the size limit");
    }
    chunks.push(value);
  }

  const body = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

async function readStripeJsonResponse(response: Response): Promise<unknown> {
  const text = await readBoundedResponseText(response);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    const redactedText = redactStripeCliDashboardAuthText(text).slice(0, 500);
    const suffix = redactedText ? `: ${redactedText}` : "";
    throw new Error(`Stripe CLI auth response was not valid JSON${suffix}`);
  }
}

function validatedStripeDashboardUrl(
  value: string,
  expectedPath: "auth" | "confirm_auth",
  label: string,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Stripe CLI auth returned an invalid ${label} URL`);
  }

  const pathPrefix =
    expectedPath === "auth"
      ? STRIPE_CLI_AUTH_PATH
      : STRIPE_CLI_CONFIRM_AUTH_PATH;
  const hasExpectedPath =
    url.pathname === pathPrefix || url.pathname.startsWith(`${pathPrefix}/`);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "dashboard.stripe.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    !hasExpectedPath
  ) {
    throw new Error(`Stripe CLI auth returned an unexpected ${label} URL`);
  }

  return url.toString();
}

function parseStartMode(
  options: ConnectorDeviceAuthStartOptions,
): StripeCliMode {
  return stripeCliModeSchema.parse(options.mode);
}

function stripeCliPollStateString(state: StripeCliPollState): string {
  return JSON.stringify(state);
}

function stripeCliPollState(
  pollState: string | undefined,
): StripeCliPollState | null {
  if (pollState === undefined) {
    return null;
  }

  let json: unknown;
  try {
    json = JSON.parse(pollState) as unknown;
  } catch {
    return null;
  }

  const parsedState = stripeCliPollStateSchema.safeParse(json);
  return parsedState.success ? parsedState.data : null;
}

function selectedStripeCliKey(args: {
  readonly mode: StripeCliMode;
  readonly testKey: string | null | undefined;
  readonly liveKey: string | null | undefined;
}): string | null {
  return args.mode === "test" ? (args.testKey ?? null) : (args.liveKey ?? null);
}

function stripeCliKeyMatchesMode(key: string, mode: StripeCliMode): boolean {
  switch (mode) {
    case "test":
      return /^(?:sk|rk)_test_[A-Za-z0-9]+$/u.test(key);
    case "live":
      return /^(?:sk|rk)_live_[A-Za-z0-9]+$/u.test(key);
  }
}

function stripeCliProviderError(
  message: string,
): OAuthDeviceAuthPollResult<"stripe", "cli"> {
  return {
    status: "error",
    error: "stripe_cli_auth_error",
    errorDescription: redactStripeCliDashboardAuthText(message),
  };
}

function stripeCliProviderErrorFromUnknown(
  error: unknown,
  fallbackMessage: string,
): OAuthDeviceAuthPollResult<"stripe", "cli"> {
  return stripeCliProviderError(
    error instanceof Error ? error.message : fallbackMessage,
  );
}

async function stripeCliHttpErrorMessage(
  phase: "start" | "poll",
  response: Response,
): Promise<string> {
  const body = await readBoundedResponseText(response);
  const redactedBody = redactStripeCliDashboardAuthText(body).slice(0, 500);
  const suffix = redactedBody ? `: ${redactedBody}` : "";
  return `Stripe CLI auth ${phase} failed with HTTP ${response.status}${suffix}`;
}

async function readStripeCliPollResponse(
  response: Response,
): Promise<StripeCliPollResponse | OAuthDeviceAuthPollResult<"stripe", "cli">> {
  try {
    return stripeCliPollResponseSchema.parse(
      await readStripeJsonResponse(response),
    );
  } catch (error) {
    return stripeCliProviderError(
      error instanceof Error
        ? error.message
        : "Stripe CLI auth response was invalid",
    );
  }
}

export async function startStripeCliDashboardAuth(args: {
  readonly options: ConnectorDeviceAuthStartOptions;
}): Promise<OAuthDeviceAuthStartResult> {
  const mode = parseStartMode(args.options);
  const response = await fetch(
    `${STRIPE_DASHBOARD_ORIGIN}${STRIPE_CLI_AUTH_PATH}`,
    {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_version: STRIPE_CLI_CLIENT_VERSION,
        device_name: STRIPE_CLI_DEVICE_NAME,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(await stripeCliHttpErrorMessage("start", response));
  }

  const data = stripeCliStartResponseSchema.parse(
    await readStripeJsonResponse(response),
  );
  const browserUrl = validatedStripeDashboardUrl(
    data.browser_url,
    "confirm_auth",
    "browser",
  );
  const pollUrl = validatedStripeDashboardUrl(data.poll_url, "auth", "poll");

  return {
    deviceCode: STRIPE_CLI_DEVICE_CODE,
    pollState: stripeCliPollStateString({
      version: 1,
      mode,
      pollUrl,
    }),
    userCode: data.verification_code,
    verificationUri: browserUrl,
    verificationUriComplete: browserUrl,
    expiresIn: STRIPE_CLI_AUTH_START_EXPIRES_IN_SECONDS,
    interval: STRIPE_CLI_AUTH_POLL_INTERVAL_SECONDS,
  };
}

export async function pollStripeCliDashboardAuth(args: {
  readonly pollState: string | undefined;
}): Promise<OAuthDeviceAuthPollResult<"stripe", "cli">> {
  const providerState = stripeCliPollState(args.pollState);
  if (!providerState) {
    return stripeCliProviderError(
      "Stripe CLI auth session is invalid. Start again to retry.",
    );
  }

  let pollUrl: string;
  try {
    pollUrl = validatedStripeDashboardUrl(
      providerState.pollUrl,
      "auth",
      "poll",
    );
  } catch (error) {
    return stripeCliProviderErrorFromUnknown(
      error,
      "Stripe CLI auth session is invalid. Start again to retry.",
    );
  }

  let response: Response;
  try {
    response = await fetch(pollUrl, {
      method: "GET",
      redirect: "error",
    });
  } catch (error) {
    return stripeCliProviderErrorFromUnknown(
      error,
      "Stripe CLI auth poll failed",
    );
  }

  if (!response.ok) {
    try {
      return stripeCliProviderError(
        await stripeCliHttpErrorMessage("poll", response),
      );
    } catch (error) {
      return stripeCliProviderErrorFromUnknown(
        error,
        "Stripe CLI auth poll failed",
      );
    }
  }

  const data = await readStripeCliPollResponse(response);
  if ("status" in data) {
    return data;
  }

  if (data.error) {
    return stripeCliProviderError(data.error_description ?? data.error);
  }
  if (!data.redeemed) {
    return {
      status: "pending",
      interval: STRIPE_CLI_AUTH_POLL_INTERVAL_SECONDS,
    };
  }

  const token = selectedStripeCliKey({
    mode: providerState.mode,
    testKey: data.testmode_key_secret,
    liveKey: data.livemode_key_secret,
  });
  if (!token) {
    return stripeCliProviderError(
      `Stripe CLI auth did not return a ${providerState.mode} mode key`,
    );
  }
  if (!stripeCliKeyMatchesMode(token, providerState.mode)) {
    return stripeCliProviderError(
      `Stripe CLI auth returned an invalid ${providerState.mode} mode key`,
    );
  }

  const accountId = data.account_id ?? "stripe";
  const displayName = data.account_display_name ?? accountId;

  return {
    status: "complete",
    token: {
      outputs: { token },
      expiresIn: STRIPE_CLI_KEY_EXPIRES_IN_SECONDS,
      scopes: [],
      userInfo: {
        id: accountId,
        username: displayName,
        email: null,
      },
    },
  };
}
