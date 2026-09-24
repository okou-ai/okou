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
  findNamedButton,
  getNamedButton,
  mockAttachmentChat,
  publicArtifactUrl,
  queryNamedButton,
} from "./chat-attachment-test-helpers.ts";

const context = testContext();

function galleryFiles() {
  return ["first", "second", "third"].map((name) => {
    return artifactFile(`${name}.png`, {
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
  });
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

test("Arrow keys move between gallery images and stop at the boundaries", async () => {
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
});

test("Sidebar arrows navigate images and yield to text editing", async () => {
  mockGallery();
  const user = userEvent.setup({ delay: null });
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  const sidebar = await openGallerySidebar(user);

  await user.keyboard("{ArrowRight}");
  await expectImage("sidebar", "second.png");
  click(getNamedButton("Next image artifact", sidebar));
  await expectImage("sidebar", "third.png");

  const composer = await screen.findByRole("textbox", { name: "Message" });
  await user.click(composer);
  expect(composer).toHaveFocus();
  await user.keyboard("{ArrowLeft}");
  expect(screen.getByTestId("artifact-sidebar-body-image")).toHaveAttribute(
    "alt",
    "third.png",
  );
});
