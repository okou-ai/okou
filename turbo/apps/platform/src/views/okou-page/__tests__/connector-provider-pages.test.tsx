import { integrationsTelegramContract } from "@okouai/api-contracts/contracts/integrations-telegram";
import {
  slackConnectContract,
  type SlackConnectLinkStatus,
} from "@okouai/api-contracts/contracts/slack-connect";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findButton, queryButton } from "./chat-run-test-fixtures.ts";
import { findNamedLink } from "./chat-attachment-test-helpers.ts";

const context = testContext();
const host = "app.okou.ai";
const workspace = "T_WORKSPACE";
const member = "U_MEMBER";
const path = "/settings/slack?w=" + workspace + "&u=";

function status(
  linkStatus: SlackConnectLinkStatus,
  workspaceName = "Acme Workspace",
) {
  context.mocks.api(slackConnectContract.getLinkStatus, ({ respond }) => {
    return respond(200, {
      isConnected: linkStatus.kind === "connected",
      isAdmin: false,
      workspaceName,
      linkStatus,
    });
  });
}

test("connector-provider-pages-002 a connected workspace offers both Slack and its settings", async () => {
  status({ kind: "connected" });
  context.mocks.browser.locationAssign();
  await setupPage({ context, path: path + member, host });
  await screen.findByText("Slack is connected");
  await expect(
    screen.findByText(/You're connected to Acme Workspace/),
  ).resolves.toBeInTheDocument();
  await expect(findNamedLink("Open Slack")).resolves.toHaveAttribute(
    "href",
    "slack://open?team=T_WORKSPACE",
  );
  await expect(findNamedLink("Back to settings")).resolves.toHaveAttribute(
    "href",
    "/works",
  );
});

test("connector-provider-pages-003 Slack consent carries the originating channel and thread", async () => {
  status({ kind: "connect" });
  const url = "https://slack.example.test/oauth/cargo";
  const submitted = context.mocks.deferred<unknown>();
  context.mocks.api(slackConnectContract.connect, ({ body, respond }) => {
    submitted.resolve(body);
    return respond(202, { authorizationUrl: url });
  });
  await setupPage({
    context,
    path: path + member + "&c=C_ORIGIN&t=42.0",
    host,
  });
  click(await findButton("Connect"));
  await waitFor(() => {
    expect(location.href).toBe(url);
  });
  await expect(submitted.promise).resolves.toStrictEqual({
    workspaceId: workspace,
    slackUserId: member,
    channelId: "C_ORIGIN",
    threadTs: "42.0",
    requestUserScopes: true,
  });
});

test("connector-provider-pages-004 an unauthorized Slack lookup leaves an error in place of Connect", async () => {
  const message = "Slack link status is unavailable.";
  context.mocks.api(slackConnectContract.getLinkStatus, ({ respond }) => {
    return respond(401, { error: { code: "UNAUTHORIZED", message } });
  });
  await setupPage({ context, path: path + member, host });
  await screen.findByText(message);
  expect(queryButton("Connect")).toBeNull();
});

test("connector-provider-pages-005 an admin-only workspace explains the rejected connection", async () => {
  status({ kind: "connect" });
  const message = "Only admins can connect this Slack workspace.";
  context.mocks.api(slackConnectContract.connect, ({ respond }) => {
    return respond(403, { error: { code: "FORBIDDEN", message } });
  });
  await setupPage({ context, path: path + member, host });
  click(await findButton("Connect"));
  await expect(screen.findByText(message)).resolves.toBeInTheDocument();
});

test("connector-provider-pages-008 switching explicitly authorizes the newly requested Slack member", async () => {
  const requested = "U_NEW_ACCOUNT",
    current = "U_CURRENT_ACCOUNT",
    url = "https://slack.example.test/oauth/new-member";
  status({
    kind: "slack_account_mismatch",
    requestedSlackUserId: requested,
    currentSlackUserId: current,
  });
  const submitted = context.mocks.deferred<unknown>();
  context.mocks.api(slackConnectContract.switchAccount, ({ body, respond }) => {
    submitted.resolve(body);
    return respond(202, { authorizationUrl: url });
  });
  await setupPage({ context, path: path + requested, host });
  await expect(findNamedLink("Keep " + current)).resolves.toBeInTheDocument();
  click(await findButton("Switch to " + requested));
  await waitFor(() => {
    expect(location.href).toBe(url);
  });
  await expect(submitted.promise).resolves.toStrictEqual({
    workspaceId: workspace,
    slackUserId: requested,
    requestUserScopes: true,
  });
});

test("connector-provider-pages-011 the signed Telegram invitation leads to the official bot", async () => {
  const identity = { telegramUserId: "82479", botUsername: "agent_bot" };
  let linked = false;
  context.mocks.api(
    integrationsTelegramContract.getLinkStatus,
    ({ respond }) => {
      return linked
        ? respond(200, { linked: true, ...identity })
        : respond(200, {
            linked: false,
            installation: {
              id: "official",
              botUsername: identity.botUsername,
              loginBotId: "731",
              domainConfigured: true,
            },
          });
    },
  );
  context.mocks.api(integrationsTelegramContract.link, ({ body, respond }) => {
    linked = body.connectSignature?.telegramUserId === identity.telegramUserId;
    return respond(200, identity);
  });
  await setupPage({
    context,
    host,
    path: `/telegram/connect?tgUser=82479&ts=1790000000&sig=${"ca".repeat(32)}`,
  });
  click(await findButton("Connect"));
  await screen.findByText("Connected to Telegram!");
  expect(
    screen.getByText("Send the bot a message in Telegram to start chatting."),
  ).toBeInTheDocument();
  const launch = await findNamedLink("Open Telegram");
  expect(launch).toHaveAttribute("target", "_blank");
  expect(launch).toHaveAttribute("href", "https://t.me/agent_bot");
  await expect(findNamedLink("Back to settings")).resolves.toHaveAttribute(
    "href",
    "/works",
  );
  expect(new URL(window.location.href).searchParams.has("sig")).toBeFalsy();
});
