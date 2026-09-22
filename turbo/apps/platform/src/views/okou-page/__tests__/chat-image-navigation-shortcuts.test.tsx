import { chatThreadArtifactsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { SIDEBAR_DESKTOP_MEDIA_QUERY } from "../sidebar-breakpoint.ts";
import {
  ATTACHMENT_RUN_ID,
  ATTACHMENT_THREAD_ID,
  artifactFile,
  draftAttachment,
  draftForAttachment,
  findNamedButton,
  getNamedButton,
  mockAttachmentChat,
  publicArtifactUrl,
  queryNamedButton,
} from "./chat-attachment-test-helpers.ts";

const context = testContext();

function galleryFiles(refreshed = false) {
  return ["first", "second", "third"].map((name) => {
    return artifactFile(`${name}${refreshed ? "-refreshed" : ""}.png`, {
      id: `shortcut-${name}`,
      contentType: "image/png",
      url: publicArtifactUrl(`${name}.png`),
    });
  });
}

function mockGallery(): void {
  context.mocks.browser.matchMedia((query) => {
    return (
      query === SIDEBAR_DESKTOP_MEDIA_QUERY || query === "(min-width: 1280px)"
    );
  });
  mockAttachmentChat(context, {
    chatEvents: [
      {
        id: "shortcut-gallery",
        role: "assistant",
        content: ["first", "second", "third"]
          .map((name) => {
            return `![${name}.png](${publicArtifactUrl(`${name}.png`)})`;
          })
          .join("\n"),
        runId: ATTACHMENT_RUN_ID,
        runEventId: "shortcut-gallery-event",
        sequenceNumber: 1,
        createdAt: "2026-03-10T00:00:01Z",
      },
    ],
    artifacts: galleryFiles(),
    draft: draftForAttachment(draftAttachment("draft.png"), "Draft message"),
  });
}

function mockArtifactListRefresh(outcome: "success" | "failure") {
  const refresh = {
    active: false,
    started: context.mocks.deferred<void>(),
    ready: context.mocks.deferred<void>(),
  };
  context.mocks.api(
    chatThreadArtifactsContract.list,
    async ({ respond, withSignal }) => {
      if (refresh.active) {
        refresh.started.resolve();
        await withSignal(refresh.ready.promise);
        if (outcome === "failure") {
          return respond(403, {
            error: { code: "FORBIDDEN", message: "Artifacts unavailable" },
          });
        }
      }
      return respond(200, {
        runs: [
          { runId: ATTACHMENT_RUN_ID, files: galleryFiles(refresh.active) },
        ],
      });
    },
  );
  return refresh;
}

async function openGallery(): Promise<HTMLElement> {
  const thumbnail = await screen.findByAltText("first.png");
  const action = thumbnail.closest<HTMLElement>("a, button");
  if (!action) {
    throw new Error("Expected the first image's preview action");
  }
  click(action);
  return screen.findByRole("dialog", { name: "first.png preview" });
}

async function openGallerySidebar(
  user: ReturnType<typeof userEvent.setup>,
): Promise<HTMLElement> {
  await openGallery();
  click(await findNamedButton("Open in split view"));
  const sidebar = await screen.findByTestId("artifact-sidebar");
  await expect(
    within(sidebar).findByTestId("artifact-sidebar-body-image"),
  ).resolves.toHaveAttribute("alt", "first.png");
  await waitFor(() => {
    expect(screen.queryByTestId("attachment-lightbox")).toBeNull();
  });
  // The viewer restores focus to the composer on close. A user clicks the
  // sidebar before using its arrows, otherwise those keys edit the draft.
  await user.click(within(sidebar).getByText("first.png"));
  return sidebar;
}

async function expectImage(surface: "lightbox" | "sidebar", filename: string) {
  await waitFor(() => {
    expect(
      screen.getByTestId(
        surface === "lightbox"
          ? "attachment-lightbox-image"
          : "artifact-sidebar-body-image",
      ),
    ).toHaveAttribute("alt", filename);
  });
}

test("Arrow keys follow the current image across rerenders, boundaries, and reopening", async () => {
  mockGallery();
  const user = userEvent.setup({ delay: null });
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  const dialog = await openGallery();

  await user.keyboard("{ArrowRight}");
  await expectImage("lightbox", "second.png");
  await user.keyboard("{ArrowRight}");
  await expectImage("lightbox", "third.png");
  expect(queryNamedButton("Next image artifact", dialog)).toBeNull();
  await user.keyboard("{ArrowRight}");
  expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
    "alt",
    "third.png",
  );
  await user.keyboard("{ArrowLeft}");
  await expectImage("lightbox", "second.png");

  click(getNamedButton("Close", dialog));
  await waitFor(() => {
    expect(screen.queryByTestId("attachment-lightbox")).toBeNull();
  });
  await user.keyboard("{ArrowRight}");
  expect(screen.queryByTestId("attachment-lightbox")).toBeNull();

  await openGallery();
  await user.keyboard("{ArrowRight}");
  await expectImage("lightbox", "second.png");
});

test("Modified arrow keys leave the current image alone", async () => {
  mockGallery();
  const user = userEvent.setup({ delay: null });
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  await openGallery();

  await user.keyboard(
    "{Shift>}{ArrowRight}{/Shift}{Control>}{ArrowRight}{/Control}{Alt>}{ArrowRight}{/Alt}{Meta>}{ArrowRight}{/Meta}",
  );
  expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
    "alt",
    "first.png",
  );
  await user.keyboard("{ArrowRight}");
  await expectImage("lightbox", "second.png");
});

test("Sidebar arrows yield to text editing and keep working across fullscreen changes", async () => {
  mockGallery();
  const user = userEvent.setup({ delay: null });
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  const sidebar = await openGallerySidebar(user);
  const composer = await screen.findByRole("textbox", { name: "Message" });
  await user.click(composer);
  expect(composer).toHaveFocus();
  await user.keyboard("{ArrowRight}");
  expect(screen.getByTestId("artifact-sidebar-body-image")).toHaveAttribute(
    "alt",
    "first.png",
  );

  click(getNamedButton("Next image artifact", sidebar));
  await expectImage("sidebar", "second.png");
  await user.click(getNamedButton("Enter fullscreen", sidebar));
  await findNamedButton("Exit fullscreen", sidebar);
  await user.keyboard("{ArrowRight}");
  await expectImage("sidebar", "third.png");
  await user.click(getNamedButton("Exit fullscreen", sidebar));
  await findNamedButton("Enter fullscreen", sidebar);
  await user.keyboard("{ArrowLeft}");
  await expectImage("sidebar", "second.png");

  await user.click(composer);
  await user.keyboard("{ArrowLeft}");
  expect(screen.getByTestId("artifact-sidebar-body-image")).toHaveAttribute(
    "alt",
    "second.png",
  );
});

test("A lightbox without navigation still owns arrows while the sidebar is open", async () => {
  mockGallery();
  const user = userEvent.setup({ delay: null });
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  const sidebar = await openGallerySidebar(user);
  click(await findNamedButton("Open image preview for draft.png"));
  const dialog = await screen.findByRole("dialog", {
    name: "draft.png preview",
  });
  expect(queryNamedButton("Next image artifact", dialog)).toBeNull();

  await user.keyboard("{ArrowRight}");
  expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
    "alt",
    "draft.png",
  );
  expect(screen.getByTestId("artifact-sidebar-body-image")).toHaveAttribute(
    "alt",
    "first.png",
  );

  click(getNamedButton("Close", dialog));
  await waitFor(() => {
    expect(screen.queryByTestId("attachment-lightbox")).toBeNull();
  });
  await user.click(within(sidebar).getByText("first.png"));
  await user.keyboard("{ArrowRight}");
  await expectImage("sidebar", "second.png");
  expect(screen.queryByTestId("attachment-lightbox")).toBeNull();
});

test("Sidebar navigation becomes available when the artifact list arrives", async () => {
  mockGallery();
  const ready = context.mocks.deferred<void>();
  context.mocks.api(
    chatThreadArtifactsContract.list,
    async ({ respond, withSignal }) => {
      await withSignal(ready.promise);
      return respond(200, {
        runs: [{ runId: ATTACHMENT_RUN_ID, files: galleryFiles() }],
      });
    },
  );
  const user = userEvent.setup({ delay: null });
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  const sidebar = await openGallerySidebar(user);
  expect(queryNamedButton("Next image artifact", sidebar)).toBeNull();
  await user.keyboard("{ArrowRight}");
  expect(screen.getByTestId("artifact-sidebar-body-image")).toHaveAttribute(
    "alt",
    "first.png",
  );

  ready.resolve();
  await findNamedButton("Next image artifact", sidebar);
  await user.keyboard("{ArrowRight}");
  await expectImage("sidebar", "second.png");
});

test("Sidebar navigation keeps the previous result during refresh and uses refreshed metadata", async () => {
  mockGallery();
  const refresh = mockArtifactListRefresh("success");
  const user = userEvent.setup({ delay: null });
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  const sidebar = await openGallerySidebar(user);
  await findNamedButton("Next image artifact", sidebar);

  refresh.active = true;
  context.mocks.ably.trigger(
    `chatThreadArtifactsChanged:${ATTACHMENT_THREAD_ID}`,
  );
  await refresh.started.promise;
  await user.keyboard("{ArrowRight}");
  await expectImage("sidebar", "second.png");
  expect(getNamedButton("Next image artifact", sidebar)).toBeInTheDocument();

  refresh.ready.resolve();
  await expectImage("sidebar", "second-refreshed.png");
  await user.keyboard("{ArrowRight}");
  await expectImage("sidebar", "third-refreshed.png");
});

test("Sidebar navigation handles a failed refresh and recovers when artifacts return", async () => {
  mockGallery();
  const refresh = mockArtifactListRefresh("failure");
  const user = userEvent.setup({ delay: null });
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  const sidebar = await openGallerySidebar(user);
  await findNamedButton("Next image artifact", sidebar);

  refresh.active = true;
  context.mocks.ably.trigger(
    `chatThreadArtifactsChanged:${ATTACHMENT_THREAD_ID}`,
  );
  await refresh.started.promise;
  await user.keyboard("{ArrowRight}");
  await expectImage("sidebar", "second.png");
  expect(getNamedButton("Next image artifact", sidebar)).toBeInTheDocument();

  refresh.ready.resolve();
  await waitFor(() => {
    expect(queryNamedButton("Next image artifact", sidebar)).toBeNull();
  });
  await user.keyboard("{ArrowLeft}");
  expect(screen.getByTestId("artifact-sidebar-body-image")).toHaveAttribute(
    "alt",
    "second.png",
  );

  refresh.active = false;
  context.mocks.ably.trigger(
    `chatThreadArtifactsChanged:${ATTACHMENT_THREAD_ID}`,
  );
  await findNamedButton("Previous image artifact", sidebar);
  await user.keyboard("{ArrowLeft}");
  await expectImage("sidebar", "first.png");
});
