import {
  chatRemoteAccessContract,
  type ThreadRemoteHostAccess,
} from "@okouai/api-contracts/contracts/chat-remote-access";
import { remotesContract } from "@okouai/api-contracts/contracts/remotes";
import { act, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
const context = testContext();

async function twoHosts(
  options: {
    initiallyOn?: boolean;
    rejectChanges?: boolean;
  } = {},
) {
  const thread = crypto.randomUUID();
  const hosts = ["MacinCloud", "Other tunnel"].map((displayName, index) => {
    return {
      connectionId: crypto.randomUUID(),
      displayName,
      defaultEnabled: index === 0 && Boolean(options.initiallyOn),
    };
  });
  const saved = new Map<string, boolean>();
  const requested = context.mocks.deferred<void>(),
    save = context.mocks.deferred<void>(),
    refreshing = context.mocks.deferred<void>(),
    refresh = context.mocks.deferred<void>();
  let confirm = false;
  function row(host: (typeof hosts)[number]): ThreadRemoteHostAccess {
    const override = saved.get(host.connectionId);
    return {
      ...host,
      enabled: override ?? host.defaultEnabled,
      overrideEnabled: override ?? null,
      source: override === undefined ? "default" : "override",
    };
  }
  mockChatLifecycle(context, { threadId: thread });
  context.mocks.api(remotesContract.overview, ({ respond }) => {
    return respond(200, {
      computerUseHosts: [],
      cloudBrowserEnabledByDefault: false,
      cloudBrowserAvailable: false,
      sshHosts: hosts,
      vncHosts: [],
    });
  });
  context.mocks.api(
    chatRemoteAccessContract.listThreadAccess,
    async ({ respond }) => {
      if (confirm) {
        if (!refreshing.settled()) {
          refreshing.resolve();
        }
        await refresh.promise;
      }
      return respond(200, { ssh: hosts.map(row), vnc: [] });
    },
  );
  context.mocks.api(
    chatRemoteAccessContract.setThreadOverride,
    async ({ params, body, respond }) => {
      if (!requested.settled()) {
        requested.resolve();
      }
      await save.promise;
      if (options.rejectChanges) {
        return respond(503, {
          error: {
            code: "UNAVAILABLE",
            message: "Permission update not confirmed",
          },
        });
      }
      saved.set(params.connectionId, body.enabled);
      confirm = true;
      return respond(
        200,
        row(
          hosts.find((h) => {
            return h.connectionId === params.connectionId;
          })!,
        ),
      );
    },
  );
  const media = context.mocks.browser.matchMedia(true);
  await setupPage({ context, path: "/chats/" + thread });
  const trigger = await findFastControl("button", "Connectors");
  async function open() {
    if (!queryFastControl("button", /Remote access/)) {
      click(await findFastControl("button", "Connectors"));
    }
    click(await findFastControl("button", /Remote access/));
    const dialog = await screen.findByRole("dialog", { name: "Remote access" });
    await within(dialog).findByRole("combobox", { name: "SSH MacinCloud" });
    return dialog;
  }
  return {
    open,
    trigger,
    media,
    ready: requested.promise,
    save,
    refresh,
    refreshing: refreshing.promise,
  };
}
const fields = (dialog: HTMLElement) => {
  return ["MacinCloud", "Other tunnel"].map((name) => {
    return within(dialog).getByRole("combobox", { name: "SSH " + name });
  });
};
async function choice(el: HTMLElement, value: string) {
  click(el);
  click(await screen.findByRole("option", { name: value }));
}
async function close(dialog: HTMLElement) {
  click(await findFastControl("button", "Close", dialog));
  await waitFor(() => {
    return expect(dialog).not.toBeInTheDocument();
  });
}
test("chat-composer-vnc-dependencies-009 Dismissing during an SSH save restores focus twice and reopening shows the confirmed On choice", async () => {
  const session = await twoHosts({ initiallyOn: true });
  let dialog = await session.open();
  await choice(fields(dialog)[0]!, "On");
  await session.ready;
  await close(dialog);
  await waitFor(() => {
    return expect(session.trigger).toHaveFocus();
  });
  session.save.resolve();
  session.refresh.resolve();
  dialog = await session.open();
  await waitFor(() => {
    return expect(fields(dialog)[0]).toHaveTextContent(/^On$/);
  });
  await close(dialog);
  await waitFor(() => {
    return expect(session.trigger).toHaveFocus();
  });
});
test("chat-composer-vnc-dependencies-008 A failed change restores the inherited host and keeps the other host usable after reloading permissions", async () => {
  const session = await twoHosts({
    initiallyOn: true,
    rejectChanges: true,
  });
  const dialog = await session.open(),
    [build, other] = fields(dialog),
    user = userEvent.setup({ delay: null });
  await choice(build!, "On");
  await session.ready;
  build!.focus();
  await user.keyboard("{Tab}");
  expect(other).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(screen.queryByRole("listbox")).toBeNull();
  session.save.resolve();
  await expect(
    within(dialog).findByText(/Couldn't confirm whether your change was saved/),
  ).resolves.toBeVisible();
  expect(build).toHaveTextContent(/Default.*On/);
  click(await findFastControl("button", "Reload", dialog));
  await waitFor(() => {
    return expect(other).not.toHaveAttribute("aria-readonly", "true");
  });
  expect(other).toHaveFocus();
  await choice(other!, "On");
  await within(dialog).findByText(
    /Couldn.t confirm whether your change was saved/,
  );
  await waitFor(() => {
    return expect(other).toHaveTextContent(/Default.*Off/);
  });
});
test("chat-composer-ssh-004 Resizing and reopening during a save keeps both choices read-only, preserves focus, and permits the second change after confirmation", async () => {
  const session = await twoHosts({ initiallyOn: true });
  let dialog = await session.open();
  await choice(fields(dialog)[0]!, "Off");
  await session.ready;
  act(() => {
    return session.media.setMatches((q) => {
      return q.includes("max-width");
    });
  });
  dialog = await waitFor(() => {
    const el = screen.getByRole("dialog", { name: "Remote access" });
    expect(el).toHaveAttribute("data-slot", "drawer-popup");
    return el;
  });
  for (const el of fields(dialog)) {
    expect(el).toHaveAttribute("aria-readonly", "true");
  }
  await close(dialog);
  act(() => {
    return session.media.setMatches((q) => {
      return q.includes("min-width");
    });
  });
  dialog = await session.open();
  const [first, second] = fields(dialog);
  expect(first).toHaveAttribute("aria-readonly", "true");
  expect(second).toHaveAttribute("aria-readonly", "true");
  second!.focus();
  await userEvent.setup({ delay: null }).keyboard("{Enter}");
  expect(screen.queryByRole("listbox")).toBeNull();
  session.save.resolve();
  await session.refreshing;
  session.refresh.resolve();
  await waitFor(() => {
    return expect(first).toHaveTextContent(/^Off$/);
  });
  expect(second).toHaveTextContent(/Default.*Off/);
  for (const el of fields(dialog)) {
    expect(el).not.toHaveAttribute("aria-readonly", "true");
  }
  expect(second).toHaveFocus();
  await choice(second!, "On");
  await waitFor(() => {
    return expect(second).toHaveTextContent(/^On$/);
  });
});
