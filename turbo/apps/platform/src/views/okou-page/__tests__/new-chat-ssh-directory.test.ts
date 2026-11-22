import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  createComposerConnectorHelpers,
  builtinConnector,
} from "./chat-composer-connectors-test-helpers.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
const context = testContext();
const github = builtinConnector({ slug: "github", label: "GitHub" });
async function directory(configuredCount: number) {
  const catalog = [
    github,
    builtinConnector({ slug: "notion", label: "Notion" }),
    builtinConnector({ slug: "slack", label: "Slack" }),
    builtinConnector({ slug: "linear", label: "Linear" }),
    builtinConnector({ slug: "figma", label: "Figma" }),
  ];
  createComposerConnectorHelpers(context).installComposerConnectorFixture({
    catalog,
  });
  context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount });
  });
  await setupPage({ context, path: "/" });
  click(await findFastControl("button", "Connectors"));
  click(await findFastControl("button", "Add connectors"));
  const search = await screen.findByPlaceholderText("Find connectors...");
  const dlg = search.closest<HTMLElement>('[role="dialog"]')!;
  await within(dlg).findByText("Discover", { exact: true });
  return dlg;
}
async function openSetup(dialog: HTMLElement) {
  click(await findFastControl("link", "Manage SSH hosts", dialog));
  const add = await findFastControl("button", "Add connection");
  click(add);
  expect(location.pathname).toBe("/connectors");
  expect(
    Object.fromEntries(new URLSearchParams(location.search)),
  ).toMatchObject({ scope: "remote-control", type: "ssh" });
  await expect(
    screen.findByText("Add remote connection", { exact: true }),
  ).resolves.toBeVisible();
}
test("chat-composer-ssh-016 A first SSH host can be configured from the new chat's connector directory", async () => {
  const dialog = await directory(0);
  await expect(
    findFastControl("link", "Manage SSH hosts", dialog),
  ).resolves.toBeVisible();
  await openSetup(dialog);
});
test("chat-composer-ssh-017 A new chat with an existing SSH connection stays in the directory without offering first-host setup", async () => {
  const dialog = await directory(1);
  await within(dialog).findByText("Productivity", { exact: true });
  expect(queryFastControl("link", "Manage SSH hosts", dialog)).toBeNull();
  expect(location.pathname).toBe("/");
  expect(location.search).toBe("");
});
test("chat-composer-ssh-018 Remote-access discovery and All offer first-host setup while the Custom shelf stays empty", async () => {
  const dialog = await directory(0);
  const cat = await within(dialog).findAllByText("Remote access", {
    exact: true,
  });
  click(
    cat.find((el) => {
      return el.closest("button");
    })!,
  );
  await expect(
    findFastControl("link", "Manage SSH hosts", dialog),
  ).resolves.toBeVisible();
  click(await within(dialog).findByText("Custom", { exact: true }));
  await expect(
    within(dialog).findByText(/No custom connectors yet/i),
  ).resolves.toBeVisible();
  expect(queryFastControl("link", "Manage SSH hosts", dialog)).toBeNull();
  click(await within(dialog).findByText("Discover", { exact: true }));
  await expect(
    findFastControl("link", "Manage SSH hosts", dialog),
  ).resolves.toBeVisible();
  click(await findFastControl("button", "All", dialog));
  await waitFor(() => {
    return expect(
      queryFastControl("link", "Manage SSH hosts", dialog),
    ).toBeVisible();
  });
  await openSetup(dialog);
});
