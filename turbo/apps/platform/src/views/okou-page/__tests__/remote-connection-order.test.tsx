import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import {
  createComposerConnectorHelpers,
  SCOUT_AGENT_ID,
  SCOUT_THREAD_ID,
} from "./chat-composer-connectors-test-helpers.ts";
import {
  mockConnectors,
  mockPublicConnectorStatus,
} from "./connector-page-test-helpers.ts";
import {
  mockHostInventories,
  mockRemoteChoices,
  orderedNames,
  sshHosts,
} from "./remote-resource-order-test-helpers.ts";

const context = testContext();
const { installComposerConnectorFixture } =
  createComposerConnectorHelpers(context);
const orderedVncNames = orderedNames.map((name) => {
  return `desktop-${name}`;
});

test("Remote host names follow the active Chinese locale", async () => {
  mockConnectors(context, []);
  mockPublicConnectorStatus(context, []);
  mockHostInventories(context);
  const names = ["上海-11", "广州-2", "北京"];
  context.mocks.api(sshConnectionsContract.list, ({ respond }) => {
    return respond(200, {
      connections: sshHosts.slice(0, 3).map((host, index) => {
        return { ...host, displayName: names[index]! };
      }),
    });
  });
  await setupPage({
    context,
    path: "/connectors?scope=remote-control",
    locale: "zh-Hans",
  });
  const list = await screen.findByRole("list", { name: "Remote connections" });
  await within(list).findByRole("listitem", { name: "北京" });
  expect(
    within(list)
      .getAllByRole("listitem")
      .slice(0, 3)
      .map((item) => {
        return item.getAttribute("aria-label");
      }),
  ).toStrictEqual(["北京", "广州-2", "上海-11"]);
});

test("Remote connections use natural name order", async () => {
  mockConnectors(context, []);
  mockPublicConnectorStatus(context, []);
  mockHostInventories(context);
  mockRemoteChoices(context);
  await setupPage({
    context,
    path: "/connectors?scope=remote-control",
  });
  const list = await screen.findByRole("list", {
    name: "Remote connections",
  });
  await within(list).findByRole("listitem", { name: "android" });
  await within(list).findByRole("listitem", { name: "desktop-android" });
  const renderedNames = within(list)
    .getAllByRole("listitem")
    .map((item) => {
      return item.getAttribute("aria-label");
    });
  expect(renderedNames).toStrictEqual([...orderedNames, ...orderedVncNames]);
});

test.each([false, true])(
  "A chat groups remote choices by effective access and name with existing thread %s",
  async (existing) => {
    installComposerConnectorFixture(
      existing ? { threadId: SCOUT_THREAD_ID } : {},
    );
    mockHostInventories(context);
    mockRemoteChoices(context);
    await setupPage({
      context,
      path: existing
        ? `/chats/${SCOUT_THREAD_ID}`
        : `/agents/${SCOUT_AGENT_ID}/chat`,
    });
    click(await findFastControl("button", "Connectors"));
    const computers = await screen.findByRole("group", {
      name: "Computer Use hosts",
    });
    expect(
      within(computers)
        .getAllByRole("switch")
        .map((control) => {
          return control.closest("label")?.textContent?.trim();
        }),
    ).toStrictEqual(orderedNames);
    click(await screen.findByText("Remote access"));
    const dialog = screen.getByRole("dialog", { name: "Remote access" });
    await within(dialog).findByRole("combobox", { name: "SSH android" });
    const sshSection = within(dialog).getByRole("region", { name: "SSH" });
    const vncSection = within(dialog).getByRole("region", { name: "VNC" });
    expect(
      within(sshSection)
        .getAllByRole("heading")
        .map((heading) => {
          return heading.textContent;
        }),
    ).toStrictEqual(["SSH", "Enabled", "Disabled"]);
    expect(
      within(vncSection)
        .getAllByRole("heading")
        .map((heading) => {
          return heading.textContent;
        }),
    ).toStrictEqual(["VNC", "Disabled"]);
    const groupedSshNames = existing
      ? ["dev-2", "dev-11", "android", "DEV-1", "dev-1"]
      : ["dev-11", "android", "DEV-1", "dev-1", "dev-2"];
    expect(
      within(dialog)
        .getAllByRole("combobox")
        .map((control) => {
          return control.getAttribute("aria-label");
        }),
    ).toStrictEqual([
      ...groupedSshNames.map((name) => {
        return `SSH ${name}`;
      }),
      ...orderedVncNames.map((name) => {
        return `VNC ${name}`;
      }),
    ]);
    expect(
      within(dialog).getByRole("combobox", { name: "SSH dev-11" }),
    ).toHaveTextContent("Default (On)");
    expect(
      within(dialog).getByRole("combobox", { name: "SSH dev-2" }),
    ).toHaveTextContent(existing ? "On" : "Default (Off)");
  },
);
