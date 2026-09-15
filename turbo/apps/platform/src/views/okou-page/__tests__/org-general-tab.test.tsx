import {
  orgContract,
  orgDeleteContract,
} from "@okouai/api-contracts/contracts/org-routes";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  setupPage,
  fill,
  holdElementAnimations,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";

const context = testContext();

function buttonWithText(container: HTMLElement, text: string): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.textContent?.trim() === text;
  });
  if (!button) {
    throw new Error(`Button not found: ${text}`);
  }
  return button;
}

async function openDeleteDialog(): Promise<HTMLElement> {
  const settings = screen.getByRole("dialog", { name: "Settings" });
  click(buttonWithText(settings, "Delete"));
  return await screen.findByRole("dialog", { name: "Delete workspace?" });
}

async function reopenSettings(): Promise<void> {
  const rail = await screen.findByTestId("labeled-nav-rail");
  click(within(rail).getByLabelText("Test User"));
  const menu = await screen.findByRole("menu");
  click(within(menu).getByText("Settings"));
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  click(buttonWithText(settings, "General"));
  await within(settings).findByRole("heading", { name: "General" });
}

async function openGeneralTab(): Promise<void> {
  await setupPage({ context, path: "/agents?settings=general" });
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "General" }),
    ).toBeInTheDocument();
  });
}

test("Edit, save, and discard workspace profile details", async () => {
  let capturedBody: unknown = null;
  const logoUrl = "https://cdn.okou.test/orgs/old-slug/logo.png";
  context.mocks.data.org({
    id: "org_1",
    name: "Old Name",
    role: "admin",
  });
  context.mocks.http.get("*/api/org/logo", () => {
    return new Response(JSON.stringify({ logoUrl, hasImage: true }), {
      headers: { "Content-Type": "application/json" },
    });
  });
  context.mocks.api(orgContract.update, ({ body, respond }) => {
    capturedBody = body;
    return respond(200, {
      id: "org_1",
      name: "New Name",
      role: "admin",
    });
  });

  await openGeneralTab();

  await waitFor(() => {
    expect(screen.getByRole("img", { name: "Old Name" })).toHaveAttribute(
      "src",
      logoUrl,
    );
  });

  await fill(await screen.findByDisplayValue("Old Name"), "New Name");
  expect(screen.getByText("Save changes")).toBeInTheDocument();
  expect(screen.getByText("Discard")).toBeInTheDocument();

  click(screen.getByText("Discard"));
  expect(screen.getByDisplayValue("Old Name")).toBeInTheDocument();
  expect(capturedBody).toBeNull();

  await fill(screen.getByDisplayValue("Old Name"), "New Name");
  click(screen.getByText("Save changes"));

  await waitFor(() => {
    expect(capturedBody).toStrictEqual({
      name: "New Name",
    });
    expect(screen.getByDisplayValue("New Name")).toBeInTheDocument();
    expect(screen.getByText("Workspace updated")).toBeInTheDocument();
  });
});

test("Show a workspace profile update failure without losing the edit", async () => {
  context.mocks.data.org({
    id: "org_1",
    name: "Old Name",
    role: "admin",
  });
  context.mocks.api(orgContract.update, ({ respond }) => {
    return respond(500, {
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Could not update workspace",
      },
    });
  });

  await openGeneralTab();

  await fill(screen.getByDisplayValue("Old Name"), "New Name");
  click(screen.getByText("Save changes"));

  await waitFor(() => {
    expect(screen.getByText("Could not update workspace")).toBeInTheDocument();
    expect(screen.getByText("Save changes")).toBeInTheDocument();
    expect(screen.getByDisplayValue("New Name")).toBeInTheDocument();
    expect(screen.queryByText("Workspace updated")).not.toBeInTheDocument();
  });
});

test("Upload and save a valid workspace logo", async () => {
  const user = userEvent.setup({ delay: null });
  let capturedLogoName: string | null = null;
  const initialLogoUrl = "https://cdn.okou.test/orgs/acme/logo-old.png";
  const uploadedLogoUrl = "https://cdn.okou.test/orgs/acme/logo-new.png";
  context.mocks.browser.imageDimensions({ width: 512, height: 512 });
  context.mocks.data.org({
    id: "org_1",
    name: "Acme",
    role: "admin",
  });
  context.mocks.http.get("*/api/org/logo", () => {
    return new Response(
      JSON.stringify({ logoUrl: initialLogoUrl, hasImage: true }),
      {
        headers: { "Content-Type": "application/json" },
      },
    );
  });
  context.mocks.http.post("*/api/org/logo", async ({ request }) => {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      throw new Error("Uploaded logo file not found");
    }
    capturedLogoName = file.name;
    return new Response(
      JSON.stringify({ logoUrl: uploadedLogoUrl, hasImage: true }),
      {
        headers: { "Content-Type": "application/json" },
      },
    );
  });

  await openGeneralTab();

  await waitFor(() => {
    expect(screen.getByRole("img", { name: "Acme" })).toHaveAttribute(
      "src",
      initialLogoUrl,
    );
  });

  await user.upload(
    screen.getByLabelText("Upload logo"),
    new File(["logo"], "workspace-logo.png", { type: "image/png" }),
  );

  await waitFor(() => {
    expect(screen.getByText("Save changes")).toBeInTheDocument();
  });

  click(screen.getByText("Save changes"));

  await waitFor(() => {
    expect(capturedLogoName).toBe("workspace-logo.png");
    expect(screen.getByRole("img", { name: "Acme" })).toHaveAttribute(
      "src",
      uploadedLogoUrl,
    );
    expect(screen.getByText("Workspace updated")).toBeInTheDocument();
  });
});

test("Reject invalid workspace logo files", async () => {
  const user = userEvent.setup({ delay: null });
  const initialLogoUrl = "https://cdn.okou.test/orgs/acme/logo.png";
  context.mocks.browser.imageDimensions([
    null,
    { width: 80, height: 80 },
    { width: 5000, height: 5000 },
  ]);
  context.mocks.data.org({
    id: "org_1",
    name: "Acme",
    role: "admin",
  });
  context.mocks.http.get("*/api/org/logo", () => {
    return new Response(
      JSON.stringify({ logoUrl: initialLogoUrl, hasImage: true }),
      {
        headers: { "Content-Type": "application/json" },
      },
    );
  });

  await openGeneralTab();

  await waitFor(() => {
    expect(screen.getByRole("img", { name: "Acme" })).toHaveAttribute(
      "src",
      initialLogoUrl,
    );
  });

  const uploadInput = screen.getByLabelText("Upload logo");
  await user.upload(
    uploadInput,
    new File(["not-image"], "unreadable.png", { type: "image/png" }),
  );

  await waitFor(() => {
    expect(screen.getByText("Could not read image file")).toBeInTheDocument();
    expect(screen.queryByText("Save changes")).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Acme" })).toHaveAttribute(
      "src",
      initialLogoUrl,
    );
  });

  await user.upload(
    uploadInput,
    new File(["small"], "too-small.png", { type: "image/png" }),
  );

  await waitFor(() => {
    expect(screen.getByText(/Logo is too small/u)).toBeInTheDocument();
    expect(screen.queryByText("Save changes")).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Acme" })).toHaveAttribute(
      "src",
      initialLogoUrl,
    );
  });

  await user.upload(
    uploadInput,
    new File(["large"], "too-large.png", { type: "image/png" }),
  );

  await waitFor(() => {
    expect(screen.getByText(/Logo is too large/u)).toBeInTheDocument();
    expect(screen.queryByText("Save changes")).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Acme" })).toHaveAttribute(
      "src",
      initialLogoUrl,
    );
  });
});

test("Closing workspace settings releases a pending logo decode", async () => {
  const images = context.mocks.browser.imageDimensions("pending");
  context.mocks.data.org({ id: "org_1", name: "Acme", role: "admin" });
  await openGeneralTab();

  await userEvent.upload(
    screen.getByLabelText("Upload logo"),
    new File(["logo"], "pending-logo.png", { type: "image/png" }),
  );
  expect(images.createdUrls).toHaveLength(1);
  expect(images.revokedUrls).toHaveLength(0);

  click(screen.getByLabelText("Close"));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(images.revokedUrls).toStrictEqual(images.createdUrls);
});

test("Explain the billing effects before deleting a workspace", async () => {
  context.mocks.data.org({
    id: "org_1",
    name: "Acme",
    role: "admin",
  });

  await openGeneralTab();
  const deleteButton = queryAllByRoleFast("button").find((button) => {
    return button.textContent?.trim() === "Delete";
  });
  if (!deleteButton) {
    throw new Error("Delete button not found");
  }
  click(deleteButton);

  await expect(
    screen.findByText(
      "All active subscriptions, including usage packs and add-ons, will be canceled immediately. Unused prepaid subscription time will be refunded proportionally. One-time and other non-subscription purchases will not be refunded.",
    ),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: "Delete workspace?" }),
  ).toBeInTheDocument();
});

test.each(["Cancel", "Close", "Escape", "backdrop"] as const)(
  "Require fresh workspace confirmation after dismissing with %s",
  async (dismissal) => {
    const user = userEvent.setup({ delay: null });
    context.mocks.data.org({ id: "org_1", name: "Acme", role: "admin" });
    await openGeneralTab();

    const dialog = await openDeleteDialog();
    await fill(within(dialog).getByPlaceholderText("confirm"), "confirm");
    expect(buttonWithText(dialog, "Delete workspace")).toBeEnabled();
    const finishCloseTransition = holdElementAnimations(dialog);

    if (dismissal === "Cancel") {
      click(buttonWithText(dialog, "Cancel"));
    } else if (dismissal === "Close") {
      click(within(dialog).getByLabelText("Close"));
    } else if (dismissal === "Escape") {
      await user.keyboard("{Escape}");
    } else {
      const viewport = dialog.closest('[data-slot="dialog-viewport"]');
      if (!(viewport instanceof HTMLElement)) {
        throw new Error("Delete dialog viewport not found");
      }
      await user.click(viewport);
    }
    expect(dialog).toBeVisible();
    expect(within(dialog).getByPlaceholderText("confirm")).toHaveValue("");
    expect(buttonWithText(dialog, "Delete workspace")).toBeDisabled();
    finishCloseTransition();
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Delete workspace?" }),
      ).not.toBeInTheDocument();
    });

    const reopened = await openDeleteDialog();
    expect(within(reopened).getByPlaceholderText("confirm")).toHaveValue("");
    expect(buttonWithText(reopened, "Delete workspace")).toBeDisabled();
  },
);

test.each(["closing Settings", "navigating back"])(
  "Require fresh workspace confirmation after %s",
  async (exit) => {
    context.mocks.data.org({ id: "org_1", name: "Acme", role: "admin" });
    await setupPage({ context, path: "/agents" });
    await reopenSettings();

    const dialog = await openDeleteDialog();
    await fill(within(dialog).getByPlaceholderText("confirm"), "confirm");
    expect(buttonWithText(dialog, "Delete workspace")).toBeEnabled();
    if (exit === "closing Settings") {
      click(buttonWithText(dialog, "Cancel"));
      const settings = await screen.findByRole("dialog", { name: "Settings" });
      click(within(settings).getByLabelText("Close"));
    } else {
      act(() => {
        window.history.back();
      });
      await screen.findByRole("heading", { name: "Preference" });
      act(() => {
        window.history.back();
      });
    }
    await waitFor(() => {
      expect(
        new URLSearchParams(window.location.search).has("settings"),
      ).toBeFalsy();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    await reopenSettings();
    const afterNavigation = await openDeleteDialog();
    expect(within(afterNavigation).getByPlaceholderText("confirm")).toHaveValue(
      "",
    );
    expect(buttonWithText(afterNavigation, "Delete workspace")).toBeDisabled();
  },
);

test("Require fresh confirmation after workspace details finish saving", async () => {
  const saveReady = createDeferredPromise<void>(context.signal);
  const refreshReady = createDeferredPromise<void>(context.signal);
  let workspace = { id: "org_1", name: "Old Name", role: "admin" as const };
  context.mocks.api(orgContract.get, async ({ respond }) => {
    if (workspace.name === "New Name") {
      await refreshReady.promise;
    }
    return respond(200, workspace);
  });
  context.mocks.api(orgContract.update, async ({ respond }) => {
    await saveReady.promise;
    workspace = { ...workspace, name: "New Name" };
    return respond(200, workspace);
  });
  await openGeneralTab();

  await fill(screen.getByDisplayValue("Old Name"), "New Name");
  click(screen.getByText("Save changes"));
  await screen.findByText("Saving...");
  const dialog = await openDeleteDialog();
  await fill(within(dialog).getByPlaceholderText("confirm"), "confirm");
  expect(buttonWithText(dialog, "Delete workspace")).toBeEnabled();

  saveReady.resolve();
  await screen.findByText("Workspace updated");
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Delete workspace?" }),
    ).not.toBeInTheDocument();
  });
  refreshReady.resolve();
  await screen.findByDisplayValue("New Name");

  const reopened = await openDeleteDialog();
  expect(within(reopened).getByPlaceholderText("confirm")).toHaveValue("");
  expect(buttonWithText(reopened, "Delete workspace")).toBeDisabled();
});

test("Navigate to a fresh page when the workspace changes after cancelling deletion", async () => {
  let workspace = { id: "org_a", name: "Workspace A", role: "admin" as const };
  context.mocks.api(orgContract.get, ({ respond }) => {
    return respond(200, workspace);
  });
  const memberships = [
    { id: "membership_a", organization: { id: "org_a", name: "Workspace A" } },
    { id: "membership_b", organization: { id: "org_b", name: "Workspace B" } },
  ];
  await setupPage({
    context,
    path: "/agents?settings=general",
    auth: {
      user: { id: "test-user-123", fullName: "Test User" },
      organization: { activeOrg: workspace, memberships },
    },
  });
  await screen.findByDisplayValue("Workspace A");

  const dialog = await openDeleteDialog();
  await fill(within(dialog).getByPlaceholderText("confirm"), "confirm");
  expect(buttonWithText(dialog, "Delete workspace")).toBeEnabled();
  click(buttonWithText(dialog, "Cancel"));
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  click(within(settings).getByLabelText("Close"));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  const clerk = context.mocks.clerk();
  workspace = { id: "org_b", name: "Workspace B", role: "admin" };
  act(() => {
    clerk.organization({ activeOrg: workspace, memberships });
    clerk.stateChanged();
  });
  await waitFor(() => {
    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toBe("");
  });
});

test("Keep a pending workspace deletion running when its dialog closes", async () => {
  const deletionReady = createDeferredPromise<void>(context.signal);
  context.mocks.data.org({ id: "org_1", name: "Acme", role: "admin" });
  context.mocks.api(orgDeleteContract.delete, async ({ respond }) => {
    await deletionReady.promise;
    return respond(200, { message: "Workspace deleted" });
  });
  await openGeneralTab();

  const dialog = await openDeleteDialog();
  await fill(within(dialog).getByPlaceholderText("confirm"), "confirm");
  click(buttonWithText(dialog, "Delete workspace"));
  await within(dialog).findByText("Deleting...");
  click(buttonWithText(dialog, "Cancel"));
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Delete workspace?" }),
    ).not.toBeInTheDocument();
  });

  const reopened = await openDeleteDialog();
  expect(within(reopened).getByPlaceholderText("confirm")).toHaveValue("");
  expect(buttonWithText(reopened, "Deleting...")).toBeDisabled();
  deletionReady.resolve();
  await screen.findByText("Workspace deleted");
  expect(window.location.pathname).toBe("/sign-in/tasks/choose-organization");
});

test("Enable workspace deletion only for the exact confirmation and keep the success flow", async () => {
  context.mocks.data.org({ id: "org_1", name: "Acme", role: "admin" });
  context.mocks.api(orgDeleteContract.delete, ({ respond }) => {
    return respond(200, { message: "Workspace deleted" });
  });
  await openGeneralTab();

  const dialog = await openDeleteDialog();
  const input = within(dialog).getByPlaceholderText("confirm");
  const deleteButton = buttonWithText(dialog, "Delete workspace");
  expect(input).toHaveValue("");
  expect(deleteButton).toBeDisabled();
  await fill(input, "confirm");
  expect(deleteButton).toBeEnabled();
  await fill(input, "Confirm");
  expect(deleteButton).toBeDisabled();
  await fill(input, "confirm ");
  expect(deleteButton).toBeDisabled();
  await fill(input, "confirm");
  expect(deleteButton).toBeEnabled();

  click(deleteButton);
  await screen.findByText("Workspace deleted");
  expect(window.location.pathname).toBe("/sign-in/tasks/choose-organization");
});
