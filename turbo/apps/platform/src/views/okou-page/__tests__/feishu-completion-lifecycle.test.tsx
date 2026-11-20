import {
  feishuConnectContract,
  type FeishuConnectStatus,
  type FeishuInstallationStatus,
} from "@okouai/api-contracts/contracts/feishu-connect";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findAction,
  getAction,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();
const INSTALLATION_ID = "e0000000-0000-4000-a000-000000000a31";
const SETUP_PATH = `/settings/feishu/setup/${INSTALLATION_ID}`;

/** One admin-managed bot whose callback is verified but whose setup is open. */
function serveBot(): { installation: FeishuInstallationStatus } {
  const server = {
    installation: {
      id: INSTALLATION_ID,
      isConnected: false,
      connectedUserName: null,
      appId: "cli_support_bot",
      botName: "Support desk",
      callbackUrl: "https://api.okou.test/api/integrations/feishu/events",
      oauthRedirectUrl: "https://app.okou.test/connectors/feishu/callback",
      connectUrl: null,
      callbackVerified: true,
      setupCompleted: false,
      messageReceived: false,
      tenantKey: "tenant-support",
      tenantName: "Support tenant",
      defaultAgentId: null,
      defaultAgentName: "Okou",
    } satisfies FeishuInstallationStatus,
  };
  context.mocks.api(feishuConnectContract.getStatus, ({ respond }) => {
    const installation = server.installation;
    const status: FeishuConnectStatus = {
      isInstalled: true,
      isConnected: installation.isConnected,
      isAdmin: true,
      appId: installation.appId,
      callbackUrl: installation.callbackUrl,
      callbackVerified: installation.callbackVerified,
      messageReceived: installation.messageReceived,
      tenantKey: installation.tenantKey,
      tenantName: installation.tenantName,
      defaultAgentId: installation.defaultAgentId,
      defaultAgentName: installation.defaultAgentName,
      installationId: installation.id,
      installations: [installation],
    };
    return respond(200, status);
  });
  return server;
}

async function findStep(title: string): Promise<void> {
  await expect(
    screen.findByRole("heading", { name: title }),
  ).resolves.toBeInTheDocument();
}

test("feishu setup completion preserves a newer bot draft and its page", async () => {
  const server = serveBot();
  const requested = context.mocks.deferred<void>();
  const aborted = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  const answered = context.mocks.deferred<void>();
  context.mocks.api(
    feishuConnectContract.updateInstallation,
    async ({ params, body, request, respond }) => {
      expect(params.installationId).toBe(INSTALLATION_ID);
      request.signal.addEventListener(
        "abort",
        () => {
          aborted.resolve();
        },
        { once: true },
      );
      requested.resolve();
      await release.promise;
      server.installation = {
        ...server.installation,
        setupCompleted: body.setupCompleted ?? false,
        connectUrl: "https://open.feishu.cn/connect/cli_support_bot",
      };
      answered.resolve();
      return respond(200, server.installation);
    },
  );
  await setupPage({
    context,
    path: SETUP_PATH,
    featureSwitches: { [FeatureSwitchKey.FeishuIntegration]: true },
  });
  await findStep("Configure the OAuth redirect URL");
  click(getAction("button", "Next"));
  await findStep("Import app and user scopes");
  click(getAction("button", "Next"));
  await findStep("Configure event delivery");
  click(getAction("button", "Next"));
  await findStep("Publish the app");
  click(getAction("button", "Done"));
  await requested.promise;

  click(getAction("link", "Feishu bots"));
  click(await findAction("button", "More options for Support desk"));
  click(await findAction("link", "Manage"));
  await findStep("Configure the OAuth redirect URL");
  click(getAction("button", "Back"));
  await findStep("Add the event verification tokens");
  click(getAction("button", "Back"));
  await findStep("Add the app credentials");
  await fill(screen.getByLabelText("App Secret"), "rotated-secret");
  await aborted.promise;
  release.resolve();
  await answered.promise;

  expect(window.location.pathname).toBe(SETUP_PATH);
  expect(
    screen.getByRole("heading", { name: "Manage Feishu bot" }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByLabelText("App Secret")).toHaveValue("rotated-secret");
});
