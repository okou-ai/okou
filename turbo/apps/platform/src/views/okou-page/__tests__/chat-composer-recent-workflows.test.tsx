import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { setupPage, click, fill } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  createChatRunFixtures,
  completedEvent,
  promptEvent,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";
import { findAction } from "./connector-integrations-test-helpers.ts";
import {
  workflowOptions,
  slashChoice,
  slashRows,
} from "./workflow-composer-boundary.ts";

const context = testContext();

function defaultNames() {
  return ["alpha", "beta", "charlie", "delta", "echo", "zulu"];
}
const key = "okou_recent-workflows";
// A browser-owned storage area shared by the app and the simulated second tab.

function installBrowserStorage() {
  const storage = new Storage();
  vi.spyOn(window, "localStorage", "get").mockReturnValue(storage);
  return storage;
}

function order() {
  return slashRows().map((row) => {
    return row.textContent?.slice(1);
  });
}

function message() {
  return screen.findByLabelText("Message");
}

async function reveal() {
  click(await screen.findByText(/Show 2 more/));
}

test("chat-composer-recent-workflows-002 an abandoned Echo selection keeps the four default recommendations", async () => {
  const existing = "b0000000-0000-4000-a000-000000000920";
  const path = "/chats/" + existing;
  createChatRunFixtures(context).installRunChat({ threadId: existing });
  workflowOptions(context, defaultNames());
  await setupPage({ context, path });
  const editor = await message();
  await fill(editor, "/");
  await slashChoice("alpha");
  await reveal();
  click(await slashChoice("echo"));
  expect(editor).toHaveTextContent("/echo");
  await fill(editor, "Next /");
  await slashChoice("alpha");
  expect(order()).toStrictEqual(defaultNames().slice(0, 4));
  expect(location.pathname).toBe(path);
});

test("chat-composer-recent-workflows-008 a pending send cannot reorder an open or expanded overview", async () => {
  const storage = installBrowserStorage();
  const gate = context.mocks.deferred<void>();
  createChatRunFixtures(context).installRunChat({ sendGate: gate.promise });
  const choices = workflowOptions(context, defaultNames());
  await setupPage({ context, path: RUN_PATH });
  const editor = await message();
  await fill(editor, "/zulu");
  click(await slashChoice("zulu"));
  click(await findAction("button", "Send"));
  try {
    await waitFor(() => {
      return expect(editor.textContent?.trim()).toBe("");
    });
    await fill(editor, "/");
    await slashChoice("alpha");
    expect(order()).toStrictEqual(defaultNames().slice(0, 4));
    gate.resolve();
    await waitFor(() => {
      return expect(storage.getItem(key)).toContain(choices[5].id);
    });
    expect(order()).toStrictEqual(defaultNames().slice(0, 4));
    await reveal();
    expect(order()).toStrictEqual(defaultNames());
    await fill(editor, "");
    await fill(editor, "/");
    await slashChoice("zulu");
    expect(order()).toStrictEqual(["zulu", "alpha", "beta", "charlie"]);
  } finally {
    if (!gate.settled()) {
      gate.resolve();
    }
  }
});

test("chat-composer-recent-workflows-009 a send preserves history written by a second tab", async () => {
  const storage = installBrowserStorage();
  createChatRunFixtures(context).installRunChat();
  const entries = workflowOptions(context, defaultNames());
  const ids = entries.map((w) => {
    return w.id;
  });
  storage.setItem(key, JSON.stringify([ids[5]]));
  await setupPage({ context, path: RUN_PATH });
  const editor = await message();
  await fill(editor, "/");
  await slashChoice("zulu");
  expect(order()[0]).toBe("zulu");
  storage.setItem(key, JSON.stringify([ids[4], ids[5]]));
  await fill(editor, "/delta");
  click(await slashChoice("delta"));
  click(await findAction("button", "Send"));
  await waitFor(() => {
    return expect(storage.getItem(key)).toContain(ids[3]);
  });
  await fill(editor, "/");
  await slashChoice("delta");
  expect(order()).toStrictEqual(["delta", "echo", "zulu", "alpha"]);
});

test("chat-composer-recent-workflows-012 prefix, recency and fuzzy matches rank independently before keyboard selection", async () => {
  const storage = installBrowserStorage();
  createChatRunFixtures(context).installRunChat();
  const names = [
    "report",
    "team-pr-auto",
    "pr-auto",
    "pr-auto-deploy",
    "pr-audit",
    "presentation-restart-auto",
  ];
  const entries = workflowOptions(context, names, {
    report: "Publish a pr-auto summary",
  });
  storage.setItem(
    key,
    JSON.stringify(
      entries.slice(0, 4).map((e) => {
        return e.id;
      }),
    ),
  );
  await setupPage({ context, path: RUN_PATH });
  const editor = await message();
  await fill(editor, "/Pr-A");
  await slashChoice("pr-auto");
  expect(order()).toStrictEqual([
    "pr-auto",
    "pr-auto-deploy",
    "pr-audit",
    "team-pr-auto",
    "report",
    "presentation-restart-auto",
  ]);
  await fill(editor, "/pr-auto-deploy");
  await waitFor(() => {
    return expect(order()).toStrictEqual(["pr-auto-deploy"]);
  });
  await userEvent.keyboard("{Enter}");
  expect(editor).toHaveTextContent("/pr-auto-deploy");
  expect(screen.queryByTestId("slash-workflow-menu")).not.toBeInTheDocument();
});

test("chat-composer-recent-workflows-013 recent Beta outranks repeated Delta on desktop and mobile", async () => {
  const storage = installBrowserStorage();
  const desktopQuery = "(min-width: 48rem)";
  const media = context.mocks.browser.matchMedia((query) => {
    return query === desktopQuery;
  });
  const entries = workflowOptions(
    context,
    defaultNames().map((n) => {
      return "qz-" + n;
    }),
  );
  createChatRunFixtures(context).installRunChat();
  await setupPage({ context, path: RUN_PATH });
  const editor = await message();
  for (const [index, name] of ["qz-delta", "qz-delta", "qz-beta"].entries()) {
    await fill(editor, "/" + name);
    click(await slashChoice(name));
    await userEvent.setup({ delay: null }).paste(" note " + index);
    click(await findAction("button", "Send"));
    await waitFor(() => {
      return expect(editor.textContent?.trim()).toBe("");
    });
    await screen.findByText(new RegExp("note " + index));
    await waitFor(() => {
      return expect(JSON.parse(storage.getItem(key) ?? "[]")[0]).toBe(
        entries.find((w) => {
          return w.name === name;
        })?.id,
      );
    });
  }
  for (const desktop of [true, false]) {
    media.setMatches((query) => {
      return desktop && query === desktopQuery;
    });
    await fill(editor, "/qz");
    const beta = await slashChoice("qz-beta");
    expect(order()[0]).toBe("qz-beta");
    expect(beta).toHaveAttribute("data-active", "true");
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(editor).toHaveTextContent("/qz-delta");
    expect(screen.queryByTestId("slash-workflow-menu")).not.toBeInTheDocument();
  }
});

test("chat-composer-recent-workflows-015 keyboard selection survives completion of a pending Delta send", async () => {
  const storage = installBrowserStorage();
  const gate = context.mocks.deferred<void>();
  const names = defaultNames().map((n) => {
    return "qz-" + n;
  });
  const entries = workflowOptions(context, names);
  const past = crypto.randomUUID();
  createChatRunFixtures(context).installRunChat({
    chatEvents: [
      promptEvent({
        id: crypto.randomUUID(),
        runId: past,
        seqId: 1,
        text: "/qz-delta",
      }),
      completedEvent({ id: crypto.randomUUID(), runId: past, seqId: 2 }),
    ],
    sendGate: gate.promise,
  });
  await setupPage({ context, path: RUN_PATH });
  await screen.findByText("/qz-delta");
  const editor = await message();
  await fill(editor, "/qz-delta");
  click(await slashChoice("qz-delta"));
  click(await findAction("button", "Send"));
  try {
    await waitFor(() => {
      return expect(editor.textContent?.trim()).toBe("");
    });
    await fill(editor, "/qz");
    await slashChoice("qz-alpha");
    expect(order()).toStrictEqual(names);
    await userEvent.keyboard("{ArrowDown}");
    const beta = await slashChoice("qz-beta");
    expect(beta).toHaveAttribute("data-active", "true");
    gate.resolve();
    await waitFor(() => {
      return expect(storage.getItem(key)).toContain(entries[3].id);
    });
    expect(order()).toStrictEqual(names);
    expect(beta).toHaveAttribute("data-active", "true");
    await userEvent.keyboard("{Enter}");
    expect(editor).toHaveTextContent("/qz-beta");
    expect(screen.queryByTestId("slash-workflow-menu")).not.toBeInTheDocument();
    await fill(editor, "/qz");
    await slashChoice("qz-delta");
    expect(order()[0]).toBe("qz-delta");
  } finally {
    if (!gate.settled()) {
      gate.resolve();
    }
  }
});
