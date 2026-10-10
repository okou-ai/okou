import { randomBytes } from "node:crypto";
import { expect, test, onTestFinished, vi } from "vitest";
import {
  filterDiscordOauthSentryBreadcrumb,
  filterDiscordOauthSentryEvent,
} from "../discord-oauth-telemetry";

test.each(["start", "callback", "approve", "complete"])(
  "filters real Sentry SDK %s request/breadcrumb secrets before transport without dropping unrelated events",
  async (endpoint) => {
    // Same real-SDK loading pattern as instrument-export.test.ts. Leave the
    // central external-module stub untouched; inspect actual transport output.
    const { init, addBreadcrumb, captureEvent, close, flush } =
      await vi.importActual<typeof import("@sentry/node")>("@sentry/node");
    const received: string[] = [];
    const events: string[] = [];
    init({
      dsn: "https://public@telemetry.invalid/1",
      defaultIntegrations: false,
      // Match production's external OTel ownership; do not install a global
      // Sentry tracer provider while testing its event transport boundary.
      skipOpenTelemetrySetup: true,
      tracesSampleRate: 0,
      sendDefaultPii: false,
      beforeSend: filterDiscordOauthSentryEvent,
      beforeBreadcrumb: filterDiscordOauthSentryBreadcrumb,
      transport: () => {
        return {
          send: (envelope) => {
            received.push(JSON.stringify(envelope));
            for (const [header, payload] of envelope[1]) {
              if (header.type === "event") {
                events.push(JSON.stringify(payload));
              }
            }
            return Promise.resolve({ statusCode: 200 });
          },
          flush: () => {
            return Promise.resolve(true);
          },
        };
      },
    });
    onTestFinished(async () => {
      await close(1000);
    });
    const code = randomBytes(32).toString("base64url");
    const state = randomBytes(32).toString("base64url");
    const proof = randomBytes(32).toString("base64url");
    const callback = `https://api.okou.ai/api/integrations/discord/oauth/${endpoint}?code=${code}&state=${state}`;
    const location = `https://app.okou.ai/works?discord=pending#discord_oauth=approve&state=${state}&approval_proof=${proof}`;
    addBreadcrumb({ category: "http", data: { url: callback } });
    addBreadcrumb({ category: "http", data: { url: location } });
    captureEvent({
      message: "Sensitive OAuth request",
      request: {
        url: callback,
        query_string: `code=${code}&state=${state}`,
        headers: { location },
        data: { approvalProof: proof, completionToken: proof },
      },
    });
    addBreadcrumb({
      category: "http",
      data: { url: "https://api.okou.ai/health" },
    });
    captureEvent({
      message: "Unrelated diagnostic",
      request: { url: "https://api.okou.ai/health" },
    });
    await flush(1000);
    expect(events).toHaveLength(1);
    expect(
      received.some((envelope) => {
        return envelope.includes("Unrelated diagnostic");
      }),
    ).toBeTruthy();
    expect(
      received.some((envelope) => {
        return envelope.includes("api.okou.ai/health");
      }),
    ).toBeTruthy();
    const leaked = received.some((envelope) => {
      return [code, state, proof, callback, location].some((secret) => {
        return envelope.includes(secret);
      });
    });
    expect(leaked).toBeFalsy();
  },
);
