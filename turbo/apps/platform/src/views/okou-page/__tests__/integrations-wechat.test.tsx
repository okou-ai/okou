import { expect, test } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor } from "@testing-library/react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { integrationsWechatContract as contract } from "@okouai/api-contracts/contracts/integrations-wechat";
import { agentsByIdContract } from "@okouai/api-contracts/contracts/agents";
import { setupPage, click, fill } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getIntegrationCard,
  getAction,
  queryAction,
} from "./connector-integrations-test-helpers.ts";
const context = testContext();
const id = "00000000-0000-4000-8000-000000000001";
const attempt = Object.freeze({
  id,
  qrContent: "https://weixin.qq.com/qr-test",
  expiresAt: "2099-01-01T00:00:00.000Z",
});
const setup = () => {
  return setupPage({
    context,
    path: "/works",
    featureSwitches: { [FeatureSwitchKey.WechatIntegration]: true },
  });
};
test("WeChat is hidden with its feature disabled", async () => {
  await setupPage({
    context,
    path: "/works",
    featureSwitches: { [FeatureSwitchKey.WechatIntegration]: false },
  });
  expect(screen.queryByText("WeChat")).not.toBeInTheDocument();
});
test("Connect displays a QR and an expired code can be replaced", async () => {
  let expired = true;
  context.mocks.api(contract.status, ({ respond }) => {
    return respond(200, {
      configured: true,
      status: "disconnected",
      binding: null,
    });
  });
  context.mocks.api(contract.connect, ({ respond }) => {
    return respond(
      200,
      expired
        ? attempt
        : {
            ...attempt,
            id: "00000000-0000-4000-8000-000000000002",
            qrContent: "https://weixin.qq.com/replacement-qr",
          },
    );
  });
  context.mocks.api(contract.poll, ({ respond }) => {
    return respond(200, {
      status: expired ? "expired" : "verification_required",
    });
  });
  await setup();
  click(getAction("button", "Connect", getIntegrationCard("WeChat")));
  await expect(screen.findByRole("dialog")).resolves.toHaveTextContent(
    "Scan this QR code with WeChat",
  );
  await expect(
    screen.findByText("This QR code expired. Create a new one."),
  ).resolves.toBeInTheDocument();
  expired = false;
  click(getAction("button", "Create a new QR code"));
  await expect(
    screen.findByTestId("wechat-connect-qr"),
  ).resolves.toBeInTheDocument();
  await expect(
    screen.findByRole("textbox", { name: "Verification code" }),
  ).resolves.toBeInTheDocument();
  expect(
    screen.queryByText("This QR code expired. Create a new one."),
  ).not.toBeInTheDocument();
});
test("a scan requiring verification keeps the QR and shows a code field", async () => {
  context.mocks.api(contract.status, ({ respond }) => {
    return respond(200, {
      configured: true,
      status: "disconnected",
      binding: null,
    });
  });
  context.mocks.api(contract.connect, ({ respond }) => {
    return respond(200, attempt);
  });
  context.mocks.api(contract.poll, ({ respond }) => {
    return respond(200, { status: "verification_required" });
  });
  await setup();
  click(getAction("button", "Connect", getIntegrationCard("WeChat")));
  await expect(
    screen.findByTestId("wechat-connect-qr"),
  ).resolves.toBeInTheDocument();
  await expect(
    screen.findByRole("textbox", { name: "Verification code" }),
  ).resolves.toBeInTheDocument();
  expect(getAction("button", "Verify")).toBeDisabled();
});

test("verification connects the account and disconnect revokes it", async () => {
  let connected = false;
  context.mocks.api(contract.status, ({ respond }) => {
    return respond(200, {
      configured: true,
      status: connected ? "active" : "disconnected",
      binding: connected
        ? {
            workspace: { id: "org_team", name: "Team" },
            accountId: "scanner-owner",
          }
        : null,
    });
  });
  context.mocks.api(contract.connect, ({ respond }) => {
    return respond(200, attempt);
  });
  context.mocks.api(contract.poll, ({ body, respond }) => {
    connected = body.verifyCode === "123456";
    return respond(200, {
      status: connected ? "connected" : "verification_required",
    });
  });
  context.mocks.api(contract.cancel, ({ respond }) => {
    return respond(204);
  });
  context.mocks.api(contract.disconnect, ({ respond }) => {
    connected = false;
    return respond(204);
  });
  await setup();
  click(getAction("button", "Connect", getIntegrationCard("WeChat")));
  await fill(
    await screen.findByRole("textbox", { name: "Verification code" }),
    "123456",
  );
  click(getAction("button", "Verify"));
  await waitFor(() => {
    return expect(getIntegrationCard("WeChat")).toHaveTextContent("Connected");
  });
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(queryAction("button", "Disconnect")).not.toBeInTheDocument();
  click(getAction("button", "More options", getIntegrationCard("WeChat")));
  click(getAction("button", "Disconnect"));
  await waitFor(() => {
    return expect(
      getAction("button", "Connect", getIntegrationCard("WeChat")),
    ).toBeEnabled();
  });
});

test("keyboard activation and Escape restore focus to Connect", async () => {
  context.mocks.api(contract.status, ({ respond }) => {
    return respond(200, {
      configured: true,
      status: "disconnected",
      binding: null,
    });
  });
  context.mocks.api(contract.connect, ({ respond }) => {
    return respond(200, attempt);
  });
  context.mocks.api(contract.poll, ({ respond }) => {
    return respond(200, { status: "verification_required" });
  });
  context.mocks.api(contract.cancel, ({ respond }) => {
    return respond(204);
  });
  await setup();
  const user = userEvent.setup({ delay: null });
  const trigger = getAction("button", "Connect", getIntegrationCard("WeChat"));
  trigger.focus();
  await user.keyboard("{Enter}");
  await screen.findByRole("textbox", { name: "Verification code" });
  await user.keyboard("{Escape}");
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  await waitFor(() => {
    return expect(trigger).toHaveFocus();
  });
});

test("a failed QR request can be retried from the dialog", async () => {
  let available = false;
  context.mocks.api(contract.status, ({ respond }) => {
    return respond(200, {
      configured: true,
      status: "disconnected",
      binding: null,
    });
  });
  context.mocks.api(contract.connect, ({ respond }) => {
    return available
      ? respond(200, attempt)
      : respond(503, {
          error: {
            code: "SERVICE_UNAVAILABLE",
            message: "WeChat is temporarily unavailable",
          },
        });
  });
  context.mocks.api(contract.poll, ({ respond }) => {
    return respond(200, { status: "verification_required" });
  });
  await setup();
  click(getAction("button", "Connect", getIntegrationCard("WeChat")));
  const retry = await waitFor(() => {
    return getAction("button", "Create a new QR code");
  });
  expect(retry).toBeEnabled();
  available = true;
  click(retry);
  await expect(
    screen.findByRole("textbox", { name: "Verification code" }),
  ).resolves.toBeInTheDocument();
  expect(queryAction("button", "Create a new QR code")).not.toBeInTheDocument();
});

test("the connected card identifies its workspace and WeChat account", async () => {
  context.mocks.api(contract.status, ({ respond }) => {
    return respond(200, {
      configured: true,
      status: "active",
      binding: {
        workspace: { id: "org_operations", name: "Operations workspace" },
        accountId: "scanner-owner",
      },
    });
  });
  await setup();
  await expect(
    screen.findByText("Operations workspace · scanner-owner"),
  ).resolves.toBeInTheDocument();
});

test.each([
  { email: "owner@example.com", account: "owner@example.com" },
  { email: undefined, account: "user_wechat_confirm" },
])(
  "a reconnect link identifies $account before confirmation",
  async ({ email, account }) => {
    let restored = false;
    context.mocks.api(contract.status, ({ respond }) => {
      return respond(200, {
        configured: true,
        status: restored ? "active" : "disconnected",
        binding: restored
          ? {
              workspace: { id: "org_team", name: "Team" },
              accountId: "scanner-owner",
            }
          : null,
      });
    });
    context.mocks.api(contract.reconnectStatus, ({ query, respond }) => {
      expect(query.token).toBe("signed-link");
      return respond(200, { available: true });
    });
    context.mocks.api(contract.reconnect, ({ body, respond }) => {
      expect(body.token).toBe("signed-link");
      restored = true;
      return respond(204);
    });
    context.mocks.api(agentsByIdContract.get, ({ params, respond }) => {
      return respond(200, {
        agentId: params.id,
        isDefaultAgent: true,
        ownerId: "user_wechat_confirm",
        displayName: "Workspace Assistant",
        description: null,
        sound: null,
        avatarUrl: null,
        visibility: "private",
      });
    });
    await setupPage({
      context,
      path: "/settings/wechat?token=signed-link",
      featureSwitches: { [FeatureSwitchKey.WechatIntegration]: true },
      auth: {
        user: { id: "user_wechat_confirm", fullName: "WeChat Owner", email },
        organization: {
          activeOrg: { id: "org_wechat_confirm", name: "WeChat Workspace" },
          memberships: [{ id: "org_wechat_confirm" }],
        },
      },
    });
    await expect(
      screen.findByText(
        "Restore this WeChat connection to the account and workspace below.",
      ),
    ).resolves.toBeInTheDocument();
    expect(screen.getByText(account, { selector: "dd" })).toBeInTheDocument();
    expect(
      screen.getByText("WeChat Workspace", { selector: "dd" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Workspace Assistant", { selector: "dd" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("wechat-connect-qr")).not.toBeInTheDocument();
    const confirm = getAction("button", "Reconnect");
    expect(confirm).toBeEnabled();
    confirm.focus();
    await userEvent.setup({ delay: null }).keyboard("{Enter}");
    await expect(
      screen.findByText(
        "Return to WeChat and send a message to start chatting.",
      ),
    ).resolves.toBeInTheDocument();
    expect(queryAction("button", "Reconnect")).not.toBeInTheDocument();
    expect(screen.queryByTestId("wechat-connect-qr")).not.toBeInTheDocument();
    expect(window.location.search).toBe("");
  },
);

test("an unavailable reconnect link offers the same QR connection flow on the settings page", async () => {
  let connected = false;
  context.mocks.api(contract.status, ({ respond }) => {
    return respond(200, {
      configured: true,
      status: connected ? "active" : "reconnect_required",
      binding: {
        workspace: { id: "org_team", name: "Team" },
        accountId: "scanner-owner",
      },
    });
  });
  context.mocks.api(contract.reconnectStatus, ({ respond }) => {
    return respond(200, { available: false });
  });
  context.mocks.api(contract.connect, ({ respond }) => {
    return respond(200, attempt);
  });
  context.mocks.api(contract.poll, ({ body, respond }) => {
    connected = body.verifyCode === "123456";
    return respond(200, {
      status: connected ? "connected" : "verification_required",
    });
  });
  await setupPage({
    context,
    path: "/settings/wechat?token=expired",
    featureSwitches: { [FeatureSwitchKey.WechatIntegration]: true },
  });
  await expect(
    screen.findByText(/This link is unavailable/),
  ).resolves.toBeInTheDocument();
  expect(queryAction("button", "Reconnect")).not.toBeInTheDocument();
  click(getAction("link", "Connect with a new QR code"));
  await waitFor(() => {
    expect(window.location.search).toBe("");
  });
  click(getAction("button", "Connect with a new QR code"));
  await expect(
    screen.findByTestId("wechat-connect-qr"),
  ).resolves.toBeInTheDocument();
  await fill(
    await screen.findByRole("textbox", { name: "Verification code" }),
    "123456",
  );
  click(getAction("button", "Verify"));
  await expect(
    screen.findByText("Return to WeChat and send a message to start chatting."),
  ).resolves.toBeInTheDocument();
});

test("a rejected reconnect remains unconnected and shows recovery guidance", async () => {
  context.mocks.api(contract.status, ({ respond }) => {
    return respond(200, {
      configured: true,
      status: "disconnected",
      binding: null,
    });
  });
  context.mocks.api(contract.reconnectStatus, ({ respond }) => {
    return respond(200, { available: true });
  });
  context.mocks.api(contract.reconnect, ({ respond }) => {
    return respond(409, {
      error: { code: "CONFLICT", message: "Link expired" },
    });
  });
  await setupPage({
    context,
    path: "/settings/wechat?token=expired-after-load",
    featureSwitches: { [FeatureSwitchKey.WechatIntegration]: true },
  });
  await expect(
    screen.findByText(
      "Restore this WeChat connection to the account and workspace below.",
    ),
  ).resolves.toBeInTheDocument();
  click(getAction("button", "Reconnect"));
  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    "This link is unavailable",
  );
  expect(
    screen.queryByText(
      "Return to WeChat and send a message to start chatting.",
    ),
  ).not.toBeInTheDocument();
  expect(window.location.search).toBe("?token=expired-after-load");
});

test("the WeChat settings page cannot connect with the feature disabled", async () => {
  await setupPage({
    context,
    path: "/settings/wechat?token=signed-link",
    featureSwitches: { [FeatureSwitchKey.WechatIntegration]: false },
  });
  await expect(
    screen.findByText("Connection is not configured yet."),
  ).resolves.toBeInTheDocument();
  expect(queryAction("button", "Reconnect")).not.toBeInTheDocument();
});
