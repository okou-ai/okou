import {
  feishuConnectContract,
  type FeishuConnectStatus,
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
