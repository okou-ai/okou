import { projectsContract } from "@okouai/api-contracts/contracts/projects";
import { chatListThread } from "./chat-list-test-helpers.ts";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, fill } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  projectMenuItem,
  project,
  projectEditor,
} from "./project-editor-fixtures.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
const context = testContext();
async function options(name: string, action: "Rename" | "Delete") {
  click(await screen.findByLabelText("Options for " + name));
  click(await projectMenuItem(action));
  return screen.findByRole("dialog", {
    name: action === "Delete" ? "Delete Project?" : "Rename Project",
  });
}
async function save(dialog: HTMLElement, name: string) {
  await fill(within(dialog).getByRole("textbox"), name);
  click(await findFastControl("button", "Save", dialog));
}
const folder = (name: string) => {
  return findFastControl("button", "Show or hide chats in " + name);
};
test("projects-025 Creating, renaming and deleting a Project keeps the current conversation open", async () => {
  const release = context.mocks.deferred<void>();
  const ws = await projectEditor(context, [], {
    path: "chat",
    createGate: release.promise,
  });
  click(await findFastControl("button", "Create Project"));
  const create = await screen.findByRole("dialog", { name: "Create Project" });
  await save(create, "Campaign");
  await ws.creating;
  await expect(folder("Campaign")).resolves.toHaveAttribute(
    "aria-expanded",
    "true",
  );
  expect(create).not.toBeInTheDocument();
  expect(location.pathname).toBe("/chats/" + ws.ordinary);
  release.resolve();
  const rename = await options("Campaign", "Rename");
  await save(rename, "Campaign two");
  await folder("Campaign two");
  const deletion = await options("Campaign two", "Delete");
  click(await findFastControl("button", "Delete project only", deletion));
  await waitFor(() => {
    expect(deletion).not.toBeInTheDocument();
    expect(
      queryFastControl("button", "Show or hide chats in Campaign two"),
    ).toBeNull();
  });
  expect(location.pathname).toBe("/chats/" + ws.ordinary);
});
test("projects-027 A denied deletion keeps the Project and offers a working retry in the same dialog", async () => {
  const gate = context.mocks.deferred<void>();
  let reject = true;
  const launch = project("Launch");
  const ws = await projectEditor(context, [launch], {
    path: "chat",
    onDelete: async () => {
      await gate.promise;
      return reject ? "fail" : "ok";
    },
  });
  const launchRow = await folder("Launch");
  const deletion = await options("Launch", "Delete");
  const remove = await findFastControl(
    "button",
    "Delete project only",
    deletion,
  );
  click(remove);
  await waitFor(() => {
    return expect(remove).toBeDisabled();
  });
  expect(launchRow).toBeInTheDocument();
  gate.resolve();
  await expect(
    within(deletion).findByText("Could not delete Project"),
  ).resolves.toBeVisible();
  expect(remove).toBeEnabled();
  reject = false;
  click(remove);
  await waitFor(() => {
    expect(deletion).not.toBeInTheDocument();
    expect(
      queryFastControl("button", "Show or hide chats in Launch"),
    ).toBeNull();
  });
  expect(location.pathname).toBe("/chats/" + ws.ordinary);
});
test("projects-049 The optimistic renamed folder appears before its persisted name replaces it", async () => {
  const gate = context.mocks.deferred<void>();
  const launch = project("Launch");
  await projectEditor(context, [launch], {
    path: "chat",
    renameGate: gate.promise,
    confirmedName: "Launch confirmed",
  });
  const rename = await options("Launch", "Rename");
  await save(rename, "Launch renamed");
  await expect(folder("Launch renamed")).resolves.toBeVisible();
  expect(rename).not.toBeInTheDocument();
  gate.resolve();
  await expect(folder("Launch confirmed")).resolves.toBeVisible();
  expect(
    queryFastControl("button", "Show or hide chats in Launch renamed"),
  ).toBeNull();
});

test("A second project rename replaces the rejected draft with the persisted label", async () => {
  const ws = await projectEditor(context, [project("Atlas")], {
    path: "chat",
    rejectedName: "Atlas draft",
    confirmedName: "Coastal atlas",
  });
  await save(await options("Atlas", "Rename"), "Atlas draft");
  await expect(
    screen.findByText("The project was edited elsewhere"),
  ).resolves.toBeVisible();
  await expect(folder("Atlas draft")).resolves.toBeVisible();
  const retry = await options("Atlas draft", "Rename");
  expect(within(retry).getByRole("textbox")).toHaveValue("Atlas draft");
  await save(retry, "Atlas revised");
  await expect(folder("Coastal atlas")).resolves.toBeVisible();
  expect(
    queryFastControl("button", "Show or hide chats in Atlas draft"),
  ).toBeNull();
  expect(location.pathname).toBe("/chats/" + ws.ordinary);
});

test.each([1, 3, 101])(
  "Deleting a project with %i conversations previews the named threads",
  async (count) => {
    const collection = project("Field notes");
    await projectEditor(context, [collection]);
    const records = Array.from({ length: count }, (_, index) => {
      return chatListThread(index + 1, "Field record " + (index + 1), {
        archived: true,
        projectId: collection.id,
      });
    });
    context.mocks.api(projectsContract.threads, ({ query, respond }) => {
      if (query.archived === "false") {
        return respond(200, { threads: [], nextAfter: null });
      }
      const start =
        records.findIndex((item) => {
          return item.id === query.after;
        }) + 1;
      const page = records.slice(start, start + query.limit);
      return respond(200, {
        threads: page,
        nextAfter: start + page.length < count ? page.at(-1)!.id : null,
      });
    });
    const choices = await options(collection.name, "Delete");
    const label =
      count === 1
        ? "Delete project and 1 thread"
        : "Delete project and " + count + " threads";
    click(await findFastControl("button", label, choices));
    const review = await screen.findByRole("dialog", {
      name: "Delete project and threads?",
    });
    expect(
      within(review).getByText("Field record " + count, { exact: true }),
    ).toBeInTheDocument();
    expect(within(review).getAllByRole("listitem")).toHaveLength(count);
  },
);
