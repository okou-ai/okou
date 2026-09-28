import { vncConnectionsContract } from "@okouai/api-contracts/contracts/vnc-connections";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import {
  context,
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import {
  installComposerConnectorFixture,
  SCOUT_AGENT_ID,
} from "./chat-composer-connectors-test-helpers.ts";
import {
  mockConnectors,
  mockPublicConnectorStatus,
} from "./connector-page-test-helpers.ts";

function mockCatalog() {
  mockConnectors(context, []);
  mockPublicConnectorStatus(context, []);
}

test.each([false, true])(
  "VNC is available in its layout's connection list (%s)",
  async (directory) => {
    mockCatalog();
    context.mocks.api(vncConnectionsContract.summary, ({ respond }) => {
      return respond(200, { configuredCount: 0 });
    });
    context.mocks.api(vncConnectionsContract.list, ({ respond }) => {
      return respond(200, { connections: [] });
    });
    await setupPage({
      context,
      path: directory
        ? "/connectors?scope=remote-control"
        : "/connectors?keywords=vnc",
      featureSwitches: {
        [FeatureSwitchKey.VncAccess]: true,
        [FeatureSwitchKey.ConnectorDirectory]: directory,
      },
    });
    expect(queryFastControl("button", "Manage VNC access")).toBeNull();
    if (directory) {
      await screen.findByRole("heading", { name: "VNC" });
    } else {
      await findFastControl("link", "Manage VNC");
      await screen.findByRole("heading", { name: "Remote access" });
    }
    expect(
      queryFastControl("link", "Manage VNC")?.getAttribute("href") ?? null,
    ).toBe(directory ? null : "/connectors?scope=remote-control&type=vnc");
    expect(queryFastControl("link", "Manage SSH hosts")).toBeNull();
  },
);

test.each([false])(
  "Feature-off VNC makes no requests in directory layout %s",
  async (directory) => {
    mockCatalog();
    context.mocks.api(vncConnectionsContract.summary, () => {
      throw new Error("Feature-off VNC must not dispatch owner requests");
    });
    await setupPage({
      context,
      path: directory ? "/connectors?scope=remote-control" : "/connectors",
      featureSwitches: {
        [FeatureSwitchKey.VncAccess]: false,
        [FeatureSwitchKey.ConnectorDirectory]: directory,
      },
    });
    if (directory) {
      await screen.findByRole("heading", { name: "SSH" });
    } else {
      await findFastControl("link", "Manage SSH hosts");
    }
    expect(screen.queryByRole("heading", { name: "VNC" })).toBeNull();
    expect(queryFastControl("link", "Manage VNC")).toBeNull();
  },
);

test.each([true])(
  "Chat VNC setup appears and filters in directory layout %s",
  async (directory) => {
    installComposerConnectorFixture();
    context.mocks.api(vncConnectionsContract.summary, ({ respond }) => {
      return respond(200, { configuredCount: 0 });
    });
    await setupPage({
      context,
      path: `/agents/${SCOUT_AGENT_ID}/chat`,
      featureSwitches: {
        [FeatureSwitchKey.VncAccess]: true,
        [FeatureSwitchKey.ConnectorDirectory]: directory,
      },
    });
    click(await findFastControl("button", "Connectors"));
    click(await findFastControl("button", "Add connectors"));
    const search = await screen.findByPlaceholderText("Find connectors...");
    const dialog = search.closest('[role="dialog"]');
    if (!(dialog instanceof HTMLElement)) {
      throw new Error("Missing connector dialog");
    }
    await findFastControl("link", "Manage VNC", dialog);
    await fill(search, "vnc");
    await expect(
      findFastControl("link", "Manage VNC", dialog),
    ).resolves.toHaveAttribute(
      "href",
      "/connectors?scope=remote-control&type=vnc",
    );
    expect(queryFastControl("link", "Manage SSH hosts", dialog)).toBeNull();
  },
);

test.each([true])(
  "Chat VNC discovery can retry a failed summary inside directory layout %s",
  async (directory) => {
    installComposerConnectorFixture();
    let failed = true;
    const recovery = context.mocks.deferred<void>();
    context.mocks.api(vncConnectionsContract.summary, async ({ respond }) => {
      if (failed) {
        return respond(500, {
          error: { code: "INTERNAL_ERROR", message: "private VNC error" },
        });
      }
      await recovery.promise;
      return respond(200, { configuredCount: 0 });
    });
    await setupPage({
      context,
      path: `/agents/${SCOUT_AGENT_ID}/chat`,
      featureSwitches: {
        [FeatureSwitchKey.VncAccess]: true,
        [FeatureSwitchKey.ConnectorDirectory]: directory,
      },
    });
    click(await findFastControl("button", "Connectors"));
    click(await findFastControl("button", "Add connectors"));
    const search = await screen.findByPlaceholderText("Find connectors...");
    const dialog = search.closest('[role="dialog"]');
    if (!(dialog instanceof HTMLElement)) {
      throw new Error("Missing connector dialog");
    }
    await fill(search, "vnc");
    await expect(
      within(dialog).findByText("Could not load VNC configuration."),
    ).resolves.toBeInTheDocument();
    expect(within(dialog).queryByText("No connector matches “vnc”")).toBeNull();
    expect(dialog.textContent).not.toContain("private VNC error");
    failed = false;
    click(await findFastControl("button", "Retry", dialog));
    await expect(
      within(dialog).findByText("Loading VNC configuration…"),
    ).resolves.toBeInTheDocument();
    expect(within(dialog).queryByText("No connector matches “vnc”")).toBeNull();
    recovery.resolve();
    await expect(
      findFastControl("link", "Manage VNC", dialog),
    ).resolves.toHaveAttribute(
      "href",
      "/connectors?scope=remote-control&type=vnc",
    );
    expect(
      within(dialog).queryByText("Could not load VNC configuration."),
    ).toBeNull();
  },
);
