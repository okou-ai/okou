import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  chatRemoteAccessContract,
  type ThreadRemoteHostAccess,
} from "@okouai/api-contracts/contracts/chat-remote-access";
import { remotesContract } from "@okouai/api-contracts/contracts/remotes";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import {
  createComposerConnectorHelpers,
  SCOUT_THREAD_ID,
} from "./chat-composer-connectors-test-helpers.ts";

const context = testContext();
const { installComposerConnectorFixture } =
  createComposerConnectorHelpers(context);

function inventory({
  count = 1,
  commitBeforeError = false,
  accessReady,
}: {
  count?: number;
  commitBeforeError?: boolean;
  accessReady?: Promise<void>;
} = {}) {
  installComposerConnectorFixture({ threadId: SCOUT_THREAD_ID });
  const settings = Array.from({ length: count }, (_, index) => {
    return {
      connectionId: `b0000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      displayName: `Host ${index + 1}`,
      defaultEnabled: index === 0,
    };
  });
  const overrides = new Map<string, boolean>();
  const read = (connectionId: string): ThreadRemoteHostAccess => {
    const setting = settings.find((host) => {
      return host.connectionId === connectionId;
    });
    if (!setting) {
      throw new Error(`Unknown fixture connection ${connectionId}`);
    }
    const overrideEnabled = overrides.get(connectionId) ?? null;
    return {
      ...setting,
      overrideEnabled,
      enabled: overrideEnabled ?? setting.defaultEnabled,
      source: overrideEnabled === null ? "default" : "override",
    };
  };
  context.mocks.api(remotesContract.overview, ({ respond }) => {
    return respond(200, {
      computerUseHosts: [],
      cloudBrowserAvailable: true,
      cloudBrowserEnabledByDefault: true,
      sshHosts: settings,
      vncHosts: [],
    });
  });
  context.mocks.api(
    chatRemoteAccessContract.listThreadAccess,
    async ({ respond }) => {
      await accessReady;
      return respond(200, {
        ssh: settings.map((host) => {
          return read(host.connectionId);
        }),
        vnc: [],
      });
    },
  );
  context.mocks.api(
    chatRemoteAccessContract.setThreadOverride,
    ({ params, body, respond }) => {
      overrides.set(params.connectionId, body.enabled);
      if (commitBeforeError) {
        return respond(500, {
          error: {
            code: "INTERNAL_ERROR",
            message: "Response unavailable after commit",
          },
        });
      }
      return respond(200, read(params.connectionId));
    },
  );
}

async function open() {
  await setupPage({ context, path: `/chats/${SCOUT_THREAD_ID}` });
  click(await findFastControl("button", "Connectors"));
  click(await screen.findByText("Remote access"));
  return await screen.findByRole("dialog", { name: "Remote access" });
}

test("Allowed filtering retains a changed connection and keyboard focus until the filter changes", async () => {
  inventory({ count: 12 });
  const dialog = await open();
  await within(dialog).findByRole("combobox", { name: "SSH Host 12" });
  click(await findFastControl("button", "Allowed1", dialog));
  const control = within(dialog).getByRole("combobox", { name: "SSH Host 1" });
  expect(within(dialog).getAllByRole("combobox")).toHaveLength(1);
  const user = userEvent.setup({ delay: null });
  control.focus();
  await user.keyboard("{Enter}");
  await screen.findByRole("option", { name: "Off" });
  await user.keyboard("{End}{Enter}");
  await within(dialog).findByText("Saved for this chat");
  expect(control).toHaveTextContent("Off");
  expect(control).toHaveFocus();
  expect(
    within(dialog).getByText(
      "Changed connections stay visible until you switch filters",
    ),
  ).toBeInTheDocument();
  click(await findFastControl("button", "All12", dialog));
  expect(within(dialog).getAllByRole("combobox")).toHaveLength(12);
  click(await findFastControl("button", "Allowed0", dialog));
  expect(
    within(dialog).getByText("No connections are allowed in this chat"),
  ).toBeInTheDocument();
  click(await findFastControl("button", "Show all connections", dialog));
  expect(within(dialog).getAllByRole("combobox")).toHaveLength(12);
});

test("An unconfirmed write is reconciled by reading saved permissions before another change", async () => {
  inventory({ commitBeforeError: true });
  const dialog = await open();
  const control = await within(dialog).findByRole("combobox", {
    name: "SSH Host 1",
  });
  click(control);
  click(await screen.findByRole("option", { name: "Off" }));
  await within(dialog).findByText(
    "Couldn't confirm whether your change was saved. Reload permissions before making another change.",
  );
  expect(control).toHaveTextContent("Default (On)");
  expect(control).toHaveAttribute("aria-readonly", "true");
  click(await findFastControl("button", "Reload", dialog));
  await waitFor(() => {
    expect(control).toHaveTextContent("Off");
    expect(control).not.toHaveAttribute("aria-readonly", "true");
  });
  expect(
    within(dialog).getByText("SSH · Not allowed · This chat"),
  ).toBeInTheDocument();
});

test("A pending permission read shows loading rather than exposing default permissions", async () => {
  const ready = context.mocks.deferred<void>();
  inventory({ accessReady: ready.promise });
  const dialog = await open();
  await within(dialog).findByRole("status", { name: "Loading remote access…" });
  ready.resolve();
  const control = await within(dialog).findByRole("combobox", {
    name: "SSH Host 1",
  });
  expect(control).toHaveTextContent("Default (On)");
  expect(
    within(dialog).getByText("SSH · Allowed · Default"),
  ).toBeInTheDocument();
});
