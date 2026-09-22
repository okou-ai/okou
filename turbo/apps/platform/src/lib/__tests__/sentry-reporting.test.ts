import type { BrowserOptions, ErrorEvent } from "@sentry/browser";
import { expect, test } from "vitest";

import { testContext } from "../../signals/__tests__/test-helpers.ts";
import { SharedDatabaseHttpError } from "../../shared-database/http-error.ts";
import { SharedDatabaseWorkerLoadError } from "../../shared-database/worker-load-error.ts";
import {
  deserializeSharedDatabaseError,
  serializeSharedDatabaseError,
} from "../../shared-database/protocol.ts";
import { initSharedDatabaseWorkerSentry } from "../../shared-database/worker-sentry.ts";
import { ApiError } from "../api-error.ts";
import { captureSentryLogError } from "../sentry-config.ts";
import { initSentry } from "../sentry.ts";

const context = testContext();
const SAFARI_PERMISSION_MESSAGE =
  "The request is not allowed by the user agent or the platform in the current context, possibly because the user denied permission.";
const WEBKIT_MEDIA_MESSAGE =
  "this.mediaController.media.addEventListener is not a function";
const WEBAUTHN_SERVICE_MESSAGE =
  "NotSupportedError: Error connecting to Web Authentication service.";
const WEBKIT_FULLSCREEN_MESSAGE =
  "InvalidStateError: The object is in an invalid state.";

// Exercise the SDK hooks installed by the production page/worker entrypoints.
// The external Sentry mock records capture attempts; beforeSend owns delivery.
function startSentry(runtime: "page" | "shared-worker"): BrowserOptions {
  const sentry = context.mocks.sentry();
  if (runtime === "page") {
    initSentry();
  } else {
    initSharedDatabaseWorkerSentry();
  }
  const options = sentry.initializations.at(-1)?.options;
  if (!options?.beforeSend) {
    throw new Error("Expected the production Sentry delivery hook");
  }
  return options;
}

function deliver(
  options: BrowserOptions,
  event: ErrorEvent,
  hint: Parameters<NonNullable<BrowserOptions["beforeSend"]>>[1] = {},
): Promise<unknown> {
  const beforeSend = options.beforeSend;
  if (!beforeSend) {
    throw new Error("Expected the production Sentry delivery hook");
  }
  return Promise.resolve(beforeSend(event, hint));
}

// Noise suppression moved to Sentry inbound filters and discarded issues, which
// keep a per-reason `filtered` counter. A client-side rule would hide the same
// events inside an undifferentiated client discard instead.
test.each(["page", "shared-worker"] as const)(
  "declares no client-side noise filters in %s",
  (runtime) => {
    const options = startSentry(runtime);
    expect(options.ignoreErrors).toBeUndefined();
    expect(options.denyUrls).toBeUndefined();
  },
);

test.each(["page", "shared-worker"] as const)(
  "delivers previously suppressed captures in %s",
  async (runtime) => {
    const options = startSentry(runtime);
    const previouslySuppressed = [
      new SharedDatabaseWorkerLoadError(undefined),
      new Error("Connection to server unavailable"),
      new Error("Channel attach timed out"),
      new DOMException("Permission denied by system", "NotAllowedError"),
      new DOMException(SAFARI_PERMISSION_MESSAGE, "NotAllowedError"),
      new TypeError(WEBKIT_MEDIA_MESSAGE),
      new SharedDatabaseHttpError(401),
      new ApiError("Client update required", "CLIENT_UPGRADE_REQUIRED", 426),
    ];
    for (const error of previouslySuppressed) {
      const transferred = deserializeSharedDatabaseError(
        serializeSharedDatabaseError(error),
      );
      for (const captured of [error, transferred]) {
        captureSentryLogError("ExpectedFailure", ["Operation failed", captured]);
        const report = context.mocks.sentry().reports.at(-1);
        expect(report).toMatchObject({ type: "exception", error: captured });
        const event: ErrorEvent = {
          type: undefined,
          exception: {
            values: [{ type: captured.name, value: captured.message }],
          },
        };
        await expect(
          deliver(options, event, { originalException: captured }),
        ).resolves.toBe(event);
      }
    }
  },
);

test.each(["page", "shared-worker"] as const)(
  "delivers 4xx response captures in %s",
  async (runtime) => {
    const options = startSentry(runtime);
    for (const statusCode of [401, 404, 426]) {
      const event: ErrorEvent = {
        type: undefined,
        contexts: { response: { status_code: statusCode } },
      };
      await expect(deliver(options, event)).resolves.toBe(event);
    }
  },
);

// thirdPartyErrorFilterIntegration still tags page captures so Sentry-side
// triage can separate user-agent and extension frames, but it never drops one.
test.each(["page", "shared-worker"] as const)(
  "delivers tagged third-party and unhandled captures in %s",
  async (runtime) => {
    const options = startSentry(runtime);
    for (const value of [WEBKIT_FULLSCREEN_MESSAGE, WEBAUTHN_SERVICE_MESSAGE]) {
      const event: ErrorEvent = {
        type: undefined,
        exception: {
          values: [
            {
              type: "Error",
              value,
              mechanism: {
                handled: false,
                type: "auto.browser.global_handlers.onunhandledrejection",
              },
            },
          ],
        },
        tags: { third_party_code: true },
      };
      await expect(deliver(options, event)).resolves.toBe(event);
    }
  },
);

test.each(["page", "shared-worker"] as const)(
  "delivers unexpected failures in %s",
  async (runtime) => {
    const options = startSentry(runtime);
    for (const error of [
      new Error(
        "ChatThreadEvent cursor expired immediately after a server snapshot",
      ),
      new DOMException("Recorder failed", "NotReadableError"),
      new SharedDatabaseHttpError(500),
      new ApiError("Internal server error", "INTERNAL_SERVER_ERROR", 500),
    ]) {
      const event: ErrorEvent = {
        type: undefined,
        exception: { values: [{ type: error.name, value: error.message }] },
      };
      await expect(
        deliver(options, event, {
          originalException: new Error("Operation failed", { cause: error }),
        }),
      ).resolves.toBe(event);
    }
  },
);
