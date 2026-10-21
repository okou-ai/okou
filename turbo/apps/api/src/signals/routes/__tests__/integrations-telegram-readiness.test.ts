import { randomUUID } from "node:crypto";
import { CLIENT_REQUEST_ID_HEADER } from "@okouai/api-contracts/contracts/client-headers";
import {
  integrationsTelegramContract,
  OFFICIAL_TELEGRAM_BOT_ID,
} from "@okouai/api-contracts/contracts/integrations-telegram";
import { http, HttpResponse } from "msw";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { integrationsTelegramRoutes } from "../integrations-telegram";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const BOT_TOKEN = "9876543210:test-bot-secret";
const APP_ORIGIN = "https://app.example.com";
const REQUEST_ID = "51326918-3b76-4fea-a42f-d8f58e426d9b";
const OAUTH_URL = "https://oauth.telegram.org/auth";

beforeEach(() => {
  mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
  mockEnv("APP_URL", APP_ORIGIN);
  mockEnv("TELEGRAM_OFFICIAL_BOT_TOKEN", BOT_TOKEN);
  mockEnv("TELEGRAM_OFFICIAL_BOT_USERNAME", "test_okou_bot");
  mockEnv("TELEGRAM_OFFICIAL_WEBHOOK_SECRET", "test-webhook-secret");
  mockEnv("AXIOM_TOKEN_TELEMETRY", "test-telemetry-token");
});

async function linkStatus(source?: "onboarding" | "works") {
  const client = setupApp({ context, routes: integrationsTelegramRoutes })(
    integrationsTelegramContract,
  );
  const headers = {
    authorization: "Bearer clerk-session",
    [CLIENT_REQUEST_ID_HEADER]: REQUEST_ID,
  };
  return await accept(
    client.getLinkStatus({
      headers,
      query: {
        botId: OFFICIAL_TELEGRAM_BOT_ID,
        origin: APP_ORIGIN,
        source,
      },
    }),
    [200],
  );
}

describe("Telegram connection readiness diagnostics", () => {
  it.each([
    { length: "5000", status: 200, configured: true },
    { length: "38", status: 200, configured: false },
    { length: "1000", status: 200, configured: false },
    { length: null, status: 200, configured: false },
    { length: "38", status: 503, configured: false },
  ])(
    "reports a $status probe with length $length without guessing domain configuration",
    async ({ length, status, configured }) => {
      server.use(
        http.head(OAUTH_URL, ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("origin")).toBe(APP_ORIGIN);
          expect(url.searchParams.get("bot_id")).toBe("9876543210");
          return new HttpResponse(null, {
            status,
            headers: length === null ? {} : { "content-length": length },
          });
        }),
      );

      const response = await linkStatus("onboarding");

      expect(response.body).toStrictEqual({
        linked: false,
        ...(configured ? {} : { readinessError: "domain_not_verified" }),
        installation: {
          id: OFFICIAL_TELEGRAM_BOT_ID,
          botUsername: "test_okou_bot",
          loginBotId: "9876543210",
          domainConfigured: configured,
        },
      });
    },
  );

  it.each([
    {
      name: "missing bot username",
      variable: "TELEGRAM_OFFICIAL_BOT_USERNAME",
      value: undefined,
    },
    {
      name: "missing bot token",
      variable: "TELEGRAM_OFFICIAL_BOT_TOKEN",
      value: undefined,
    },
    {
      name: "invalid bot id",
      variable: "TELEGRAM_OFFICIAL_BOT_TOKEN",
      value: "invalid:test-bot-secret",
    },
  ] as const)(
    "explains $name separately from a domain check failure",
    async ({ variable, value }) => {
      mockEnv(variable, value);

      const response = await linkStatus();

      expect(response.body).toMatchObject({
        linked: false,
        readinessError: "bot_not_configured",
      });
    },
  );

  it("reports transport failure and allows a later Works attempt to verify the domain", async () => {
    server.use(
      http.head(OAUTH_URL, () => {
        return HttpResponse.error();
      }),
    );

    const failed = await linkStatus("onboarding");

    expect(failed.body).toMatchObject({
      linked: false,
      readinessError: "domain_check_failed",
      installation: { domainConfigured: false },
    });
    server.use(
      http.head(OAUTH_URL, () => {
        return new HttpResponse(null, {
          headers: { "content-length": "5000" },
        });
      }),
    );

    const retried = await linkStatus("works");

    expect(retried.body).toMatchObject({
      linked: false,
      installation: { domainConfigured: true },
    });
    expect(retried.body).not.toHaveProperty("readinessError");
  });

  it("reports a probe deadline as a temporary check failure", async () => {
    context.mocks.abortSignal.timeout.mockImplementation((milliseconds) => {
      return milliseconds === 3000
        ? AbortSignal.abort(new DOMException("Probe timed out", "TimeoutError"))
        : context.signal;
    });
    server.use(
      http.head(OAUTH_URL, () => {
        return new HttpResponse(null, {
          headers: { "content-length": "5000" },
        });
      }),
    );

    const response = await linkStatus("onboarding");

    expect(response.body).toMatchObject({
      linked: false,
      readinessError: "domain_check_failed",
      installation: { domainConfigured: false },
    });
  });
});
