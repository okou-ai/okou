import {
  chatConnectorAccessContract,
  type ChatConnectorAccess,
} from "@okouai/api-contracts/contracts/chat-connector-access";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { setupPage, click, fill } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  builtinConnector,
  connectorAccount,
  chatConnectorOverviewFixture,
  createComposerConnectorHelpers,
  SCOUT_THREAD_ID,
  OTHER_THREAD_ID,
} from "./chat-composer-connectors-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
const context = testContext();
const target = { kind: "builtin", connectorSlug: "github" } as const;
const work = "cf790000-0000-4000-a000-000000000001";
const personal = "cf790000-0000-4000-a000-000000000002";

async function openChat(
  options: {
    path?: string;
    defaults?: readonly boolean[];
    failSelection?: boolean;
  } = {},
) {
  const defaults = options.defaults ?? [true];
  const accounts = defaults.map((_enabled, i) => {
    return connectorAccount({
      id: i === 0 ? work : personal,
      target,
      displayName: i === 0 ? "Work" : "Personal",
      isDefault: i === 0,
    });
  });
  const overrides = new Map<string, boolean>();
  let current: string | null = defaults[0] ? work : null;
  let reject = options.failSelection;
  function access(): ChatConnectorAccess {
    return {
      target,
      accounts: accounts.map((a, i) => {
        return {
          connectionId: a.id,
          displayName: a.displayName,
          defaultEnabled: defaults[i] ?? false,
          isDefault: a.isDefault,
          overrideEnabled: overrides.get(a.id) ?? null,
          enabled: overrides.get(a.id) ?? defaults[i] ?? false,
        };
      }),
      currentConnectionId: current,
      available: true,
    };
  }
  const atRun: ChatConnectorAccess[] = [];
  createComposerConnectorHelpers(context).installComposerConnectorFixture({
    threadId: SCOUT_THREAD_ID,
    threads: [
      { id: SCOUT_THREAD_ID, title: "Repository review" },
      { id: OTHER_THREAD_ID, title: "Release planning" },
    ],
    catalog: [builtinConnector({ slug: "github", label: "GitHub" })],
    accounts,
    onFirstRun: () => {
      atRun.push(access());
    },
  });
  const overview = () => {
    return chatConnectorOverviewFixture({
      target,
      label: "GitHub",
      accounts,
      access: access(),
    });
  };
  context.mocks.api(chatConnectorAccessContract.overview, ({ respond }) => {
    return respond(200, [overview()]);
  });
  context.mocks.api(
    chatConnectorAccessContract.overviewTarget,
    ({ respond }) => {
      return respond(200, { connector: overview() });
    },
  );
  context.mocks.api(
    chatConnectorAccessContract.accountDefaults,
    ({ respond }) => {
      return respond(
        200,
        access().accounts.map(
          ({ connectionId, displayName, defaultEnabled, isDefault }) => {
            return {
              connectionId,
              displayName,
              defaultEnabled,
              isDefault,
            };
          },
        ),
      );
    },
  );
  context.mocks.api(chatConnectorAccessContract.getThread, ({ respond }) => {
    return respond(200, access());
  });

  context.mocks.api(
    chatConnectorAccessContract.setThreadOverride,
    ({ params, body, respond }) => {
      if (body.enabled !== null) {
        overrides.set(params.connectionId, body.enabled);
      }
      return respond(200, access());
    },
  );
  context.mocks.api(
    chatConnectorAccessContract.setThreadCurrent,
    ({ body, respond }) => {
      if (reject) {
        reject = false;
        return respond(400, {
          error: {
            code: "SAVE_FAILED",
            message: "Account access could not be saved",
          },
        });
      }
      current = body.connectionId;
      return respond(200, access());
    },
  );
  await setupPage({
    context,
    path: options.path ?? "/chats/" + SCOUT_THREAD_ID,
  });
  return { atRun };
}
const openConnectors = (root: ParentNode = document.body) => {
  return findFastControl("button", "Connectors", root);
};
async function choices(root: ParentNode = document.body) {
  const trigger = await openConnectors(root);
  click(trigger);
  const row = await findFastControl("button", /GitHub/);
  click(row);
  const panel = await screen.findByRole("dialog", { name: "GitHub" });
  return { row, panel, trigger };
}
function toggle(panel: HTMLElement, name: string) {
  return within(panel).findByRole("switch", { name: name + " access" });
}
test("chat-composer-chat-connector-access-011 Managing the saved Work account returns to the original composer and its draft", async () => {
  await openChat();
  const editor = await findComposerEditor();
  const text = "Use my personal GitHub account.";
  await fill(editor, text);
  const { panel, trigger } = await choices();
  click(await findFastControl("button", "Manage accounts", panel));
  const dialog = await screen.findByRole("dialog", {
    name: "Manage GitHub accounts",
  });
  await within(dialog).findByText("Work");
  await findFastControl("button", "Add account", dialog);
  const user = userEvent.setup({ delay: null });
  await user.keyboard("{Escape}");
  await waitFor(() => {
    return expect(trigger).toHaveFocus();
  });
  expect(location.pathname).toBe("/chats/" + SCOUT_THREAD_ID);
  expect(editor).toHaveTextContent(text);
  const reopened = await choices();
  await expect(toggle(reopened.panel, "Work")).resolves.toHaveAttribute(
    "aria-checked",
    "true",
  );
});
test("chat-composer-chat-connector-access-013 Each pane opens and dismisses its own single GitHub account manager", async () => {
  await openChat({
    path: "/chats/" + SCOUT_THREAD_ID + "?sidebar=" + OTHER_THREAD_ID,
  });
  const user = userEvent.setup({ delay: null });
  for (const id of [SCOUT_THREAD_ID, OTHER_THREAD_ID, SCOUT_THREAD_ID]) {
    const pane = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(
        '[data-chat-thread-container-id="' + id + '"]',
      );
      if (!el) {
        throw new Error("Missing chat pane " + id);
      }
      return el;
    });
    const { panel, trigger } = await choices(pane);
    click(await findFastControl("button", "Manage accounts", panel));
    const dialog = await screen.findByRole("dialog", {
      name: "Manage GitHub accounts",
    });
    await within(dialog).findByText("Work");
    expect(
      screen.getAllByRole("dialog", { name: "Manage GitHub accounts" }),
    ).toHaveLength(1);
    await user.keyboard("{Escape}");
    await waitFor(() => {
      return expect(trigger).toHaveFocus();
    });
  }
});
async function firstMessage(
  defaults: readonly boolean[],
  failSelection = false,
) {
  const { atRun } = await openChat({
    path: "/?compose=1",
    defaults,
    failSelection,
  });
  const text = "Use my personal GitHub account";
  const editor = await findComposerEditor();
  await fill(editor, text);
  const { panel } = await choices();
  const mine = await toggle(panel, "Personal");
  click(mine);
  await waitFor(() => {
    return expect(mine).toHaveAttribute("aria-checked", "true");
  });
  const org = await toggle(panel, "Work");
  click(org);
  await waitFor(() => {
    return expect(org).toHaveAttribute(
      "aria-checked",
      defaults[0] ? "false" : "true",
    );
  });
  const user = userEvent.setup({ delay: null });
  await user.keyboard("{Escape}{Escape}");
  await user.click(editor);
  await user.keyboard("{Enter}");
  return { atRun, user, editor, text };
}
async function resultingConversation(
  atRun: ChatConnectorAccess[],
  text: string,
  workEnabled: boolean,
) {
  await screen.findByText(text, { exact: true });
  await waitFor(() => {
    return expect(location.pathname).toMatch(/^\/chats\//);
  });
  expect(
    atRun.map((x) => {
      return [
        x.currentConnectionId,
        ...x.accounts.map((a) => {
          return a.enabled;
        }),
      ];
    }),
  ).toStrictEqual([[personal, workEnabled, true]]);
  const { panel, row } = await choices();

  await expect(toggle(panel, "Personal")).resolves.toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(toggle(panel, "Work")).resolves.toHaveAttribute(
    "aria-checked",
    String(workEnabled),
  );
  return row;
}
test("chat-composer-chat-connector-access-016 Enabling Personal first keeps it selected for the new run after both accounts are allowed", async () => {
  const { atRun, text } = await firstMessage([false, false]);
  await expect(
    resultingConversation(atRun, text, true),
  ).resolves.toHaveTextContent("2 accounts");
});
test("chat-composer-chat-connector-access-017 The new run sees the confirmed Personal choice and the new thread retains both overrides", async () => {
  const { atRun, text } = await firstMessage([true, false]);
  await expect(
    resultingConversation(atRun, text, false),
  ).resolves.toHaveTextContent("2 accounts");
});
test("chat-composer-chat-connector-access-018 Retrying a rejected account save retains the prompt and starts with Personal selected", async () => {
  const { atRun, user, editor, text } = await firstMessage([true, false], true);
  await screen.findByText("Account access could not be saved");
  expect(location.pathname).toBe("/");
  expect(editor).toHaveTextContent(text);
  expect(atRun).toStrictEqual([]);
  await user.click(editor);
  await user.keyboard("{Enter}");
  await expect(
    resultingConversation(atRun, text, false),
  ).resolves.toHaveTextContent("2 accounts");
});
