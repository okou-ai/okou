import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { clickComposerAddMenuItem } from "./chat-composer-add-menu-test-helpers.ts";

const context = testContext();

test("chat-composer-add-menu-002 follows the workflow link from skill import", async () => {
  await setupPage({ context, path: "/" });
  await clickComposerAddMenuItem("Import skills");
  const dialog = await screen.findByRole("dialog", {
    name: "Import your skills",
  });
  expect(
    within(dialog).getByText("Copy prompt").closest("button"),
  ).toBeEnabled();
  click(within(dialog).getByText("View workflows"));
  await expect(
    screen.findByRole("heading", { name: "Workflows", level: 1 }),
  ).resolves.toBeInTheDocument();
  expect(location.pathname).toBe("/workflows");
  expect(dialog).not.toBeInTheDocument();
});

test("chat-composer-add-menu-004 accepts the file returned by the Attach picker", async () => {
  const file = new File(["Draft"], "brief.txt", { type: "text/plain" });
  const id = "30000000-0000-4000-8000-000000000022";
  context.mocks.upload.success({
    id,
    filename: file.name,
    size: file.size,
    contentType: file.type,
    url: "/artifacts/30000000000040008000000000000022.txt",
  });
  await setupPage({ context, path: "/" });
  const input = await screen.findByLabelText("Attach", {
    selector: 'input[type="file"]',
  });
  const picked = context.mocks.deferred<HTMLInputElement>();
  Object.defineProperty(input, "showPicker", {
    value(this: HTMLInputElement) {
      picked.resolve(this);
    },
  });
  await clickComposerAddMenuItem("Attach");
  const picker = await picked.promise;
  await waitFor(() => {
    expect(screen.queryByRole("menu", { name: "Add" })).not.toBeInTheDocument();
  });
  await userEvent.upload(picker, file);
  await expect(
    screen.findByLabelText("Remove brief.txt"),
  ).resolves.toBeEnabled();
  expect(screen.getByText("brief.txt")).toBeInTheDocument();
});
