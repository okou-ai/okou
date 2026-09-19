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
const WEBKIT_SAFARI_MESSAGE = `${WEBKIT_MEDIA_MESSAGE}. (In 'this.mediaController.media.addEventListener(eventType,this,true)', 'this.mediaController.media.addEventListener' is undefined)`;

// Exercise the SDK hooks installed by the production page/worker entrypoints.
// The external Sentry mock records capture attempts; beforeSend owns delivery.
function startSentry(
  runtime: "page" | "shared-worker",
): NonNullable<BrowserOptions["beforeSend"]> {
  const sentry = context.mocks.sentry();
  if (runtime === "page") {
    initSentry();
  } else {
    initSharedDatabaseWorkerSentry();
  }
  const beforeSend = sentry.initializations.at(-1)?.options?.beforeSend;
  if (!beforeSend) {
    throw new Error("Expected the production Sentry delivery hook");
  }
  return beforeSend;
}

test.each(["page", "shared-worker"] as const)(
  "filters expected raw and wrapped captures in %s",
  async (runtime) => {
    const beforeSend = startSentry(runtime);
    const expected = [
      new SharedDatabaseWorkerLoadError(undefined),
      new SharedDatabaseWorkerLoadError(new Error("Worker script failed")),
      new Error("Connection to server unavailable"),
      new Error("Channel attach timed out"),
      new DOMException("Permission denied by system", "NotAllowedError"),
      new DOMException(SAFARI_PERMISSION_MESSAGE, "NotAllowedError"),
      new Error("NotAllowedError: Permission denied by system"),
      new TypeError(WEBKIT_MEDIA_MESSAGE),
      new TypeError(WEBKIT_SAFARI_MESSAGE),
      new SharedDatabaseHttpError(401),
      new SharedDatabaseHttpError(426),
      new ApiError("Unauthorized", "UNAUTHORIZED", 401),
      new ApiError("Client update required", "CLIENT_UPGRADE_REQUIRED", 426),
    ];
    for (const error of expected) {
      const transferred = deserializeSharedDatabaseError(
        serializeSharedDatabaseError(error),
      );
      for (const captured of [
        error,
        transferred,
        new Error("Voice draft recording failed", {
          cause: new Error("Operation failed", { cause: transferred }),
        }),
      ]) {
        captureSentryLogError("ExpectedFailure", [
          "Operation failed",
          captured,
        ]);
        const report = context.mocks.sentry().reports.at(-1);
        expect(report).toMatchObject({ type: "exception", error: captured });
        const event: ErrorEvent = {
          type: undefined,
          exception: { values: [{ type: "Error", value: "Operation failed" }] },
        };
        await expect(
          Promise.resolve(beforeSend(event, { originalException: captured })),
        ).resolves.toBeNull();
      }
    }
  },
);

test.each(["page", "shared-worker"] as const)(
  "filters native and linked exceptions without an original object in %s",
  async (runtime) => {
    const beforeSend = startSentry(runtime);
    for (const exception of [
      {
        type: "SharedDatabaseWorkerLoadError",
        value: "Shared database worker failed to load",
      },
      { type: "Error", value: "Connection to server unavailable" },
      { type: "Error", value: "Channel attach timed out" },
      { type: "NotAllowedError", value: SAFARI_PERMISSION_MESSAGE },
      { type: "Error", value: "NotAllowedError: Permission denied by system" },
      { type: "TypeError", value: WEBKIT_MEDIA_MESSAGE },
      { type: "TypeError", value: WEBKIT_SAFARI_MESSAGE },
    ]) {
      const event: ErrorEvent = {
        type: undefined,
        exception: {
          values: [
            exception,
            { type: "Error", value: "Voice draft recording failed" },
          ],
        },
      };
      await expect(Promise.resolve(beforeSend(event, {}))).resolves.toBeNull();
    }
  },
);

test.each(["page", "shared-worker"] as const)(
  "preserves unexpected failures in %s",
  async (runtime) => {
    const beforeSend = startSentry(runtime);
    for (const error of [
      new Error("Shared database worker failed to load"),
      new Error(
        "ChatThreadEvent cursor expired immediately after a server snapshot",
      ),
      new Error("Voice draft recording failed", {
        cause: new Error("Storage write failed"),
      }),
      new DOMException("Recorder failed", "NotReadableError"),
      new Error("Transcription failed"),
      new Error("Ably subscription callback failed"),
      new Error("Channel attach timed out while running application code"),
      new TypeError("audio.addEventListener is not a function"),
      new Error("Unexpected Chat Event schema version null"),
      new SharedDatabaseHttpError(500),
      new ApiError("Internal server error", "INTERNAL_SERVER_ERROR", 500),
      deserializeSharedDatabaseError(
        serializeSharedDatabaseError(
          new ApiError("Internal server error", "INTERNAL_SERVER_ERROR", 500),
        ),
      ),
      deserializeSharedDatabaseError(
        serializeSharedDatabaseError(new SharedDatabaseHttpError(500)),
      ),
    ]) {
      const event: ErrorEvent = {
        type: undefined,
        exception: { values: [{ type: error.name, value: error.message }] },
      };
      await expect(
        Promise.resolve(
          beforeSend(event, {
            originalException: new Error("Operation failed", { cause: error }),
          }),
        ),
      ).resolves.toBe(event);
      await expect(Promise.resolve(beforeSend(event, {}))).resolves.toBe(event);
    }
    const event: ErrorEvent = {
      type: undefined,
      contexts: { response: { status_code: 500 } },
    };
    await expect(Promise.resolve(beforeSend(event, {}))).resolves.toBe(event);
    await expect(
      Promise.resolve(
        beforeSend(
          { type: undefined, contexts: { response: { status_code: 401 } } },
          {},
        ),
      ),
    ).resolves.toBeNull();
    await expect(
      Promise.resolve(
        beforeSend(
          { type: undefined, contexts: { response: { status_code: 426 } } },
          {},
        ),
      ),
    ).resolves.toBeNull();
  },
);

const WEBAUTHN_SERVICE_MESSAGE =
  "NotSupportedError: Error connecting to Web Authentication service.";
const WEBAUTHN_UNSUPPORTED_MESSAGE =
  "NotSupportedError: The user agent does not support public key credentials.";

function unhandledRejectionEvent(
  value: string,
  overrides: {
    readonly handled?: boolean;
    readonly mechanismType?: string;
  } = {},
): ErrorEvent {
  return {
    type: undefined,
    exception: {
      values: [
        {
          type: "Error",
          value,
          mechanism: {
            handled: overrides.handled ?? false,
            type:
              overrides.mechanismType ??
              "auto.browser.global_handlers.onunhandledrejection",
          },
        },
      ],
    },
  };
}

test("discards known Clerk WebAuthn rejections on the page", async () => {
  const beforeSend = startSentry("page");
  for (const message of [
    WEBAUTHN_SERVICE_MESSAGE,
    WEBAUTHN_UNSUPPORTED_MESSAGE,
  ]) {
    await expect(
      Promise.resolve(beforeSend(unhandledRejectionEvent(message), {})),
    ).resolves.toBeNull();
  }
});

test("reports neighboring WebAuthn failures on the page", async () => {
  const beforeSend = startSentry("page");
  for (const event of [
    unhandledRejectionEvent(
      "NotSupportedError: Web Authentication service failed unexpectedly.",
    ),
    unhandledRejectionEvent(WEBAUTHN_SERVICE_MESSAGE, {
      handled: true,
      mechanismType: "generic",
    }),
    unhandledRejectionEvent(WEBAUTHN_SERVICE_MESSAGE, {
      mechanismType: "auto.browser.global_handlers.onerror",
    }),
  ]) {
    await expect(Promise.resolve(beforeSend(event, {}))).resolves.toBe(event);
  }
});

test("reports known WebAuthn messages in the shared worker", async () => {
  const beforeSend = startSentry("shared-worker");
  const event = unhandledRejectionEvent(WEBAUTHN_SERVICE_MESSAGE);
  await expect(Promise.resolve(beforeSend(event, {}))).resolves.toBe(event);
});

// WebKit's own <video> controls script escapes to window.onerror with no
// application frame, so thirdPartyErrorFilterIntegration tags it before
// delivery. Only that exact combination may be discarded.
function userAgentEvent(
  value: string,
  overrides: {
    readonly handled?: boolean;
    readonly mechanismType?: string;
    readonly thirdPartyCode?: boolean;
  } = {},
): ErrorEvent {
  return {
    type: undefined,
    exception: {
      values: [
        {
          type: "Error",
          value,
          mechanism: {
            handled: overrides.handled ?? false,
            type:
              overrides.mechanismType ?? "auto.browser.global_handlers.onerror",
          },
        },
      ],
    },
    tags: (overrides.thirdPartyCode ?? true) ? { third_party_code: true } : {},
  };
}

const WEBKIT_FULLSCREEN_MESSAGE =
  "InvalidStateError: The object is in an invalid state.";
const WEBKIT_MEDIA_RANGES_MESSAGE = "Can't find variable: EmptyRanges";

test("discards tagged webkit media-controls captures on the page", async () => {
  const beforeSend = startSentry("page");
  for (const message of [
    WEBKIT_FULLSCREEN_MESSAGE,
    "The object is in an invalid state.",
    WEBKIT_MEDIA_RANGES_MESSAGE,
    `ReferenceError: ${WEBKIT_MEDIA_RANGES_MESSAGE}`,
  ]) {
    await expect(
      Promise.resolve(beforeSend(userAgentEvent(message), {})),
    ).resolves.toBeNull();
  }
});

test("reports the same messages when they carry an application frame", async () => {
  const beforeSend = startSentry("page");
  for (const message of [
    WEBKIT_FULLSCREEN_MESSAGE,
    WEBKIT_MEDIA_RANGES_MESSAGE,
  ]) {
    const event = userAgentEvent(message, { thirdPartyCode: false });
    await expect(Promise.resolve(beforeSend(event, {}))).resolves.toBe(event);
  }
});

test("reports webkit media-controls messages our own code captures", async () => {
  const beforeSend = startSentry("page");
  const handled = userAgentEvent(WEBKIT_FULLSCREEN_MESSAGE, {
    handled: true,
    mechanismType: "generic",
  });
  await expect(Promise.resolve(beforeSend(handled, {}))).resolves.toBe(handled);
});

test("reports neighbouring third-party and storage failures", async () => {
  const beforeSend = startSentry("page");
  for (const message of [
    // The recovered IndexedDB failure shares the InvalidStateError name.
    "InvalidStateError: Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.",
    // An unrelated third-party capture must not be suppressed as a class.
    "Can't find variable: somethingElse",
  ]) {
    const event = userAgentEvent(message);
    await expect(Promise.resolve(beforeSend(event, {}))).resolves.toBe(event);
  }
});

test("reports tagged media-controls captures in the shared worker", async () => {
  const beforeSend = startSentry("shared-worker");
  const event = userAgentEvent(WEBKIT_FULLSCREEN_MESSAGE);
  await expect(Promise.resolve(beforeSend(event, {}))).resolves.toBe(event);
});
