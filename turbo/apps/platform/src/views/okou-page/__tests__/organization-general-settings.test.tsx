import { orgContract } from "@okouai/api-contracts/contracts/org-routes";
import { orgLogoContract } from "@okouai/api-contracts/contracts/org-logo";
import { cleanup, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect, vi } from "vitest";
import {
  click,
  fill,
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import {
  createTestRuntime,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
import { action, findAction } from "./workspace-billing-fixtures.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";

const context = testContext();

const workspace = {
  id: "org_foundry",
  name: "Old Name",
  role: "admin",
} as const;
const logo = "https://images.example.org/foundry.png";
function general() {
  context.mocks.data.org(workspace);
  return visitGeneral(context);
}
async function visitGeneral(runtime: typeof context) {
  await setupPage({
    context: runtime,
    path: "/?settings=general",
    auth: {
      user: { id: "manager", fullName: "Marin" },
      organization: {
        activeOrg: workspace,
        memberships: [{ id: workspace.id, role: "org:admin" }],
      },
    },
  });
  return screen.findByPlaceholderText("Workspace name");
}
function existingLogo() {
  context.mocks.api(orgLogoContract.get, ({ respond }) => {
    return respond(200, { logoUrl: logo, hasImage: true });
  });
}
test("org-general-tab-005 A discarded rename leaves the published profile intact until Save", async () => {
  existingLogo();
  let profile = { ...workspace, name: "Old Name" };
  const edits: string[] = [];
  context.mocks.api(orgContract.get, ({ respond }) => {
    return respond(200, profile);
  });
  context.mocks.api(orgContract.update, ({ body, respond }) => {
    edits.push(body.name ?? "");
    profile = { ...profile, name: body.name ?? profile.name };
    return respond(200, profile);
  });
  const field = await visitGeneral(context);
  expect(field).toHaveValue("Old Name");
  await expect(
    within(screen.getByRole("dialog")).findByRole("img", {
      name: "Old Name",
    }),
  ).resolves.toHaveAttribute("src", logo);
  await fill(field, "New Name");
  click(await action("Discard"));
  expect(field).toHaveValue("Old Name");
  expect(edits).toStrictEqual([]);
  await fill(field, "New Name");
  click(await action("Save changes"));
  await expect(
    screen.findByText("Workspace updated"),
  ).resolves.toBeInTheDocument();
  expect(field).toHaveValue("New Name");
  cleanup();
  const reloaded = await visitGeneral(createTestRuntime(context));
  await waitFor(() => {
    expect(reloaded).toHaveValue("New Name");
  });
});
test("org-general-tab-006 A rejected rename keeps the draft available for retry", async () => {
  context.mocks.api(orgContract.update, ({ respond }) => {
    return respond(500, {
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Profile service unavailable",
      },
    });
  });
  const field = await general();
  expect(field).toHaveValue("Old Name");
  await fill(field, "New Name");
  click(await action("Save changes"));
  await expect(
    screen.findByText(/Profile service unavailable/),
  ).resolves.toBeInTheDocument();
  expect(field).toHaveValue("New Name");
  await expect(action("Save changes")).resolves.toBeEnabled();
  expect(screen.queryByText("Workspace updated")).toBeNull();
});
test("org-general-tab-008 Invalid logo files leave the published workspace image in place", async () => {
  existingLogo();
  context.mocks.browser.imageDimensions([
    null,
    { width: 80, height: 80 },
    { width: 5000, height: 5000 },
  ]);
  await general();
  const settings = screen.getByRole("dialog");
  const current = await within(settings).findByRole("img", {
    name: "Old Name",
  });
  for (const [file, message] of [
    ["broken", /Could not read image file/],
    ["tiny", /80×80px.*100×100px/],
    ["huge", /5000×5000px.*4096×4096px/],
  ] as const) {
    await userEvent.upload(
      within(settings).getByLabelText("Upload logo"),
      new File([file], file + ".png", { type: "image/png" }),
    );
    await expect(screen.findByText(message)).resolves.toBeInTheDocument();
    expect(current).toHaveAttribute("src", logo);
    expect(current).toBeInTheDocument();
    expect(findAction("Save changes", settings)).toBeUndefined();
  }
});
async function deletePrompt() {
  click(await action("Delete"));
  return screen.findByRole("dialog", { name: "Delete workspace?" });
}
test("org-general-tab-010 Cancelling clears permission to delete before the next confirmation", async () => {
  await general();
  const prompt = await deletePrompt();
  const text = within(prompt).getByRole("textbox");
  await fill(text, "confirm");
  await expect(action("Delete workspace", prompt)).resolves.toBeEnabled();
  click(await action("Cancel", prompt));
  expect(text).toHaveValue("");
  await waitFor(() => {
    return expect(prompt).not.toBeInTheDocument();
  });
  const reopened = await deletePrompt();
  expect(within(reopened).getByRole("textbox")).toHaveValue("");
  await expect(action("Delete workspace", reopened)).resolves.toBeDisabled();
});
test("org-general-tab-011 Only a literal confirm authorizes deleting the workspace and returning to organization selection", async () => {
  await general();
  const prompt = await deletePrompt();
  const submit = await action("Delete workspace", prompt);
  expect(submit).toBeDisabled();
  const input = within(prompt).getByRole("textbox");
  await fill(input, "confirm");
  expect(submit).toBeEnabled();
  for (const typo of ["Confirm", "confirm "]) {
    await fill(input, typo);
    expect(submit).toBeDisabled();
  }
  await fill(input, "confirm");
  expect(submit).toBeEnabled();
  click(submit);
  await expect(
    screen.findByText("Workspace deleted"),
  ).resolves.toBeInTheDocument();
  expect(window.location.pathname).toBe("/sign-in/tasks/choose-organization");
});

test.each([
  ["org-general-tab-004", "received"],
  ["Withheld control", "pending"],
] as const)(
  "%s %s original logo read during an upload and a later visit",
  async (_label, previous) => {
    const first = context.mocks.deferred<void>();
    const finish = context.mocks.deferred<void>();
    const decoded = context.mocks.deferred<void>();
    const placeholder = "https://assets.example.test/workspace-placeholder.png";
    const accepted = "https://assets.example.test/uploaded-emblem.png";
    let published: string | null = null;
    const parse = Response.prototype.json;
    vi.spyOn(Response.prototype, "json").mockImplementation(async function (
      this: Response,
    ) {
      const payload: unknown = await parse.call(this);
      if (
        this.url.endsWith(orgLogoContract.get.path) &&
        JSON.stringify(payload).includes(placeholder)
      ) {
        decoded.resolve();
      }
      return payload;
    });
    context.mocks.api(orgLogoContract.get, async ({ respond }) => {
      if (published) {
        return respond(200, { hasImage: true, logoUrl: published });
      }
      first.resolve();
      await finish.promise;
      return respond(200, { hasImage: false, logoUrl: placeholder });
    });
    context.mocks.api(orgLogoContract.post, ({ body, respond }) => {
      const uploaded = body.get("file");
      expect(typeof uploaded === "object" && uploaded?.name).toBe("emblem.png");
      published = accepted;
      return respond(200, { hasImage: true, logoUrl: accepted });
    });
    context.mocks.browser.imageDimensions([{ width: 256, height: 256 }]);
    await general();
    await first.promise;
    const panel = screen.getByRole("dialog");
    await userEvent.upload(
      within(panel).getByLabelText("Upload logo"),
      new File(["emblem"], "emblem.png", { type: "image/png" }),
    );
    click(await action("Save changes", panel));
    await screen.findByText("Workspace updated");
    if (previous === "received") {
      finish.resolve();
      await decoded.promise;
    }
    await waitFor(() => {
      return expect(
        within(panel).getByRole("img", { name: workspace.name }),
      ).toHaveAttribute("src", accepted);
    });
    expect(within(panel).queryByRole("status", { name: /logo/i })).toBeNull();
    published = "https://assets.example.test/new-published-emblem.png";
    click(await action("Close", panel));
    await waitFor(() => {
      return expect(screen.queryByRole("dialog")).toBeNull();
    });
    window.history.back();
    const reopened = await screen.findByRole("dialog");
    await waitFor(() => {
      return expect(
        within(reopened).getByRole("img", { name: workspace.name }),
      ).toHaveAttribute("src", published);
    });
  },
);

function memberships() {
  return [
    { id: "org_a", organization: { id: "org_a", name: "Org A" } },
    { id: "org_b", organization: { id: "org_b", name: "Org B" } },
  ];
}

function workspaceChoices(): string[] {
  return queryAllByRoleFast("menuitem", screen.getByRole("menu")).map(
    (item) => {
      return item.textContent?.trim() ?? "";
    },
  );
}

function expectWorkflowsPage(): void {
  expect(location.pathname).toBe("/workflows");
  expect(location.search).toBe("");
  expect(
    screen.getByRole("heading", { name: "Workflows", level: 1 }),
  ).toBeInTheDocument();
}

test("A temporary authentication refresh keeps the active workspace", async () => {
  await setupPage({
    context,
    path: "/workflows",
    auth: {
      user: { id: "user_avery", fullName: "Avery Stone" },
      organization: {
        activeOrg: { id: "org_a", name: "Org A" },
        memberships: memberships(),
      },
    },
  });
  await expect(
    screen.findByRole("heading", { name: "Workflows", level: 1 }),
  ).resolves.toBeInTheDocument();
  click(await findFastControl("button", "Switch workspace"));
  await expect(screen.findByRole("menu")).resolves.toHaveTextContent("Org A");
  expect(workspaceChoices()).toStrictEqual(["Org B"]);
  const clerk = context.mocks.clerk();

  clerk.organization({ activeOrg: null, memberships: memberships() });
  clerk.stateChanged();

  // While no workspace is active, Org A is still offered.
  await waitFor(() => {
    expect(workspaceChoices()).toStrictEqual(["Org A", "Org B"]);
  });
  expectWorkflowsPage();

  clerk.organization({
    activeOrg: { id: "org_a", name: "Org A" },
    memberships: memberships(),
  });
  clerk.stateChanged();

  await waitFor(() => {
    expect(workspaceChoices()).toStrictEqual(["Org B"]);
  });
  expect(screen.getByRole("menu")).toHaveTextContent("Org A");
  expectWorkflowsPage();
});
