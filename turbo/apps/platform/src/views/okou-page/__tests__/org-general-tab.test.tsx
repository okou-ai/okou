import {
  orgContract,
  orgDeleteContract,
} from "@okouai/api-contracts/contracts/org-routes";
import { orgLogoContract } from "@okouai/api-contracts/contracts/org-logo";
import { screen, waitFor, within } from "@testing-library/react";
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

async function openGeneralTab(): Promise<void> {
  await setupPage({ context, path: "/agents?settings=general" });
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "General" }),
    ).toBeInTheDocument();
  });
}

async function reopenGeneralTab(): Promise<HTMLElement> {
  const rail = await screen.findByTestId("labeled-nav-rail");
  click(within(rail).getByLabelText("Test User"));
  click(within(await screen.findByRole("menu")).getByText("Settings"));
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  click(buttonWithText(settings, "General"));
  await within(settings).findByRole("heading", { name: "General" });
  return settings;
}

test("Show a saved upload while the initial logo load is pending and refresh on reopening", async () => {
  const user = userEvent.setup({ delay: null });
  const started = context.mocks.deferred<void>();
  const initialResponse = context.mocks.deferred<void>();
  const uploadedLogoUrl = "https://cdn.okou.test/orgs/acme/uploaded.png";
  const currentLogoUrl = "https://cdn.okou.test/orgs/acme/current.png";
  let initial = true;
  let publishedLogoUrl = uploadedLogoUrl;
  context.mocks.browser.imageDimensions({ width: 512, height: 512 });
  context.mocks.data.org({ id: "org_1", name: "Acme", role: "admin" });
  context.mocks.api(orgLogoContract.get, async ({ respond }) => {
    if (initial) {
      started.resolve();
      await initialResponse.promise;
      return respond(200, { logoUrl: null, hasImage: false });
    }
    return respond(200, { logoUrl: publishedLogoUrl, hasImage: true });
  });
  context.mocks.http.post("*/api/org/logo", () => {
    initial = false;
    return Response.json({ logoUrl: uploadedLogoUrl, hasImage: true });
  });
  await openGeneralTab();
  await started.promise;
  const settings = screen.getByRole("dialog", { name: "Settings" });
  await within(settings).findByRole("status", {
    name: "Loading workspace logo",
  });
  await user.upload(
    within(settings).getByLabelText("Upload logo"),
    new File(["logo"], "logo.png", { type: "image/png" }),
  );
  click(
    await waitFor(() => {
      return buttonWithText(settings, "Save changes");
    }),
  );
  await screen.findByText("Workspace updated");
  initialResponse.resolve();
  await waitFor(() => {
    expect(within(settings).getByRole("img", { name: "Acme" })).toHaveAttribute(
      "src",
      uploadedLogoUrl,
    );
  });
  expect(
    within(settings).queryByRole("status", { name: "Loading workspace logo" }),
  ).not.toBeInTheDocument();
  click(within(settings).getByLabelText("Close"));
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Settings" }),
    ).not.toBeInTheDocument();
  });
  publishedLogoUrl = currentLogoUrl;
  const reopened = await reopenGeneralTab();
  await waitFor(() => {
    expect(within(reopened).getByRole("img", { name: "Acme" })).toHaveAttribute(
      "src",
      currentLogoUrl,
    );
  });
});

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

test("Require fresh workspace confirmation after cancelling", async () => {
  context.mocks.data.org({ id: "org_1", name: "Acme", role: "admin" });
  await openGeneralTab();

  const dialog = await openDeleteDialog();
  await fill(within(dialog).getByPlaceholderText("confirm"), "confirm");
  expect(buttonWithText(dialog, "Delete workspace")).toBeEnabled();
  const finishCloseTransition = holdElementAnimations(dialog);

  click(buttonWithText(dialog, "Cancel"));
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
