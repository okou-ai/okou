import {
  artifactCatalogContract,
  type ArtifactDetail,
} from "@okouai/api-contracts/contracts/artifact-catalog";
import { chatSearchContract } from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";

import {
  click,
  fill,
  holdElementAnimations,
  setupPage,
  startPage,
} from "../../../__tests__/page-helper.ts";
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
  getCatalogViewport,
} from "./artifact-catalog-test-helpers.ts";

const context = testContext();
type ImageDetail = Extract<ArtifactDetail, { kind: "image" }>;

function imageDetail(slot: number, title: string): ImageDetail {
  const suffix = slot.toString().padStart(12, "0");
  return {
    ...artifact({
      id: `a0000000-0000-4000-a000-${suffix}`,
      kind: "image",
      title,
    }),
    kind: "image",
    file: {
      id: `f0000000-0000-4000-a000-${suffix}`,
      filename: title,
      contentType: "image/png",
      size: 4096,
      url: `https://artifacts.example.com/${title}`,
      previewImageUrl: null,
    },
    model: null,
    provider: null,
  };
}

const first = imageDetail(1, "selection-a.png");
const second = imageDetail(2, "selection-b.png");
const catalogQuery = "tab=image&source=catalog&tag=one&tag=two";
const catalogHash = "#selection";

function mockSelectionCatalog(): void {
  context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
    return respond(200, {
      artifacts: query.keyword ? [first] : [first, second],
      nextCursor: null,
    });
  });
  context.mocks.api(artifactCatalogContract.get, ({ params, respond }) => {
    const detail = [first, second].find((item) => {
      return item.id === params.artifactId;
    });
    if (!detail) {
      throw new Error(`Unexpected artifact detail: ${params.artifactId}`);
    }
    return respond(200, detail);
  });
}

async function expectImagePreview(
  sidebar: boolean,
  detail: ImageDetail,
): Promise<HTMLElement> {
  const previewTestId = sidebar ? "artifact-sidebar" : "attachment-lightbox";
  await waitFor(() => {
    const preview = screen.getByTestId(previewTestId);
    expect(
      within(preview).getByTestId(
        sidebar ? "artifact-sidebar-body-image" : "attachment-lightbox-image",
      ),
    ).toHaveAttribute("src", detail.file.url);
  });
  return screen.getByTestId(previewTestId);
}

function expectCatalogUrl(
  selectedId: string | null,
  query: string,
  hash = "",
): void {
  expect(window.location.pathname).toBe("/artifacts");
  const params = new URLSearchParams(window.location.search);
  expect(params.getAll("artifact")).toStrictEqual(
    selectedId ? [selectedId] : [],
  );
  params.delete("artifact");
  expect(params.toString()).toBe(query);
  expect(window.location.hash).toBe(hash);
}

test.each([false, true])(
  "Ordinary card selection and Close preserve repeated query parameters and the hash (sidebar=%s)",
  async (sidebar) => {
    mockSelectionCatalog();
    await setupPage({
      context,
      path: `/artifacts?${catalogQuery}${catalogHash}`,
      featureSwitches: { [FeatureSwitchKey.ArtifactSidebarPreview]: sidebar },
    });
    const card = await findArtifactAction(first.title);
    const user = userEvent.setup({ delay: null });

    await user.click(card);
    const preview = await expectImagePreview(sidebar, first);
    await waitFor(() => {
      expectCatalogUrl(first.id, catalogQuery, catalogHash);
    });

    click(getButtonByName(sidebar ? "Close artifact" : "Close", preview));
    await waitFor(() => {
      expectCatalogUrl(null, catalogQuery, catalogHash);
      expect(preview).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(card).toHaveFocus();
    });
  },
);

test.each([false, true])(
  "Selecting and dismissing B after workspace search add no history entries before the source chat (sidebar=%s)",
  async (sidebar) => {
    const sourceThread = chatListThread(1, "Selection source research");
    const sourcePath = `/chats/${sourceThread.id}?context=research#draft`;
    const sourceDraft = "Keep the selection source draft";
    const workspace = installContinuityWorkspace(context, {
      caseId: 98,
      threads: [sourceThread],
      drafts: new Map([[sourceThread.id, textContinuityDraft(sourceDraft)]]),
      chatEventRows: [],
    });
    context.mocks.browser.matchMedia((query) => {
      return (
        query === "(display-mode: standalone)" || query === "(min-width: 48rem)"
      );
    });
    mockSelectionCatalog();
    context.mocks.api(chatSearchContract.search, ({ respond }) => {
      return respond(200, { results: [] });
    });
    await setupPage({
      context,
      path: sourcePath,
      ...workspace.pageOptions,
      featureSwitches: { [FeatureSwitchKey.ArtifactSidebarPreview]: sidebar },
    });
    const composer = await screen.findByRole("textbox", { name: "Message" });
    await waitFor(() => {
      expect(composer).toHaveTextContent(sourceDraft);
    });

    click(getButtonByName("Search workspace"));
    const searchDialog = await screen.findByRole("dialog", {
      name: "Search workspace...",
    });
    await fill(
      within(searchDialog).getByPlaceholderText("Search workspace..."),
      "selection-a",
    );
    const result = await within(searchDialog).findByRole("option", {
      name: /selection-a\.png/u,
    });
    click(result);
    const searchedPreview = await expectImagePreview(sidebar, first);
    await waitFor(() => {
      expectCatalogUrl(first.id, "tab=image");
    });

    // The modal must be dismissed to reach a card; the sidebar leaves the
    // catalog interactive, so it also covers a direct A -> B replacement.
    if (!sidebar) {
      click(getButtonByName("Close", searchedPreview));
    }
    await waitFor(() => {
      expectCatalogUrl(sidebar ? first.id : null, "tab=image");
      expect(searchedPreview.isConnected).toBe(sidebar);
    });
    click(await findArtifactAction(second.title));
    await expectImagePreview(sidebar, second);
    await waitFor(() => {
      expectCatalogUrl(second.id, "tab=image");
    });

    act(() => {
      window.history.back();
    });
    const restoredComposer = await screen.findByRole("textbox", {
      name: "Message",
    });
    await waitFor(() => {
      expect(restoredComposer).toHaveTextContent(sourceDraft);
    });
    expect(
      `${window.location.pathname}${window.location.search}${window.location.hash}`,
    ).toBe(sourcePath);
    expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
    expect(screen.queryByTestId("attachment-lightbox")).not.toBeInTheDocument();

    act(() => {
      window.history.forward();
    });
    const restoredPreview = await expectImagePreview(sidebar, second);
    expectCatalogUrl(second.id, "tab=image");

    click(
      getButtonByName(sidebar ? "Close artifact" : "Close", restoredPreview),
    );
    await waitFor(() => {
      expectCatalogUrl(null, "tab=image");
      expect(restoredPreview).not.toBeInTheDocument();
    });
    act(() => {
      window.history.back();
    });
    const composerAfterDismissal = await screen.findByRole("textbox", {
      name: "Message",
    });
    await waitFor(() => {
      expect(composerAfterDismissal).toHaveTextContent(sourceDraft);
    });
    expect(
      `${window.location.pathname}${window.location.search}${window.location.hash}`,
    ).toBe(sourcePath);
  },
);

test("A sidebar card replaces deep-linked A with B even when A's detail arrives late", async () => {
  const releaseFirst = context.mocks.deferred<void>();
  mockSelectionCatalog();
  context.mocks.api(
    artifactCatalogContract.get,
    async ({ params, respond }) => {
      if (params.artifactId === first.id) {
        await releaseFirst.promise;
        return respond(200, first);
      }
      return respond(200, second);
    },
  );
  const page = await startPage({
    context,
    path: `/artifacts?${catalogQuery}&artifact=${first.id}${catalogHash}`,
    featureSwitches: { [FeatureSwitchKey.ArtifactSidebarPreview]: true },
  });
  await page.content;
  try {
    await expect(
      screen.findByRole("complementary", { name: "Artifact" }),
    ).resolves.toBeInTheDocument();
    const card = await findArtifactAction(second.title);

    click(card);
    await expectImagePreview(true, second);
    await waitFor(() => {
      expectCatalogUrl(second.id, catalogQuery, catalogHash);
    });
  } finally {
    releaseFirst.resolve();
    await page.ready;
  }

  const preview = await expectImagePreview(true, second);
  expectCatalogUrl(second.id, catalogQuery, catalogHash);
  expect(within(preview).queryByAltText(first.title)).not.toBeInTheDocument();
});

test.each([false, true])(
  "A fresh page hydrates selected B from its URL (sidebar=%s)",
  async (sidebar) => {
    mockSelectionCatalog();
    // A new page bootstrap at the saved URL is the refresh contract in the
    // page harness, which does not reload the browser document.
    await setupPage({
      context,
      path: `/artifacts?${catalogQuery}&artifact=${second.id}${catalogHash}`,
      featureSwitches: { [FeatureSwitchKey.ArtifactSidebarPreview]: sidebar },
    });

    const preview = await expectImagePreview(sidebar, second);
    expect(preview).toBeVisible();
    expectCatalogUrl(second.id, catalogQuery, catalogHash);
  },
);

test("Dismissing a loading entry does not scroll to it when ordinary paging later loads its card", async () => {
  const releaseFirst = context.mocks.deferred<void>();
  mockSelectionCatalog();
  context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
    return respond(200, {
      artifacts: query.cursor ? [first] : [second],
      nextCursor: query.cursor ? null : "later-page",
    });
  });
  context.mocks.api(artifactCatalogContract.get, async ({ respond }) => {
    await releaseFirst.promise;
    return respond(200, first);
  });
  const page = await startPage({
    context,
    path: `/artifacts?${catalogQuery}&artifact=${first.id}${catalogHash}`,
    featureSwitches: { [FeatureSwitchKey.ArtifactSidebarPreview]: true },
  });
  await page.content;
  try {
    const pending = await screen.findByRole("complementary", {
      name: "Artifact",
    });
    click(getButtonByName("Close artifact", pending));
    await waitFor(() => {
      expectCatalogUrl(null, catalogQuery, catalogHash);
      expect(pending).not.toBeInTheDocument();
      expect(getCatalogViewport()).toHaveFocus();
    });
  } finally {
    releaseFirst.resolve();
    await page.ready;
  }

  const viewport = getCatalogViewport();
  Object.defineProperties(viewport, {
    clientHeight: { configurable: true, value: 1000 },
    scrollHeight: { configurable: true, value: 5000 },
  });
  viewport.scrollTop = 2200;
  // Model the browser's observable scroll effect; happy-dom does not lay out cards.
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(
    function (this: HTMLElement) {
      if (this.dataset.artifactId === first.id) {
        viewport.scrollTop = 0;
      }
    },
  );

  fireEvent.scroll(viewport);
  await expect(findArtifactAction(first.title)).resolves.toBeInTheDocument();
  expect(getCatalogViewport().scrollTop).toBe(2200);
  expectCatalogUrl(null, catalogQuery, catalogHash);
});

test.each([
  { next: first, transition: "the same artifact" },
  { next: second, transition: "another artifact" },
])(
  "A pending modal exit cannot clear a reopened selection of $transition",
  async ({ next }) => {
    mockSelectionCatalog();
    await setupPage({
      context,
      path: `/artifacts?${catalogQuery}${catalogHash}`,
      featureSwitches: { [FeatureSwitchKey.ArtifactSidebarPreview]: false },
    });
    click(await findArtifactAction(first.title));
    const leaving = await expectImagePreview(false, first);
    const finishExit = holdElementAnimations(leaving);
    try {
      click(getButtonByName("Close", leaving));
      await waitFor(() => {
        expectCatalogUrl(null, catalogQuery, catalogHash);
      });
      expect(leaving).toBeInTheDocument();
      click(getButtonByName(`Preview ${next.title}`, getCatalogViewport()));
      await expectImagePreview(false, next);
    } finally {
      await act(finishExit);
    }

    const reopened = await expectImagePreview(false, next);
    expect(reopened).toBeVisible();
    expectCatalogUrl(next.id, catalogQuery, catalogHash);
    click(getButtonByName("Close", reopened));
    await waitFor(() => {
      expectCatalogUrl(null, catalogQuery, catalogHash);
      expect(reopened).not.toBeInTheDocument();
    });
  },
);
