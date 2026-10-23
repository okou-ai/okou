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

test.each([
  "/connectors/slack/callback",
  "/connectors/microsoft-365/callback",
  "/connectors/github/callback",
  "/api/integrations/slack/oauth/callback",
  "/api/integrations/teams/oauth/callback",
  "/api/github/app/setup/callback",
])(
  "redacts OAuth callback credentials before Sentry reporting (%s)",
  async (path) => {
    const sentry = context.mocks.sentry();
    initSentry();
    const options = sentry.initializations.at(-1)?.options;
    if (!options?.beforeSend || !options.beforeBreadcrumb) {
      throw new Error("Expected Sentry privacy hooks");
    }
    const query = "?code=private-code&state=private-state&integration=slack";
    const absolute = `https://app.okou.ai${path}${query}`;
    const event = await options.beforeSend(
      { type: undefined, request: { url: absolute } },
      {},
    );
    const breadcrumb = options.beforeBreadcrumb(
      {
        category: "navigation",
        data: { from: path + query, to: absolute, status_code: 200 },
      },
      {},
    );
    const signIn = new URL("https://app.okou.ai/sign-in");
    signIn.searchParams.set("redirect_url", absolute);
    const authEvent = await options.beforeSend(
      {
        type: undefined,
        request: {
          url: signIn.toString(),
          headers: { Referer: absolute, "User-Agent": "test-agent" },
        },
      },
      {},
    );
    for (const value of [event, breadcrumb, authEvent]) {
      expect(JSON.stringify(value)).not.toContain("private-code");
      expect(JSON.stringify(value)).not.toContain("private-state");
    }
    expect(breadcrumb?.data?.status_code).toBe(200);
    expect(authEvent?.request?.headers?.["User-Agent"]).toBe("test-agent");
  },
);

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
