import {
  artifactReferencePath,
  artifactReferencesContract,
} from "@okouai/api-contracts/contracts/artifact-references";
import {
  artifactSharesContract,
  type ArtifactShareStatus,
} from "@okouai/api-contracts/contracts/artifact-shares";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
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

function galleryFiles(imageUrl = publicArtifactUrl) {
  return ["first", "second", "third"].map((name) => {
    return artifactFile(`${name}.png`, {
      id: `shortcut-${name}`,
      contentType: "image/png",
      url: imageUrl(`${name}.png`),
    });
  });
}

function mockGallery(imageUrl = publicArtifactUrl): void {
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
            return `![${name}.png](${imageUrl(`${name}.png`)})`;
          })
          .join("\n"),
        runId: ATTACHMENT_RUN_ID,
        runEventId: "shortcut-gallery-event",
        sequenceNumber: 1,
        createdAt: "2026-03-10T00:00:01Z",
      },
    ],
    artifacts: galleryFiles(imageUrl),
  });
}

async function openGallery(): Promise<HTMLElement> {
  const thumbnail = await screen.findByAltText("first.png");
  const action = thumbnail.closest<HTMLElement>("a, button");
  if (!action) {
    throw new Error("Expected the first image's preview action");
  }
  click(action);
  const dialog = await screen.findByRole("dialog", {
    name: "first.png preview",
  });
  await waitFor(() => {
    expect(within(dialog).getByRole("group")).toHaveFocus();
  });
  return dialog;
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
  await user.click(within(sidebar).getByTestId("zoomable-image-canvas"));
  expect(
    within(sidebar).getByRole("group", { name: "first.png preview" }),
  ).toHaveFocus();
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

test("Sidebar navigation decodes a resolved private URL without replacing its focus owner", async () => {
  const id = "f0000000-0000-4000-a000-000000000092";
  const canonical = artifactReferencePath(id, "second.png");
  const secondUrl = publicArtifactUrl("second.png");
  const urlReady = context.mocks.deferred<void>();
  const decodeReady = context.mocks.deferred<void>();
  const decodedSources: string[] = [];
  mockGallery((filename) => {
    return filename === "second.png" ? canonical : publicArtifactUrl(filename);
  });
  context.mocks.api(artifactReferencesContract.resolve, async ({ respond }) => {
    await urlReady.promise;
    return respond(200, {
      url: secondUrl,
      filename: "second.png",
      contentType: "image/png",
      expiresAt: "2099-01-01T00:00:00.000Z",
      target: { kind: "file", id },
    });
  });
  vi.spyOn(HTMLImageElement.prototype, "decode").mockImplementation(function (
    this: HTMLImageElement,
  ) {
    Object.defineProperties(this, {
      naturalWidth: { configurable: true, value: 1200 },
      naturalHeight: { configurable: true, value: 700 },
    });
    if (this.dataset.testid === "artifact-sidebar-body-image") {
      decodedSources.push(this.src);
      if (this.src === secondUrl) {
        return decodeReady.promise;
      }
    }
    return Promise.resolve();
  });
  const user = userEvent.setup({ delay: null });
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  const sidebar = await openGallerySidebar(user);
  const owner = within(sidebar).getByRole("group");

  await user.keyboard("{ArrowRight}");
  expect(owner).toHaveFocus();
  urlReady.resolve();
  await waitFor(() => {
    expect(decodedSources).toContain(secondUrl);
  });
  const image = within(sidebar).getByTestId("artifact-sidebar-body-image");
  expect(image).toHaveAttribute("src", secondUrl);
  expect(image).not.toBeVisible();
  expect(owner).toHaveFocus();
  decodeReady.resolve();
  await waitFor(() => {
    expect(image).toBeVisible();
  });
  expect(within(sidebar).getByRole("group")).toBe(owner);
  expect(owner).toHaveFocus();
});

test("Image shortcuts yield to modifiers and toolbar menus in both fullscreen modes", async () => {
  mockGallery();
  const user = userEvent.setup({ delay: null });
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  const dialog = await openGallery();

  for (const modifier of ["Alt", "Control", "Meta", "Shift"]) {
    await user.keyboard(`{${modifier}>}{ArrowRight}{/${modifier}}`);
    expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
      "alt",
      "first.png",
    );
  }
  await user.click(getNamedButton("Download options", dialog));
  const menu = await screen.findByRole("menu");
  await user.keyboard("{ArrowRight}");
  expect(menu).toBeInTheDocument();
  expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
    "alt",
    "first.png",
  );
  await user.keyboard("{Escape}");
  await user.click(getNamedButton("Enter fullscreen", dialog));
  await user.keyboard("{ArrowRight}");
  expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
    "alt",
    "first.png",
  );
  await user.click(within(dialog).getByTestId("artifact-dialog-image-stage"));
  await user.keyboard("{ArrowRight}");
  await expectImage("lightbox", "second.png");
  await user.click(getNamedButton("Exit fullscreen", dialog));
  await user.click(getNamedButton("Open in split view", dialog));
  const sidebar = await screen.findByTestId("artifact-sidebar");
  await waitFor(() => {
    return expect(screen.queryByTestId("attachment-lightbox")).toBeNull();
  });
  await user.click(getNamedButton("Enter fullscreen", sidebar));
  await user.keyboard("{ArrowRight}");
  expect(screen.getByTestId("artifact-sidebar-body-image")).toHaveAttribute(
    "alt",
    "second.png",
  );
  await user.click(within(sidebar).getByTestId("zoomable-image-canvas"));
  await user.keyboard("{ArrowRight}");
  await expectImage("sidebar", "third.png");
  await user.click(getNamedButton("Exit fullscreen", sidebar));
  await user.click(within(sidebar).getByTestId("zoomable-image-canvas"));
  await user.keyboard("{ArrowLeft}");
  await expectImage("sidebar", "second.png");
});

test("Share permission radios own their arrows without changing the lightbox image", async () => {
  const id = "f0000000-0000-4000-a000-000000000091";
  const canonical = artifactReferencePath(id, "first.png");
  mockGallery((filename) => {
    return filename === "first.png" ? canonical : publicArtifactUrl(filename);
  });
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    return respond(200, {
      url: publicArtifactUrl("first.png"),
      filename: "first.png",
      contentType: "image/png",
      expiresAt: "2099-01-01T00:00:00.000Z",
      target: { kind: "file", id },
    });
  });
  context.mocks.api(artifactReferencesContract.publicUrl, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Artifact unavailable" },
    });
  });
  let status: ArtifactShareStatus = {
    ownerUrl: new URL(canonical, "http://localhost").href,
    shortUrl: null,
    shareId: null,
    audience: "private",
    organization: { id: "org_test", name: "Acme" },
    selectedTarget: null,
    selectedVersion: null,
    candidateVersion: null,
    url: null,
  };
  context.mocks.api(artifactSharesContract.status, ({ respond }) => {
    return respond(200, status);
  });
  context.mocks.api(artifactSharesContract.update, ({ body, respond }) => {
    status = { ...status, audience: body.audience };
    return respond(200, status);
  });
  const user = userEvent.setup({ delay: null });
  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.PrivateArtifacts]: true },
  });
  const dialog = await openGallery();
  await user.click(getNamedButton("Share", dialog));
  const group = await screen.findByRole("radiogroup");
  const radios = queryAllByRoleFast("radio", group);
  const privateOption = radios[0]!;
  const organizationOption = radios[1]!;
  await user.click(privateOption);
  await user.keyboard("{ArrowRight}");
  await waitFor(() => {
    return expect(organizationOption).toHaveAttribute("aria-checked", "true");
  });
  expect(organizationOption).toHaveFocus();
  expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
    "src",
    publicArtifactUrl("first.png"),
  );
  await user.keyboard("{ArrowLeft}");
  await waitFor(() => {
    return expect(privateOption).toHaveAttribute("aria-checked", "true");
  });
  expect(privateOption).toHaveFocus();
  expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
    "src",
    publicArtifactUrl("first.png"),
  );
  await user.keyboard("{Escape}");
  await user.click(within(dialog).getByTestId("artifact-dialog-image-stage"));
  await user.keyboard("{ArrowRight}");
  await expectImage("lightbox", "second.png");
});
