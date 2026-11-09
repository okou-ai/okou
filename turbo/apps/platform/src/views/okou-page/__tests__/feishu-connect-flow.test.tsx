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

    it("shows recovery guidance when a signed connection link is rejected", async () => {
      context.mocks.api(
        feishuBrowserConnectContract.connectFromApp,
        ({ respond }) => {
          return respond(400, {
            error: {
              code: "FEISHU_CONNECT_LINK_INVALID",
              message: "Invalid or expired bot connect link",
            },
          });
        },
      );

      await setupPage({
        context,
        host: "app.okou.ai",
        path: connectPath,
        featureSwitches: { [provider.featureSwitch]: false },
      });

      expect(
        screen.getByRole("heading", { name: "Connection failed" }),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          `This connection link is invalid or has expired. Return to ${provider.name} and message the bot for a new link.`,
        ),
      ).toBeInTheDocument();
      expect(screen.getByText("Back to settings")).toHaveAttribute(
        "href",
        "/works",
      );
    });

    it("shows the same recovery guidance for an incomplete connection link", async () => {
      await setupPage({
        context,
        host: "app.okou.ai",
        path: `${provider.settingsPath}?connect=account`,
      });

      expect(
        screen.getByText(
          `This connection link is invalid or has expired. Return to ${provider.name} and message the bot for a new link.`,
        ),
      ).toBeInTheDocument();
    });

    it.each([
      {
        label: "other client errors",
        status: 400 as const,
        code: "BAD_REQUEST",
        message: "Finish setting up this bot before connecting",
      },
      {
        label: "server errors",
        status: 500 as const,
        code: "INTERNAL_SERVER_ERROR",
        message: "The connection service is unavailable",
      },
    ])("preserves $label", async (failure) => {
      context.mocks.api(
        feishuBrowserConnectContract.connectFromApp,
        ({ respond }) => {
          return respond(failure.status, {
            error: { code: failure.code, message: failure.message },
          });
        },
      );

      const page = await startPage({
        context,
        host: "app.okou.ai",
        path: connectPath,
      });

      await expect(page.ready).rejects.toThrow(failure.message);
      await expect(
        screen.findByText(failure.message),
      ).resolves.toBeInTheDocument();
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
