import { now } from "../../../lib/time.ts";
import { test, expect } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { integrationsWechatContract } from "@okouai/api-contracts/contracts/integrations-wechat";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import {
  findAction,
  getIntegrationCard,
  queryAction,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();
test("integrations-wechat-005 Escape returns focus to the keyboard connection trigger", async () => {
  const id = crypto.randomUUID();
  context.mocks.api(integrationsWechatContract.status, ({ respond }) => {
    return respond(200, {
      configured: true,
      status: "disconnected",
      binding: null,
    });
  });
  context.mocks.api(integrationsWechatContract.connect, ({ respond }) => {
    return respond(200, {
      id,
      qrContent: "weixin://harbor-consent",
      expiresAt: "2099-04-12T12:00:00.000Z",
    });
  });
  context.mocks.api(integrationsWechatContract.poll, ({ body, respond }) => {
    return body.id === id
      ? respond(200, { status: "verification_required" })
      : respond(404, {
          error: { code: "NOT_FOUND", message: "Unknown attempt" },
        });
  });
  context.mocks.api(integrationsWechatContract.cancel, ({ respond }) => {
    return respond(204);
  });
  await setupPage({
    context,
    path: "/works",
    featureSwitches: {
      [FeatureSwitchKey.WechatIntegration]: true,
      [FeatureSwitchKey.WorksChannelCards]: false,
    },
  });
  const connect = await findAction(
    "button",
    "Connect",
    getIntegrationCard("WeChat"),
  );
  connect.focus();
  const keyboard = userEvent.setup({ delay: null });
  await keyboard.keyboard("{Enter}");
  await expect(
    screen.findByText("Enter the verification code shown in WeChat."),
  ).resolves.toBeInTheDocument();
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  await keyboard.keyboard("{Escape}");
  await waitFor(() => {
    return expect(connect).toHaveFocus();
  });
  expect(screen.queryByRole("dialog")).toBeNull();
});

const scanInstructions =
  "Scan this QR code with WeChat, then confirm on your phone.";
const returnInstructions =
  "Return to WeChat and send a message to start chatting.";
const reconnectToken = "owner-return-to-wechat";
function connectionPage(path: string) {
  return setupPage({
    context,
    path,
    featureSwitches: { [FeatureSwitchKey.WechatIntegration]: true },
    auth: {
      user: {
        id: "wechat-owner",
        fullName: "WeChat Owner",
        email: "owner@example.com",
      },
      organization: {
        activeOrg: { id: "org_wechat", name: "WeChat Workspace" },
        memberships: [{ id: "org_wechat" }],
      },
    },
  });
}

function qrService(expiring = false) {
  let active = false;
  const first = "51c72e1b-9756-414e-ba41-f39e09449621";
  const replacement = "416e7c93-5fd7-4acb-b070-0ecd0cbfce93";
  let id = first;
  const expire = context.mocks.deferred<void>();
  context.mocks.api(integrationsWechatContract.status, ({ respond }) => {
    return respond(200, {
      configured: true,
      status: active ? "active" : "disconnected",
      binding: active
        ? {
            workspace: { id: "org_wechat", name: "WeChat Workspace" },
            accountId: "wechat-owner",
          }
        : null,
    });
  });
  context.mocks.api(integrationsWechatContract.connect, ({ respond }) => {
    return respond(200, {
      id,
      qrContent: "https://wechat.test/scan/" + id,
      expiresAt: new Date(now() + 120_000).toISOString(),
    });
  });
  context.mocks.api(
    integrationsWechatContract.poll,
    async ({ body, respond }) => {
      if (body.id !== id) {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "Unknown QR code" },
        });
      }
      if (expiring && id === first) {
        await expire.promise;
        id = replacement;
        return respond(200, { status: "expired" });
      }
      if (body.verifyCode === "123456") {
        active = true;
        return respond(200, { status: "connected" });
      }
      return respond(200, { status: "verification_required" });
    },
  );
  context.mocks.api(integrationsWechatContract.cancel, ({ respond }) => {
    return respond(204);
  });
  context.mocks.api(integrationsWechatContract.disconnect, ({ respond }) => {
    active = false;
    return respond(204);
  });
  context.mocks.api(
    integrationsWechatContract.reconnectStatus,
    ({ query, respond }) => {
      return respond(200, { available: query.token === reconnectToken });
    },
  );
  return expire;
}

test("integrations-wechat-002 gets a fresh scannable code after a QR attempt expires", async () => {
  const expiry = qrService(true);
  await connectionPage("/works");
  click(await findAction("button", "Connect", getIntegrationCard("WeChat")));
  const dialog = within(await screen.findByRole("dialog"));
  expect(dialog.getByText(scanInstructions)).toBeInTheDocument();
  await dialog.findByTestId("wechat-connect-qr");
  expiry.resolve();
  await dialog.findByText("This QR code expired. Create a new one.");
  click(
    await findAction("button", "Connect", await screen.findByRole("dialog")),
  );
  await dialog.findByLabelText("Verification code");
  expect(dialog.getByTestId("wechat-connect-qr")).toBeInTheDocument();
  expect(dialog.queryByText(/QR code expired/u)).toBeNull();
});
test("integrations-wechat-004 verifies a WeChat account and removes its connection from Works", async () => {
  qrService();
  await connectionPage("/works");
  const card = getIntegrationCard("WeChat");
  click(await findAction("button", "Connect", card));
  const dialog = within(await screen.findByRole("dialog"));
  await fill(await dialog.findByLabelText("Verification code"), "123456");
  click(
    await findAction("button", "Verify", await screen.findByRole("dialog")),
  );
  await within(card).findByText("Connected");
  expect(screen.queryByRole("dialog")).toBeNull();
  click(await findAction("button", "More options", card));
  click(await findAction("button", "Disconnect"));
  await expect(findAction("button", "Connect", card)).resolves.toBeEnabled();
});
test("integrations-wechat-010 recovers from an unavailable link using a new verified QR code", async () => {
  qrService();
  await connectionPage("/settings/wechat?token=obsolete");
  await screen.findByText(/This link is unavailable/u);
  expect(queryAction("button", "Reconnect")).toBeNull();
  click(await findAction("link", "Connect with a new QR code"));
  click(await findAction("button", "Connect with a new QR code"));
  await screen.findByTestId("wechat-connect-qr");
  await fill(await screen.findByLabelText("Verification code"), "123456");
  click(await findAction("button", "Verify"));
  await screen.findByText(returnInstructions);
  expect(location.pathname).toBe("/settings/wechat");
});
test("integrations-wechat-011 an expired reconnect link keeps the original destination for recovery", async () => {
  qrService();
  context.mocks.api(
    integrationsWechatContract.reconnect,
    ({ body, respond }) => {
      expect(body.token).toBe(reconnectToken);
      return respond(409, {
        error: { code: "CONFLICT", message: "Link expired" },
      });
    },
  );
  await connectionPage("/settings/wechat?token=" + reconnectToken);
  click(await findAction("button", "Reconnect"));
  await screen.findByText(/This link is unavailable/u);
  expect(screen.queryByText(returnInstructions)).toBeNull();
  expect(new URL(location.href).searchParams.get("token")).toBe(reconnectToken);
});
