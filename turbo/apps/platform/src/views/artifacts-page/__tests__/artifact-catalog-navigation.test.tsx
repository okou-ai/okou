import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { chatSearchContract } from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { act, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  installContinuityWorkspace,
  textContinuityDraft,
} from "../../okou-page/__tests__/chat-continuity-test-helpers.ts";
import { chatListThread } from "../../okou-page/__tests__/chat-list-test-helpers.ts";
import {
  artifact,
  findArtifactAction,
  getButtonByName,
} from "./artifact-catalog-test-helpers.ts";

const context = testContext();

test("Browser history restores a searched preview until Close replaces it with the catalog", async () => {
  const sourceThread = chatListThread(1, "Source research");
  const sourcePath = `/chats/${sourceThread.id}?context=research#draft`;
  const sourceDraft = "Keep my source research draft";
  const workspace = installContinuityWorkspace(context, {
    caseId: 97,
    threads: [sourceThread],
    drafts: new Map([[sourceThread.id, textContinuityDraft(sourceDraft)]]),
    chatEventRows: [],
  });
  context.mocks.browser.matchMedia((query) => {
    return (
      query === "(display-mode: standalone)" || query === "(min-width: 48rem)"
    );
  });
  const selected = artifact({
    id: "a0000000-0000-4000-a000-000000000099",
    kind: "image",
    title: "selected-image.png",
  });
  const recent = artifact({
    id: "a0000000-0000-4000-a000-000000000098",
    kind: "image",
    title: "recent-image.png",
  });
  context.mocks.api(chatSearchContract.search, ({ respond }) => {
    return respond(200, { results: [] });
  });
  context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
    if (query.keyword || query.cursor === "image-cursor-2") {
      return respond(200, { artifacts: [selected], nextCursor: null });
    }
    return respond(200, {
      artifacts: [recent],
      nextCursor: "image-cursor-2",
    });
  });
  context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
    return respond(200, {
      ...selected,
      kind: "image",
      file: {
        id: "f0000000-0000-4000-a000-000000000099",
        filename: selected.title,
        contentType: "image/png",
        size: 4096,
        url: "https://artifacts.example.com/selected-image.png",
        previewImageUrl: null,
      },
      model: "image-model",
      provider: "image-provider",
    });
  });

  async function expectSourceChat(): Promise<void> {
    const composer = await screen.findByRole("textbox", { name: "Message" });
    await waitFor(() => {
      expect(composer).toHaveTextContent(sourceDraft);
    });
    expect(
      `${window.location.pathname}${window.location.search}${window.location.hash}`,
    ).toBe(sourcePath);
    expect(screen.queryByTestId("attachment-lightbox")).not.toBeInTheDocument();
  }

  await setupPage({
    context,
    path: sourcePath,
    ...workspace.pageOptions,
    featureSwitches: { [FeatureSwitchKey.ArtifactSidebarPreview]: false },
  });
  await expectSourceChat();

  click(getButtonByName("Search workspace"));
  const searchDialog = await screen.findByRole("dialog", {
    name: "Search workspace...",
  });
  await fill(
    within(searchDialog).getByPlaceholderText("Search workspace..."),
    "selected",
  );
  const result = await within(searchDialog).findByRole("option", {
    name: /selected-image\.png/u,
  });
  click(result);

  const preview = await screen.findByTestId("attachment-lightbox");
  await expect(
    within(preview).findByTestId("attachment-lightbox-image"),
  ).resolves.toHaveAttribute(
    "src",
    "https://artifacts.example.com/selected-image.png",
  );
  expect(window.location.pathname).toBe("/artifacts");
  expect(new URLSearchParams(window.location.search).get("artifact")).toBe(
    selected.id,
  );

  act(() => {
    window.history.back();
  });
  await expectSourceChat();

  act(() => {
    window.history.forward();
  });
  const reopened = await screen.findByTestId("attachment-lightbox");
  await expect(
    within(reopened).findByTestId("attachment-lightbox-image"),
  ).resolves.toHaveAttribute(
    "src",
    "https://artifacts.example.com/selected-image.png",
  );
  expect(window.location.pathname).toBe("/artifacts");
  expect(new URLSearchParams(window.location.search).get("artifact")).toBe(
    selected.id,
  );

  click(getButtonByName("Close", reopened));

  await waitFor(() => {
    expect(window.location.search).toBe("?tab=image");
    expect(screen.queryByTestId("attachment-lightbox")).not.toBeInTheDocument();
  });
  await expect(findArtifactAction(selected.title)).resolves.toBeInTheDocument();

  act(() => {
    window.history.back();
  });
  await expectSourceChat();

  act(() => {
    window.history.forward();
  });
  // The selected result is on a later page: restoring it also exercises the
  // catalog's scroll target without inspecting private history-state fields.
  await expect(findArtifactAction(selected.title)).resolves.toBeInTheDocument();
  expect(window.location.pathname).toBe("/artifacts");
  expect(window.location.search).toBe("?tab=image");
  expect(window.location.hash).toBe("");
  expect(getButtonByName("Show image artifacts")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(findArtifactAction(recent.title)).resolves.toBeInTheDocument();
  expect(screen.queryByTestId("attachment-lightbox")).not.toBeInTheDocument();
});
