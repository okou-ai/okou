import { expect, test } from "vitest";

import { testContext } from "../../signals/__tests__/test-helpers.ts";
import { SharedDatabaseHttpError } from "../../shared-database/http-error.ts";
import { SharedDatabaseWorkerLoadError } from "../../shared-database/worker-load-error.ts";
import {
  deserializeSharedDatabaseError,
  serializeSharedDatabaseError,
} from "../../shared-database/protocol.ts";
import { ApiError } from "../api-error.ts";
import { captureSentryLogError } from "../sentry-config.ts";
import { initSentry } from "../sentry.ts";

const context = testContext();

// Routing an error through the logger bridge is the only client-side decision
// left: whether a logged argument reports as an exception and which object it
// carries. Errors that crossed a MessagePort arrive as reconstructed copies, so
// they have to survive the same routing.
test("captures logged errors as exceptions after a shared database transfer", () => {
  const sentry = context.mocks.sentry();
  initSentry();
  for (const error of [
    new SharedDatabaseWorkerLoadError(new Error("Worker script failed")),
    new SharedDatabaseHttpError(500),
    new ApiError("Internal server error", "INTERNAL_SERVER_ERROR", 500),
    new DOMException("Recorder failed", "NotReadableError"),
  ]) {
    const transferred = deserializeSharedDatabaseError(
      serializeSharedDatabaseError(error),
    );
    for (const captured of [error, transferred]) {
      captureSentryLogError("ExpectedFailure", ["Operation failed", captured]);
      expect(sentry.reports.at(-1)).toMatchObject({
        type: "exception",
        error: captured,
      });
    }
  }
});
