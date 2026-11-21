import { test, expect } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  chatListThread,
  installChatListStream,
} from "./chat-list-test-helpers.ts";
import {
  findAction,
  getAction,
  queryAction,
} from "./connector-integrations-test-helpers.ts";
const context = testContext();
test("settings-dialog-005 a workspace administrator switches from General to People inside Settings", async () => {
  context.mocks.data.org({ role: "admin" });
  await setupPage({ context, path: "/?settings=general" });
  const settings = await screen.findByRole("dialog");
  await within(settings).findByRole("heading", { name: "General" });
  click(await findAction("button", "People", settings));
  await waitFor(() => {
    return expect(
      within(settings).getByRole("heading", { name: "People" }),
    ).toBeVisible();
  });
  expect(settings).toBeVisible();
  expect(new URL(location.href).searchParams.get("settings")).toBe("people");
});

test("settings-dialog-004 workspace Indonesian wins over French and German until English is chosen", async () => {
  context.mocks.browser.language("de-DE");
  context.mocks.browser.cookie("__Secure-okou-locale=v1.fr-FR");
  context.mocks.data.userPreferences({ locale: "id-ID", timezone: "UTC" });
  await setupPage({
    context,
    host: "app.okou.ai",
    path: "/?settings=preference",
  });
  const settings = await screen.findByRole("dialog");
  const language = await within(settings).findByRole("combobox", {
    name: "Language",
  });
  await waitFor(() => {
    return expect(language).toHaveTextContent("Bahasa Indonesia");
  });
  expect(document.documentElement.lang).toBe("id-ID");
  click(language);
  click(await screen.findByRole("option", { name: "English" }));
  await waitFor(() => {
    return expect(document.documentElement.lang).toBe("en-US");
  });
  expect(language).toHaveTextContent("English");
});
test("settings-dialog-007 a member arriving through workspace Settings sees Theme and personal navigation", async () => {
  context.mocks.data.org({ role: "member" });
  await setupPage({ context, path: "/?settings=general" });
  const settings = await screen.findByRole("dialog");
  await expect(
    within(settings).findByText("Theme", { exact: true }),
  ).resolves.toBeVisible();
  const nav = within(settings).getByRole("navigation");
  expect(within(nav).queryByText("Workspace")).toBeNull();
  expect(queryAction("button", "General", nav)).toBeNull();
  expect(queryAction("button", "People", nav)).toBeNull();
});
test("settings-dialog-008 measuring a three-thread local snapshot reports its size and read duration", async () => {
  const snapshot = [
    "Interview notes",
    "Archive review",
    "Launch retrospective",
  ].map((title, index) => {
    return chatListThread(index + 1, title);
  });
  installChatListStream(context, { caseId: 61, snapshot });
  await setupPage({
    context,
    path: "/?settings=preference",
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
    sharedWorkerTestTransport: "message-port",
  });
  const settings = await screen.findByRole("dialog");
  click(await findAction("button", "Debug", settings));
  const details = await within(settings).findByText("IndexedDB storage", {
    selector: "summary span",
  });
  click(details);
  const snapshotStore = await within(settings).findByText(
    "chat_thread_snapshot",
    {
      selector: "dt",
    },
  );
  await waitFor(() => {
    return expect(snapshotStore.nextElementSibling).toHaveTextContent(/^1$/u);
  });
  const region = await within(settings).findByRole("region", {
    name: "Thread snapshot",
  });
  const view = within(region);
  expect(view.queryByText("Threads in snapshot")).toBeNull();
  click(getAction("button", "Measure snapshot", region));
  expect(getAction("button", "Measuring...", region)).toBeDisabled();
  await view.findByText("Threads in snapshot");
  expect(getAction("button", "Measure snapshot", region)).toBeEnabled();
  expect(
    view.getByText("Threads in snapshot").nextElementSibling,
  ).toHaveTextContent(/^3$/u);
  expect(
    view.getByText("Estimated payload").nextElementSibling,
  ).toHaveTextContent(
    /^(?:[1-9][0-9]*(?:\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*)\s?KB$/u,
  );
  expect(
    view.getByText("IndexedDB read time").nextElementSibling,
  ).toHaveTextContent(/^[0-9]+(?:\.[0-9]+)?\s?ms$/u);
});
