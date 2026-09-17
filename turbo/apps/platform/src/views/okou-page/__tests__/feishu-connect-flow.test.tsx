import { feishuBrowserConnectContract } from "@okouai/api-contracts/contracts/feishu-browser-connect";
import { feishuOauthContract } from "@okouai/api-contracts/contracts/feishu-oauth";
import { FEISHU_PLATFORMS } from "@okouai/core/feishu-platform";
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { setupPage, startPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";

const context = testContext();
const connectBody = Object.freeze({
  installationId: "00000000-0000-4000-8000-000000000001",
  openId: "ou_member",
  chatId: "oc_chat",
  ts: 1_234_567_890,
  sig: "signed-message-connect",
});
const connectQuery = new URLSearchParams({
  connect: "account",
  ...connectBody,
  ts: String(connectBody.ts),
}).toString();

describe.each(["feishu", "lark"] as const)(
  "%s account connection",
  (platform) => {
    const provider = FEISHU_PLATFORMS[platform];
    const connectPath = `${provider.settingsPath}?${connectQuery}`;
    const returnUrl = `https://app.okou.ai${connectPath}`;

    it("signed connection links require login and retain the complete return URL", async () => {
      await startPage({
        context,
        host: "app.okou.ai",
        path: connectPath,
        auth: null,
      });
      await waitFor(() => {
        expect(window.location.pathname).toBe("/sign-in");
      });
      const signInQuery = new URLSearchParams(
        window.location.hash.split("?")[1],
      );
      expect(signInQuery.get("redirect_url")).toBe(returnUrl);
    });

    it("registration retains the signed connection destination", async () => {
      await setupPage({
        context,
        host: "app.okou.ai",
        path: `/sign-up?${new URLSearchParams({ redirect_url: returnUrl })}`,
        auth: null,
      });
      await expect(
        screen.findByTestId("clerk-sign-up"),
      ).resolves.toHaveAttribute("data-clerk-force-redirect-url", returnUrl);
    });

    it("authenticated message links pass their signed identity to account connection", async () => {
      let submitted: unknown;
      const openUrl = `${provider.appLinkOrigin}/client/bot/open?appId=cli_connected`;
      context.mocks.api(
        feishuBrowserConnectContract.connectFromApp,
        ({ body, respond }) => {
          submitted = body;
          return respond(200, {
            success: true,
            botName: "Custom bot",
            openUrl,
          });
        },
      );
      await startPage({
        context,
        host: "app.okou.ai",
        path: connectPath,
        // A message recipient may not have a personal rollout override.
        featureSwitches: { [provider.featureSwitch]: false },
      });
      await waitFor(() => {
        expect(window.location.href).toBe(openUrl);
      });
      expect(submitted).toStrictEqual(connectBody);
    });

    it("shows the provider on OAuth callbacks and returns to its bot", async () => {
      const ready = createDeferredPromise<void>(context.signal);
      let submitted: unknown;
      const redirectUrl = `${provider.appLinkOrigin}/client/bot/open?appId=cli_connected`;
      context.mocks.api(
        feishuOauthContract.callback,
        async ({ query, respond }) => {
          submitted = query;
          await ready.promise;
          return respond(200, { redirectUrl });
        },
      );
      const page = await startPage({
        context,
        host: "app.okou.ai",
        path: `${provider.callbackPath}?state=signed-oauth&code=authorization-code`,
        auth: null,
      });
      try {
        await expect(
          screen.findByText(`Connecting ${provider.name}…`),
        ).resolves.toBeVisible();
      } finally {
        ready.resolve();
      }
      await page.ready;
      expect(submitted).toStrictEqual({
        state: "signed-oauth",
        code: "authorization-code",
        responseMode: "json",
      });
      await waitFor(() => {
        expect(window.location.href).toBe(redirectUrl);
      });
    });
  },
);
