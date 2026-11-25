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
  mockFeishu,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();

function credential(label: "App ID" | "App Secret"): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>(label);
}

test("feishu app validation preserves a newly opened setup", async () => {
  mockFeishu(context);
  const started = context.mocks.deferred<void>();
  const aborted = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  const answered = context.mocks.deferred<void>();
  context.mocks.api(
    feishuConnectContract.checkAppId,
    async ({ query, request, respond }) => {
      if (query.appId === "cli_first_bot") {
        request.signal.addEventListener(
          "abort",
          () => {
            aborted.resolve();
          },
          { once: true },
        );
        started.resolve();
        await release.promise;
        answered.resolve();
      }
      return respond(200, { available: true });
    },
  );
  await setupPage({
    context,
    path: "/settings/feishu/setup",
    featureSwitches: { [FeatureSwitchKey.FeishuIntegration]: true },
  });
  await expect(
    screen.findByRole("heading", { name: "Create an Agent app" }),
  ).resolves.toBeInTheDocument();
  click(getAction("button", "Next"));
  await expect(screen.findByLabelText("App ID")).resolves.toBeInTheDocument();
  await fill(credential("App ID"), "cli_first_bot");
  await fill(credential("App Secret"), "first-secret");
  click(getAction("button", "Next"));
  await started.promise;
  await findAction("button", "Checking…");

  click(getAction("link", "Feishu bots"));
  click(await findAction("link", "Add bot"));
  await expect(
    screen.findByRole("heading", { name: "Create an Agent app" }),
  ).resolves.toBeInTheDocument();
  await aborted.promise;
  release.resolve();
  await answered.promise;

  expect(
    screen.getByRole("heading", { name: "Create an Agent app" }),
  ).toBeInTheDocument();
  click(getAction("button", "Next"));

  await expect(
    screen.findByRole("heading", { name: "Add the app credentials" }),
  ).resolves.toBeInTheDocument();
  expect(window.location.pathname).toBe("/settings/feishu/setup");
  expect(
    screen.getByRole("heading", { name: "Add a Feishu bot" }),
  ).toBeInTheDocument();
  expect(credential("App ID")).toHaveValue("");
  expect(credential("App Secret")).toHaveValue("");
});

const FIRST_INSTALLATION_ID = "e0000000-0000-4000-a000-000000000a21";

type Credential =
  "App ID" | "App Secret" | "Verification Token" | "Encrypt Key";

function field(label: Credential): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>(label);
}

async function findStep(title: string): Promise<void> {
  await expect(
    screen.findByRole("heading", { name: title }),
  ).resolves.toBeInTheDocument();
}

async function enterAppCredentials(appId: string, secret: string) {
  await findStep("Create an Agent app");
  click(getAction("button", "Next"));
  await findStep("Add the app credentials");
  await fill(field("App ID"), appId);
  await fill(field("App Secret"), secret);
}

function configuredBot(appId: string): FeishuConnectStatus {
  return {
    isInstalled: true,
    isConnected: false,
    isAdmin: true,
    appId,
    callbackUrl: "https://api.okou.test/api/integrations/feishu/events",
    callbackVerified: false,
    messageReceived: false,
    tenantKey: null,
    tenantName: null,

    installationId: FIRST_INSTALLATION_ID,
  };
}

test("feishu token setup preserves a newer bot draft", async () => {
  mockFeishu(context);
  const submitted = context.mocks.deferred<void>();
  const aborted = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  const answered = context.mocks.deferred<void>();
  context.mocks.api(
    feishuConnectContract.setup,
    async ({ body, request, respond }) => {
      request.signal.addEventListener(
        "abort",
        () => {
          aborted.resolve();
        },
        { once: true },
      );
      submitted.resolve();
      await release.promise;
      answered.resolve();
      return respond(200, configuredBot(body.appId));
    },
  );
  await setupPage({
    context,
    path: "/settings/feishu/setup",
    featureSwitches: { [FeatureSwitchKey.FeishuIntegration]: true },
  });
  await enterAppCredentials("cli_first_bot", "first-secret");
  click(getAction("button", "Next"));
  await findStep("Add the event verification tokens");
  await fill(field("Encrypt Key"), "first-encrypt-key");
  await fill(field("Verification Token"), "first-verification-token");
  click(getAction("button", "Verify and continue"));
  await submitted.promise;
  await findAction("button", "Verifying…");

  click(getAction("link", "Feishu bots"));
  click(await findAction("link", "Add bot"));
  await enterAppCredentials("cli_second_bot", "second-secret");
  await aborted.promise;
  release.resolve();
  await answered.promise;

  expect(
    screen.getByRole("heading", { name: "Add the app credentials" }),
  ).toBeInTheDocument();
  expect(field("App ID")).toHaveValue("cli_second_bot");
  expect(field("App Secret")).toHaveValue("second-secret");
});

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

      installationId: installation.id,
      installations: [installation],
    };
    return respond(200, status);
  });
  return server;
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
