import { test, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { feishuBrowserConnectContract } from "@okouai/api-contracts/contracts/feishu-browser-connect";
import { feishuOauthContract } from "@okouai/api-contracts/contracts/feishu-oauth";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { setupPage, startPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { findAction } from "./connector-integrations-test-helpers.ts";

const context = testContext();

function messageLink(provider: string) {
  const signed = {
    installationId: crypto.randomUUID(),
    openId: provider + "-member-24",
    chatId: provider + "-group-7",
    sig: "proof+17/=",
    ts: 1_780_000_123,
  };
  const path =
    "/settings/" +
    provider +
    "?" +
    new URLSearchParams({
      connect: "account",
      ...signed,
      ts: String(signed.ts),
    });
  return { path, signed };
}

test("feishu-connect-flow-001 signing in preserves the entire signed message link", async () => {
  const { path } = messageLink("feishu");
  await startPage({ context, path, auth: null, host: "app.okou.ai" });
  await waitFor(() => {
    return expect(location.pathname).toBe("/sign-in");
  });
  expect(new URL(location.href).searchParams.get("redirect_url")).toBe(
    new URL(path, "https://app.okou.ai").href,
  );
});

test.each([
  ["feishu-connect-flow-002", "feishu", "applink.feishu.cn"],
  ["feishu-connect-flow-009", "lark", "applink.larksuite.com"],
] as const)(
  "%s connects the signed message identity with the integration disabled",
  async (_id, provider, host) => {
    const { path, signed } = messageLink(provider);
    const target = "https://" + host + "/client/chat/open?id=crew-17";
    const browser = context.mocks.browser.locationAssign();
    const submissions: unknown[] = [];
    context.mocks.api(
      feishuBrowserConnectContract.connectFromApp,
      ({ body, request, respond }) => {
        submissions.push({
          body,
          bearer: request.headers.get("authorization"),
        });
        return respond(200, {
          success: true,
          botName: "Survey",
          openUrl: target,
        });
      },
    );
    await startPage({
      context,
      path,
      auth: {
        user: { id: "shore-" + provider, fullName: "Shore member" },
        session: { token: provider + "-session" },
      },
      featureSwitches: {
        [FeatureSwitchKey.FeishuIntegration]: false,
        [FeatureSwitchKey.LarkIntegration]: false,
      },
    });
    await waitFor(() => {
      return expect(browser.calls).toContain(target);
    });
    expect(submissions).toContainEqual({
      body: signed,
      bearer: "Bearer " + provider + "-session",
    });
  },
);

test.each([
  ["feishu-connect-flow-003", "Feishu", "expired"],
  ["feishu-connect-flow-004", "Feishu", "incomplete"],
  ["feishu-connect-flow-011", "Lark", "incomplete"],
] as const)(
  "%s recovers an unusable message link in the originating provider",
  async (_id, brand, reason) => {
    const provider = brand.toLowerCase();
    const path =
      reason === "expired"
        ? messageLink(provider).path
        : "/settings/" + provider + "?connect=account";
    context.mocks.api(
      feishuBrowserConnectContract.connectFromApp,
      ({ respond }) => {
        return respond(400, {
          error: {
            code: "FEISHU_CONNECT_LINK_INVALID",
            message: "Expired signature",
          },
        });
      },
    );
    await setupPage({ context, path });
    await expect(
      screen.findByText("Connection failed"),
    ).resolves.toBeInTheDocument();
    expect(
      screen.getByText(
        "This connection link is invalid or has expired. Return to " +
          brand +
          " and message the bot for a new link.",
      ),
    ).toBeVisible();
    await expect(
      findAction("link", "Back to settings"),
    ).resolves.toHaveAttribute("href", "/works");
  },
);

test("feishu-connect-flow-007 the logged-out callback shows its provider until the bot destination arrives", async () => {
  const reply = createDeferredPromise<void>(context.signal);
  const browser = context.mocks.browser.locationAssign();
  const target = "https://applink.feishu.cn/client/chat/open?id=survey";
  context.mocks.api(
    feishuOauthContract.callback,
    async ({ query, respond }) => {
      expect(query).toMatchObject({
        code: "ticket-29",
        state: "signed+return",
        responseMode: "json",
      });
      await reply.promise;
      return respond(200, { redirectUrl: target });
    },
  );
  const page = await startPage({
    context,
    auth: null,
    path: "/connectors/feishu/callback?state=signed%2Breturn&code=ticket-29",
  });
  await expect(
    screen.findByText("Connecting Feishu…"),
  ).resolves.toBeInTheDocument();
  reply.resolve();
  await waitFor(() => {
    return expect(browser.calls).toContain(target);
  });
  await page.ready;
});
