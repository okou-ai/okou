import { attachment } from "./attachment-preview-boundaries.ts";
import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { openMessageFile } from "./chat-artifact-preview-test-helpers.ts";
import { artifactFile } from "./chat-attachment-test-helpers.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";

const context = testContext();

async function gallery() {
  const files = ["first.png", "second.png", "third.png"].map((name) => {
    return artifactFile(name, { contentType: "image/png" });
  });
  await openMessageFile(context, files[0]!, { relatedFiles: files.slice(1) });
  const owner = await screen.findByRole("group", { name: "first.png preview" });
  owner.focus();
  return owner;
}
test("chat-image-navigation-shortcuts-001 the last image bounds arrow navigation", async () => {
  await gallery();
  await userEvent.keyboard("{ArrowRight}");
  await screen.findByRole("group", { name: "second.png preview" });
  await userEvent.keyboard("{ArrowRight}");
  const last = await screen.findByRole("group", { name: "third.png preview" });
  expect(queryFastControl("button", "Next image", last)).toBeNull();
  await userEvent.keyboard("{ArrowRight}");
  expect(last).toHaveAccessibleName("third.png preview");
  await userEvent.keyboard("{ArrowLeft}");
  await screen.findByRole("group", { name: "second.png preview" });
});

test("chat-image-navigation-shortcuts-007 modifiers, menus and fullscreen focus determine which gallery receives arrows", async () => {
  const stage = await gallery();
  for (const key of ["Alt", "Control", "Meta", "Shift"]) {
    await userEvent.keyboard("{" + key + ">}{ArrowRight}{/" + key + "}");
    expect(stage).toHaveAccessibleName("first.png preview");
  }
  const menu = await findFastControl(
    "button",
    /Download options|Download menu/i,
  );
  click(menu);
  await userEvent.keyboard("{ArrowRight}");
  expect(stage).toHaveAccessibleName("first.png preview");
  await userEvent.keyboard("{Escape}");
  click(await findFastControl("button", "Enter fullscreen"));
  await userEvent.keyboard("{ArrowRight}");
  expect(stage).toHaveAccessibleName("first.png preview");
  stage.focus();
  await userEvent.keyboard("{ArrowRight}");
  await screen.findByRole("group", { name: "second.png preview" });
  click(await findFastControl("button", /open in split view/i));
  click(await findFastControl("button", "Enter fullscreen"));
  await userEvent.keyboard("{ArrowRight}");
  const side = await screen.findByRole("group", { name: "second.png preview" });
  side.focus();
  await userEvent.keyboard("{ArrowRight}");
  await screen.findByRole("group", { name: "third.png preview" });
  click(await findFastControl("button", "Exit fullscreen"));
  const third = await screen.findByRole("group", { name: "third.png preview" });
  third.focus();
  await userEvent.keyboard("{ArrowLeft}");
  await screen.findByRole("group", { name: "second.png preview" });
});

test("chat-image-navigation-shortcuts-002 an unreadable image explains the failure and lets the reader continue", async () => {
  vi.spyOn(HTMLImageElement.prototype, "decode").mockResolvedValue();
  const missing = attachment("second.png", "image/png");
  const cover = artifactFile("first.png", { contentType: "image/png" });
  const restricted = artifactFile(missing.filename, {
    id: missing.id,
    contentType: missing.contentType,
    url: "https://app.okou.ai" + missing.path,
  });
  const lastFile = artifactFile("third.png", { contentType: "image/png" });
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Removed gallery image" },
    });
  });
  await openMessageFile(context, cover, {
    host: "app.okou.ai",
    relatedFiles: [restricted, lastFile],
  });
  (await screen.findByRole("group", { name: "first.png preview" })).focus();
  await userEvent.keyboard("{ArrowRight}");
  await screen.findByRole("heading", { name: "You can’t view this artifact" });
  await userEvent.keyboard("{ArrowRight}");
  const last = await screen.findByRole("group", { name: "third.png preview" });
  await waitFor(() => {
    const image = within(last).getByAltText("third.png");
    expect(image).toHaveAttribute("src", lastFile.url);
    expect(image).toBeVisible();
  });
});

test("chat-image-navigation-shortcuts-004 the sidebar keeps keyboard focus until the private image has decoded", async () => {
  const privateImage = attachment("map-detail.png", "image/png");
  const signed = "https://cdn.example.test/signed/sidebar-second.png";
  const lookup = context.mocks.deferred<void>();
  const releaseUrl = context.mocks.deferred<void>();
  const decoding = context.mocks.deferred<void>();
  const pixels = context.mocks.deferred<void>();
  context.mocks.api(
    artifactReferencesContract.resolve,
    async ({ params, withSignal, respond }) => {
      expect("/artifacts/" + params.reference).toBe(privateImage.path);
      if (!lookup.settled()) {
        lookup.resolve();
      }
      await withSignal(releaseUrl.promise);
      return respond(200, {
        url: signed,
        downloadUrl: signed,
        filename: privateImage.filename,
        contentType: privateImage.contentType,
        target: { kind: "file", id: privateImage.id },
        expiresAt: "2099-01-01T00:00:00Z",
      });
    },
  );
  vi.spyOn(HTMLImageElement.prototype, "decode").mockImplementation(function (
    this: HTMLImageElement,
  ) {
    if (this.src === signed) {
      if (!decoding.settled()) {
        decoding.resolve();
      }
      return pixels.promise;
    }
    return Promise.resolve();
  });
  const cover = artifactFile("map-cover.png", { contentType: "image/png" });
  const detail = artifactFile("map-detail.png", {
    id: privateImage.id,
    contentType: "image/png",
    url: "https://app.okou.ai" + privateImage.path,
  });
  await openMessageFile(context, cover, {
    host: "app.okou.ai",
    relatedFiles: [detail],
  });
  click(await findFastControl("button", /open in split view/i));
  const sidebar = await screen.findByTestId("artifact-sidebar");
  const first = await within(sidebar).findByRole("group", {
    name: "map-cover.png preview",
  });
  await waitFor(() => {
    expect(within(first).getByAltText(cover.filename)).toBeVisible();
  });
  first.focus();
  await userEvent.keyboard("{ArrowRight}");
  await waitFor(() => {
    expect(lookup.settled()).toBeTruthy();
  });
  const second = await within(sidebar).findByRole("group", {
    name: "map-detail.png preview",
  });
  expect(second).toHaveFocus();
  const pendingImage = within(second).queryByAltText<HTMLImageElement>(
    detail.filename,
  );
  expect([undefined, cover.url]).toContain(pendingImage?.src);
  releaseUrl.resolve();
  await waitFor(() => {
    expect(decoding.settled()).toBeTruthy();
  });
  await waitFor(() => {
    const image = within(second).getByAltText(detail.filename);
    expect(image).toHaveAttribute("src", signed);
    expect(image).not.toBeVisible();
  });
  expect(second).toHaveFocus();
  pixels.resolve();
  await waitFor(() => {
    expect(within(second).getByAltText(detail.filename)).toBeVisible();
  });
  expect(second).toHaveFocus();
});
