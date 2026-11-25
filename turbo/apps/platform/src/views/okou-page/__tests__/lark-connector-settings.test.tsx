import { test, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findAction } from "./connector-integrations-test-helpers.ts";
import {
  visitProvider,
  botWorkspace,
  providerContract,
} from "./provider-bot-fixtures.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { larkOfficialContract } from "@okouai/api-contracts/contracts/lark-official";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import userEvent from "@testing-library/user-event";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";

const context = testContext();

test("integrations-lark-001 the Lark guide verifies its own app credentials before asking for encryption", async () => {
  botWorkspace(context, "lark", true, () => {
    return [];
  });
  context.mocks.api(
    providerContract("lark").checkAppId,
    ({ query, respond }) => {
      return query.appId === "cli_lark"
        ? respond(200, { available: true })
        : respond(409, {
            error: { code: "CONFLICT", message: "Unrecognized app" },
          });
    },
  );
  await visitProvider(context, "lark", "/works");
  const link = await screen.findByTestId("lark-setup-button");
  expect(link).toHaveAttribute("href", "/settings/lark");
  expect(screen.queryByTestId("feishu-setup-button")).toBeNull();
  click(link);
  await expect(
    screen.findByRole("heading", { name: "Lark bots" }),
  ).resolves.toBeInTheDocument();
  click(await findAction("link", "Add bot"));
  await expect(
    screen.findByText("Create an Agent app"),
  ).resolves.toBeInTheDocument();
  expect(
    document.querySelector(
      'a[href="https://open.larksuite.com/page/launcher?from=backend_oneclick"]',
    ),
  ).toBeVisible();
  await expect(
    findAction("link", "Download the optional Okou icon"),
  ).resolves.toHaveAttribute("download", "okou-lark-app-icon.png");
  click(await findAction("button", "Next"));
  await fill(
    screen.getByLabelText("App ID", { selector: "input" }),
    "cli_lark",
  );
  await fill(
    screen.getByLabelText("App Secret", { selector: "input" }),
    "lark-credential",
  );
  click(await findAction("button", "Next"));
  await expect(
    screen.findByLabelText("Encrypt Key", { selector: "input" }),
  ).resolves.toBeInTheDocument();
});

test("integrations-lark-003 the empty installation account loads on the Lark bot list", async () => {
  const status = createDeferredPromise<void>(context.signal);
  botWorkspace(context, "lark", true, () => {
    if (!status.settled()) {
      status.resolve();
    }
    return [];
  });
  await visitProvider(context, "lark", "/settings/lark");
  await status.promise;
  await expect(
    screen.findByText("No Lark bots yet"),
  ).resolves.toBeInTheDocument();
  await expect(
    screen.findByRole("heading", { name: "Lark bots" }),
  ).resolves.toBeInTheDocument();
  await expect(findAction("link", "Add bot")).resolves.toHaveAttribute(
    "href",
    "/settings/lark/setup",
  );
});

async function settings(custom: boolean, connected = false) {
  const installationId = crypto.randomUUID();
  botWorkspace(context, "lark", true, () => {
    return [];
  });
  context.mocks.api(larkOfficialContract.getStatus, ({ respond }) => {
    return respond(200, {
      isConfigured: true,
      isConnected: connected,
      connectedUserName: connected ? "Official User" : null,
      installationId: connected ? installationId : null,
    });
  });
  context.mocks.api(larkOfficialContract.disconnect, ({ respond }) => {
    connected = false;
    return respond(200, { success: true });
  });
  await setupPage({
    context,
    path: "/settings/lark",
    host: "app.okou.ai",
    auth: {
      user: { id: "user_harbor", fullName: "Harbor reader" },
      session: { token: "harbor-admin" },
    },
    featureSwitches: {
      [FeatureSwitchKey.WorksChannelCards]: false,
      [FeatureSwitchKey.LarkIntegration]: custom,
      [FeatureSwitchKey.LarkOfficialBot]: true,
    },
  });
  await screen.findByRole("region", { name: "Okou" });
}

test("lark-official-004 keyboard reopening the official account menu allows disconnect", async () => {
  await settings(true, true);
  await screen.findByText("Official User");
  const menu = await findFastControl("button", "More options for Okou");
  click(menu);
  await findFastControl("button", "Disconnect");
  await userEvent.keyboard("{Escape}");
  expect(queryFastControl("button", "Disconnect")).toBeNull();
  expect(menu).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  click(await findFastControl("button", "Disconnect"));
  await expect(findFastControl("button", "Connect")).resolves.toBeEnabled();
  await expect(findFastControl("link", "Add bot")).resolves.toBeEnabled();
});

test("lark-official-005 the official connection is available independently of custom bots", async () => {
  await settings(false);
  await expect(findFastControl("button", "Connect")).resolves.toBeEnabled();
  expect(queryFastControl("link", "Add bot")).toBeNull();
});

test("lark-official-006 a blocked authorization window leaves the official connection retryable", async () => {
  vi.spyOn(window, "open").mockReturnValue(null);
  await settings(false);
  const connect = await findFastControl("button", "Connect");
  click(connect);
  await screen.findByText("Allow pop-ups to connect your Lark account.");
  expect(connect).toBeEnabled();
});
