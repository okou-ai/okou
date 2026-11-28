import { randomUUID } from "node:crypto";
import { CLIENT_REQUEST_ID_HEADER } from "@okouai/api-contracts/contracts/client-headers";
import { integrationsTelegramContract } from "@okouai/api-contracts/contracts/integrations-telegram";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { integrationsTelegramRoutes } from "../integrations-telegram";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const APP_ORIGIN = "https://app.example.com";
const BOT_ID = "9876543210";

type ProbeAnswer =
  { readonly status: number; readonly contentLength: number } | "network-error";

/** The official bot is configured and Telegram's OAuth page answers each domain probe in turn. */
function officialBot(answers: readonly ProbeAnswer[]) {
  mockEnv("APP_URL", APP_ORIGIN);
  mockEnv("TELEGRAM_OFFICIAL_BOT_USERNAME", "test_okou_bot");
  mockEnv("TELEGRAM_OFFICIAL_BOT_TOKEN", `${BOT_ID}:${randomUUID()}`);
  const probes: URL[] = [];
  server.use(
    http.head("https://oauth.telegram.org/auth", ({ request }) => {
      const answer = answers[probes.length] ?? answers.at(-1);
      probes.push(new URL(request.url));
      if (!answer || answer === "network-error") {
        return HttpResponse.error();
      }
      return new HttpResponse(null, {
        status: answer.status,
        headers: { "content-length": String(answer.contentLength) },
      });
    }),
  );
  return probes;
}

/** A signed-in member without a Telegram link checks readiness. */
async function readLinkStatus(source: "onboarding" | "works") {
  createRouteMocks(context).clerk.session(
    `user_${randomUUID()}`,
    `org_${randomUUID()}`,
    "org:member",
  );
  const response = await accept(
    setupApp({ context, routes: integrationsTelegramRoutes })(
      integrationsTelegramContract,
    ).getLinkStatus({
      headers: { authorization: "Bearer clerk-session" },
      query: { botId: "official", origin: APP_ORIGIN, source },
      extraHeaders: { [CLIENT_REQUEST_ID_HEADER]: randomUUID() },
    }),
    [200],
  );
  return response.body;
}

function probeQuery(probes: readonly URL[]) {
  return probes.map((probe) => {
    return {
      origin: probe.searchParams.get("origin"),
      botId: probe.searchParams.get("bot_id"),
    };
  });
}

const installation = Object.freeze({
  id: "official",
  botUsername: "test_okou_bot",
  loginBotId: BOT_ID,
});

describe("Telegram connection readiness diagnostics", () => {
  it("integrations-telegram-readiness-001 reports a verified domain for a 200 probe with length 5000", async () => {
    const probes = officialBot([{ status: 200, contentLength: 5000 }]);

    const status = await readLinkStatus("onboarding");

    expect(probeQuery(probes)).toStrictEqual([
      { origin: APP_ORIGIN, botId: BOT_ID },
    ]);
    expect(status).toStrictEqual({
      linked: false,
      installation: { ...installation, domainConfigured: true },
    });
  });

  it("integrations-telegram-readiness-002 reports an unverified domain for a 200 probe with length 38", async () => {
    const probes = officialBot([{ status: 200, contentLength: 38 }]);

    const status = await readLinkStatus("onboarding");

    expect(probeQuery(probes)).toStrictEqual([
      { origin: APP_ORIGIN, botId: BOT_ID },
    ]);
    expect(status).toStrictEqual({
      linked: false,
      readinessError: "domain_not_verified",
      installation: { ...installation, domainConfigured: false },
    });
  });

  it("integrations-telegram-readiness-005 reports a failed domain check for a 503 probe with length 38", async () => {
    const probes = officialBot([{ status: 503, contentLength: 38 }]);

    const status = await readLinkStatus("onboarding");

    expect(probeQuery(probes)).toStrictEqual([
      { origin: APP_ORIGIN, botId: BOT_ID },
    ]);
    expect(status).toStrictEqual({
      linked: false,
      readinessError: "domain_check_failed",
      installation: { ...installation, domainConfigured: false },
    });
  });

  it("integrations-telegram-readiness-010 reports a transport failure and lets a later Works attempt verify the domain", async () => {
    officialBot(["network-error", { status: 200, contentLength: 5000 }]);

    const failed = await readLinkStatus("onboarding");
    const retried = await readLinkStatus("works");

    expect(failed).toMatchObject({
      linked: false,
      readinessError: "domain_check_failed",
      installation: { domainConfigured: false },
    });
    expect(retried).toMatchObject({
      linked: false,
      installation: { domainConfigured: true },
    });
    expect(retried).not.toHaveProperty("readinessError");
  });
});
