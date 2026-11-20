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

type Provider = "feishu" | "lark";

async function completeSignedConnection(platform: Provider) {
  const provider = FEISHU_PLATFORMS[platform];
  const connectPath = `${provider.settingsPath}?${connectQuery}`;
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
  return submitted;
}

async function openIncompleteConnection(platform: Provider) {
  const provider = FEISHU_PLATFORMS[platform];
  await setupPage({
    context,
    host: "app.okou.ai",
    path: `${provider.settingsPath}?connect=account`,
  });

  return screen.getByText(
    `This connection link is invalid or has expired. Return to ${provider.name} and message the bot for a new link.`,
  );
}

describe("feishu account connection", () => {
  const provider = FEISHU_PLATFORMS.feishu;
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
    const signInQuery = new URL(window.location.href).searchParams;
    expect(signInQuery.get("redirect_url")).toBe(returnUrl);
  });

  it("authenticated message links pass their signed identity to account connection", async () => {
    await expect(completeSignedConnection("feishu")).resolves.toStrictEqual(
      connectBody,
    );
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
    expect(screen.getByRole("alert")).toHaveTextContent("Connection failed");
    expect(screen.getByRole("img", { name: "Okou" })).toBeInTheDocument();
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
    await expect(
      openIncompleteConnection("feishu"),
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
});

describe("lark account connection", () => {
  it("authenticated message links pass their signed identity to account connection", async () => {
    await expect(completeSignedConnection("lark")).resolves.toStrictEqual(
      connectBody,
    );
  });

  it("shows the same recovery guidance for an incomplete connection link", async () => {
    await expect(openIncompleteConnection("lark")).resolves.toBeInTheDocument();
  });
});
