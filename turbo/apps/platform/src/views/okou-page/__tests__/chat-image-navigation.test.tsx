import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import userEvent from "@testing-library/user-event";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { click, setupPage, fill } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  ATTACHMENT_THREAD_ID,
  findNamedLink,
  getNamedButton,
  mockAttachmentChat,
  mockMessageArtifactDetails,
  queryNamedButton,
  artifactFile,
  ATTACHMENT_RUN_ID,
  findNamedButton,
  findNamedMenuItem,
} from "./chat-attachment-test-helpers.ts";
import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import {
  artifactSummary,
  imageArtifactDetail,
  artifactRun,
  mockArtifactConversation,
  NAVIGATION_ARTIFACT_THREAD_ID,
} from "./chat-navigation-artifact-test-helpers.ts";
import { attachment } from "./attachment-preview-boundaries.ts";
import { openMessageFile } from "./chat-artifact-preview-test-helpers.ts";
import { artifactReferencePath } from "@okouai/api-contracts/validators/artifact-references";
import {
  completedConversation,
  createChatCapabilityHelpers,
  RUN_PATH,
} from "./chat-capability-test-helpers.ts";

const context = testContext();

function twoImageChat() {
  const names = ["quay.png", "harbor.png"];
  mockAttachmentChat(context, {
    chatEvents: [
      {
        role: "user",
        content: "Inspect both stations",
        createdAt: "2026-03-10T01:00:00Z",
        fileParts: names.map((filename) => {
          return {
            type: "file",
            filenameSnapshot: filename,
            fileId: filename,
            contentType: "image/png",
          };
        }),
      },
    ],
  });
}

async function openFirstPhoto() {
  await setupPage({
    context,
    path: "/chats/" + ATTACHMENT_THREAD_ID,
  });
  click(await findNamedLink("Preview quay.png"));
  return await screen.findByTestId("artifact-sidebar");
}

test("opens an uploaded photo and switches to its neighbor on browsers without URL.canParse", async () => {
  class BrowserURL extends URL {}
  Object.defineProperty(BrowserURL, "canParse", { value: undefined });
  vi.stubGlobal("URL", BrowserURL);
  twoImageChat();
  const sidebar = await openFirstPhoto();
  click(await findNamedButton("Next image artifact", sidebar));
  await expect(
    within(sidebar).findByRole("group", { name: "harbor.png preview" }),
  ).resolves.toBeVisible();
});

test("the same photo opens in its clicked message group without reading either thread list", async () => {
  const parts = (names: string[]) => {
    return names.map((filename) => {
      return {
        type: "file" as const,
        filenameSnapshot: filename,
        fileId: filename,
        contentType: "image/png",
      };
    });
  };
  mockAttachmentChat(context, {
    chatEvents: [
      {
        role: "user",
        content: "First pair",
        runId: ATTACHMENT_RUN_ID,
        createdAt: "2026-03-10T01:00:00Z",
        fileParts: parts(["same.png", "first-next.png"]),
      },
      {
        role: "assistant",
        content: "Read the first pair",
        runId: ATTACHMENT_RUN_ID,
        runEventId: "first-pair-response",
        sequenceNumber: 1,
        createdAt: "2026-03-10T01:01:00Z",
      },
      {
        role: "user",
        content: "Second pair",
        runId: "d0000000-0000-4000-a000-000000000082",
        createdAt: "2026-03-10T01:02:00Z",
        fileParts: parts(["same.png", "second-next.png"]),
      },
    ],
  });
  const listRequests: string[] = [];
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    listRequests.push("catalog");
    return respond(200, { artifacts: [], nextCursor: null });
  });
  await setupPage({ context, path: "/chats/" + ATTACHMENT_THREAD_ID });
  const secondMessage = (
    await findNamedLink("Preview second-next.png")
  ).closest<HTMLElement>('[data-role="user"]')!;
  click(await findNamedLink("Preview same.png", secondMessage));
  const sidebar = await screen.findByTestId("artifact-sidebar");
  click(await findNamedButton("Next image artifact", sidebar));
  await expect(
    within(sidebar).findByRole("group", {
      name: "second-next.png preview",
    }),
  ).resolves.toBeVisible();
  click(await findNamedButton("Previous image artifact", sidebar));
  await expect(
    within(sidebar).findByRole("group", { name: "same.png preview" }),
  ).resolves.toBeVisible();
  expect(listRequests).toStrictEqual([]);
});

test("an extensionless image uses its single detail for opening and returning from its neighbor", async () => {
  const id = "a7000000-0000-4000-a000-000000000c61";
  const first = artifactReferencePath(id);
  const second = artifactFile("neighbor.png", {
    url: artifactReferencePath("a7000000-0000-4000-a000-000000000c62"),
    contentType: "image/png",
  });
  mockAttachmentChat(context, {
    chatEvents: [
      {
        role: "assistant",
        content: `Open the [blueprint](${first}) or ![neighbor](${second.url}).`,
        runId: ATTACHMENT_RUN_ID,
        runEventId: "two-blueprints",
        sequenceNumber: 1,
        createdAt: "2026-03-10T00:00:01Z",
      },
    ],
  });
  const queries: string[] = [];
  mockMessageArtifactDetails(context, (url) => {
    queries.push(url);
    return [
      artifactFile("blueprint.png", { url: first, contentType: "image/png" }),
      second,
    ];
  });
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    const url =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3MoAAAAASUVORK5CYII=";
    return respond(200, {
      url,
      downloadUrl: url,
      expiresAt: "2099-01-01T00:00:00Z",
      filename: "blueprint.png",
      contentType: "image/png",
      target: { kind: "file", id },
    });
  });
  await setupPage({ context, path: "/chats/" + ATTACHMENT_THREAD_ID });
  await waitFor(() => {
    expect(
      document.querySelector('[data-role="assistant"] img[alt="neighbor.png"]'),
    ).toBeInTheDocument();
  });
  click(await findNamedLink("blueprint"));
  const sidebar = await screen.findByTestId("artifact-sidebar");
  await expect(
    within(sidebar).findByRole("group", { name: "blueprint.png preview" }),
  ).resolves.toBeVisible();
  click(await findNamedButton("Next image artifact", sidebar));
  await expect(
    within(sidebar).findByRole("group", { name: "neighbor.png preview" }),
  ).resolves.toBeVisible();
  click(await findNamedButton("Previous image artifact", sidebar));
  await expect(
    within(sidebar).findByRole("group", { name: "blueprint.png preview" }),
  ).resolves.toBeVisible();
  expect(
    queries.filter((url) => {
      return new URL(url, location.origin).pathname === first;
    }),
  ).toHaveLength(1);
  expect(
    queries.filter((url) => {
      return new URL(url, location.origin).pathname === second.url;
    }),
  ).toHaveLength(1);
});

test("a relative file link and its API URL share a detail and open the signed original", async () => {
  const path = "/api/web/file-url?file_id=file-blueprint&filename=Plan.png";
  const apiLink = "https://api.okou.ai" + path;
  mockAttachmentChat(context, {
    chatEvents: [
      {
        role: "assistant",
        content: `Use the [floor plan](${path}) or its [original file](${apiLink}).`,
        runId: ATTACHMENT_RUN_ID,
        runEventId: "plan-upload-links",
        sequenceNumber: 1,
        createdAt: "2026-03-10T00:00:01Z",
      },
    ],
  });
  const queries: string[] = [];
  mockMessageArtifactDetails(context, (url) => {
    queries.push(url);
    return [artifactFile("Plan.png", { url, contentType: "image/png" })];
  });
  const original = "https://media.example.test/authorized-plan.png";
  context.mocks.api(webFilesContract.fileUrl, ({ query, respond }) => {
    expect(query.file_id).toBe("file-blueprint");
    return respond(200, {
      url: original,
      downloadUrl: original,
      expiresAt: "2099-01-01T00:00:00Z",
      publicUrl: null,
    });
  });
  await setupPage({
    context,
    host: "app.okou.ai",
    path: "/chats/" + ATTACHMENT_THREAD_ID,
  });
  for (const label of ["floor plan", "original file"]) {
    click(await findNamedLink(label));
    const viewer = await screen.findByTestId("artifact-sidebar");
    await waitFor(() => {
      expect(
        within(viewer).getByTestId("artifact-sidebar-body-image"),
      ).toHaveAttribute("src", original);
    });
    click(await findNamedButton("Close artifact", viewer));
  }
  expect(queries).toHaveLength(1);
});

test("artifact-image-viewer-001 waits for decoded pixels despite knowing the first photo's size", async () => {
  twoImageChat();
  context.mocks.api(webFilesContract.fileUrl, ({ query, respond }) => {
    const url = "https://media.example.test/stations/" + query.file_id;
    return respond(200, {
      url,
      downloadUrl: url,
      expiresAt: "2099-01-01T00:00:00Z",
      publicUrl: null,
    });
  });
  const decoded = context.mocks.deferred<void>();
  vi.spyOn(HTMLImageElement.prototype, "decode").mockImplementation(function (
    this: HTMLImageElement,
  ) {
    return this.alt === "quay.png" &&
      this.closest('[data-testid="artifact-sidebar"]')
      ? decoded.promise
      : Promise.resolve();
  });
  const viewer = await openFirstPhoto();
  const picture = await within(viewer).findByAltText("quay.png");
  Object.defineProperties(picture, {
    naturalWidth: { configurable: true, value: 1280 },
    naturalHeight: { configurable: true, value: 960 },
  });
  fireEvent.load(picture);
  expect(picture).not.toBeVisible();
  const loading = within(viewer).getByRole("status", {
    name: "Loading artifacts",
  });
  expect(loading).toBeVisible();
  decoded.resolve();
  await waitFor(() => {
    return expect(picture).toBeVisible();
  });
  expect(loading).not.toBeInTheDocument();
  expect(queryNamedButton("Previous image artifact", viewer)).toBeNull();
  expect(getNamedButton("Next image artifact", viewer)).toBeEnabled();
});

test("artifact-image-viewer-002 keeps keyboard focus through the next photo's URL and decoding", async () => {
  twoImageChat();
  const secondUrl = context.mocks.deferred<void>();
  const secondDecode = context.mocks.deferred<void>();
  context.mocks.api(webFilesContract.fileUrl, async ({ query, respond }) => {
    if (query.file_id === "harbor.png") {
      await secondUrl.promise;
    }
    const url = "https://media.example.test/photos/" + query.file_id;
    return respond(200, {
      url,
      downloadUrl: url,
      expiresAt: "2099-01-01T00:00:00Z",
      publicUrl: null,
    });
  });
  vi.spyOn(HTMLImageElement.prototype, "decode").mockImplementation(function (
    this: HTMLImageElement,
  ) {
    return this.alt === "harbor.png" &&
      this.closest('[data-testid="artifact-sidebar"]')
      ? secondDecode.promise
      : Promise.resolve();
  });
  const viewer = await openFirstPhoto();
  const first = await within(viewer).findByAltText("quay.png");
  await waitFor(() => {
    return expect(first).toBeVisible();
  });
  const user = userEvent.setup({ delay: null });
  await user.click(
    within(viewer).getByRole("group", { name: "quay.png preview" }),
  );
  await user.keyboard("{ArrowRight}");
  const next = await within(viewer).findByRole("group", {
    name: "harbor.png preview",
  });
  expect(next).toHaveFocus();
  expect(within(viewer).queryByAltText("quay.png")).not.toBeInTheDocument();
  expect(
    within(next).getByRole("status", { name: "Loading artifacts" }),
  ).toBeVisible();
  secondUrl.resolve();
  const photo = await waitFor(() => {
    const image = within(viewer).getByTestId("artifact-sidebar-body-image");
    expect(image).toHaveAttribute(
      "src",
      "https://media.example.test/photos/harbor.png",
    );
    return image;
  });
  expect(photo).not.toBeVisible();
  secondDecode.resolve();
  await waitFor(() => {
    return expect(photo).toBeVisible();
  });
  expect(within(next).queryByRole("status")).not.toBeInTheDocument();
  expect(next).toHaveFocus();
});

test("The sidebar applies continuous zoom for buttons and modified wheel gestures", async () => {
  twoImageChat();
  context.mocks.api(webFilesContract.fileUrl, ({ query, respond }) => {
    const url = "https://media.example.test/photos/" + query.file_id;
    return respond(200, {
      url,
      downloadUrl: url,
      expiresAt: "2099-01-01T00:00:00Z",
      publicUrl: null,
    });
  });
  const viewer = await openFirstPhoto();
  const photo = await within(viewer).findByAltText("quay.png");
  const zoom = within(viewer);
  await expect(zoom.findByText("100%")).resolves.toBeInTheDocument();
  const increase = getNamedButton("Zoom in", viewer);
  const decrease = getNamedButton("Zoom out", viewer);
  const reset = getNamedButton("Reset zoom", viewer);
  click(increase);
  expect(zoom.getByText("112%")).toBeInTheDocument();
  click(decrease);
  expect(zoom.getByText("100%")).toBeInTheDocument();
  const wheel = (deltaY: number, opts: WheelEventInit = { ctrlKey: true }) => {
    // Happy DOM lacks WheelEvent. Preserve the pointer modifiers and wheel units.
    const event = new MouseEvent("wheel", {
      bubbles: true,
      cancelable: true,
      ...opts,
    });
    Object.defineProperties(event, {
      deltaX: { value: 0 },
      deltaY: { value: deltaY },
      deltaMode: { value: opts.deltaMode ?? 0 },
    });
    fireEvent(photo, event);
  };
  wheel(-1);
  expect(zoom.getByText("101%")).toBeInTheDocument();
  for (let i = 1; i < 20; i++) {
    wheel(-1);
  }
  expect(zoom.getByText("120%")).toBeInTheDocument();
  for (const [delta, opts, level] of [
    [-20, { ctrlKey: true }, "120%"],
    [-16, { metaKey: true }, "115%"],
    [-1, { ctrlKey: true, deltaMode: 1 }, "115%"],
    [0, { ctrlKey: true }, "100%"],
    [-20, {}, "100%"],
  ] as const) {
    click(reset);
    wheel(delta, opts);
    expect(zoom.getByText(level)).toBeInTheDocument();
  }
  wheel(100_000);
  expect(zoom.getByText("10%")).toBeInTheDocument();
  await waitFor(() => {
    return expect(getNamedButton("Zoom out", viewer)).toBeDisabled();
  });
  wheel(-100_000);
  await waitFor(() => {
    return expect(getNamedButton("Zoom in", viewer)).toBeDisabled();
  });
  expect(zoom.getByText("300%")).toBeInTheDocument();
  click(reset);
  expect(zoom.getByText("100%")).toBeInTheDocument();
});

const title = "Private courtyard",
  filename = "Private courtyard.png",
  fileId = "fafecafe-0123-4000-a000-002233445599",
  artifactId = "edbb2135-582d-4ec1-900e-228134211234",
  reference = "b3c8p9t7xu.png";

const locationUrl = "https://app.okou.ai/artifacts/" + reference,
  authorized =
    "https://artwork.r2.cloudflarestorage.com/private/courtyard.png?X-Amz-Signature=local-fixture";

function privateArtwork() {
  const reply = context.mocks.deferred<void>(),
    asked = context.mocks.deferred<void>();
  const summary = {
    ...artifactSummary(artifactId, "image", title),
    thumbnail: { url: locationUrl },
  };
  const detail = imageArtifactDetail(summary, {
    fileId,
    filename,
    url: locationUrl,
  });
  mockArtifactConversation(context, {
    catalog: [summary],
    details: new Map([[artifactId, detail]]),
    artifactRuns: () => {
      return [
        artifactRun({
          fileId,
          artifactId,
          filename,
          contentType: "image/png",
          url: locationUrl,
        }),
      ];
    },
  });
  context.mocks.api(
    artifactReferencesContract.resolve,
    async ({ params, respond }) => {
      if (params.reference !== reference) {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "Unknown artwork" },
        });
      }
      if (!asked.settled()) {
        asked.resolve();
      }
      await reply.promise;
      return respond(200, {
        url: authorized,
        downloadUrl: authorized,
        downloadAllowed: true,
        expiresAt: "2099-01-01T00:00:00Z",
        filename,
        contentType: "image/png",
        target: { kind: "file", id: fileId },
      });
    },
  );
  return { asked, reply };
}

async function open() {
  await setupPage({
    context,
    host: "app.okou.ai",
    path: "/chats/" + NAVIGATION_ARTIFACT_THREAD_ID,
  });
}

function thumbnail(row: HTMLElement, width: number) {
  const image = row.querySelector("img");
  expect(image).toBeInTheDocument();
  expect(image?.src).toContain("/cdn-cgi/image/");
  expect(
    image?.src.split("/cdn-cgi/image/")[1]?.split("/")[0]?.split(","),
  ).toContain("width=" + width);
  expect(image?.src).toContain("/" + authorized);
}

test("Private courtyard is available from the chat's artifacts after an empty workspace search for its title", async () => {
  const grant = privateArtwork();
  grant.reply.resolve();
  await open();
  click(await findFastControl("button", "Search workspace"));
  const dialog = await screen.findByRole("dialog");
  const box = within(dialog).getByRole("combobox");
  await fill(box, title);
  await expect(
    within(dialog).findByText("No results found"),
  ).resolves.toBeVisible();
  expect(within(dialog).queryByRole("option")).toBeNull();
  fireEvent.keyDown(box, { key: "Escape" });
  click(await findFastControl("button", "Artifacts and chats"));
  const catalog = await screen.findByRole("dialog", {
    name: "Artifacts and chats",
  });
  await expect(within(catalog).findByText(title)).resolves.toBeVisible();
});

test("thread-resource-thumbnails-001 The private image from the conversation’s resource list opens with its authorized source", async () => {
  const grant = privateArtwork();
  await open();
  click(await findFastControl("button", "Artifacts and chats"));
  const panel = await screen.findByRole("dialog", {
    name: "Artifacts and chats",
  });
  const resource = await within(panel).findByText(title);
  expect(resource.closest("button")?.querySelector("img")).toBeNull();
  click(resource);
  await grant.asked.promise;
  const preview = await screen.findByTestId("artifact-sidebar");
  click(await findFastControl("button", "Back to all artifacts", preview));
  const returned = await screen.findByTestId("thread-sidebar-artifacts");
  const entry = (await within(returned).findByText(title)).closest("button")!;
  expect(entry).toBeVisible();
  expect(
    entry.querySelector('[data-testid="artifact-catalog-thumbnail"]'),
  ).toBeNull();
  grant.reply.resolve();
  await waitFor(() => {
    return thumbnail(entry, 640);
  });
  click(entry);
  const original = await screen.findByTestId("artifact-sidebar");
  await waitFor(() => {
    expect(
      Array.from(original.querySelectorAll("img")).map((img) => {
        return img.src;
      }),
    ).toContain(authorized);
  });
});

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
  const menu = await findFastControl("button", "Download artifact");
  click(menu);
  await userEvent.keyboard("{ArrowRight}");
  expect(stage).toHaveAccessibleName("first.png preview");
  await userEvent.keyboard("{Escape}");
  click(await findFastControl("button", "Enter fullscreen"));
  await userEvent.keyboard("{ArrowRight}");
  expect(stage).toHaveAccessibleName("first.png preview");
  stage.focus();
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

const STORAGE = "https://okou-uploads.example.r2.cloudflarestorage.com";

/** A presigned R2 object whose stored key no longer carries the filename. */
function signedObject(key: string, disposition?: string): string {
  const url = new URL(`${STORAGE}/uploads/${key}`);
  if (disposition) {
    url.searchParams.set("response-content-disposition", disposition);
  }
  url.searchParams.set("X-Amz-Expires", "3600");
  url.searchParams.set("X-Amz-Signature", `signature-${key}`);
  return url.href;
}

const HEIC_SOURCE = signedObject("7f3c91d2a4");

const HEIC_DOWNLOAD = signedObject(
  "7f3c91d2a4",
  'attachment; filename="photo.HEIC"',
);

const JPEG_SOURCE = signedObject("c25e8b0f16");

function serveSignedFiles(): void {
  const files = new Map([
    ["file-photo-heic", { url: HEIC_SOURCE, downloadUrl: HEIC_DOWNLOAD }],
    [
      "file-harbor-jpeg",
      {
        url: JPEG_SOURCE,
        downloadUrl: signedObject(
          "c25e8b0f16",
          'attachment; filename="harbor.jpg"',
        ),
      },
    ],
  ]);
  context.mocks.api(webFilesContract.fileUrl, ({ query, respond }) => {
    const file = files.get(query.file_id);
    if (!file) {
      return respond(404, {
        error: { code: "FILE_NOT_FOUND", message: "File not found" },
      });
    }
    return respond(200, {
      ...file,
      expiresAt: "2099-01-01T00:00:00.000Z",
      publicUrl: null,
    });
  });
}

/** A full-resolution converted rendition of the signed original. */
function expectConvertedOriginal(image: HTMLElement): void {
  const src = image.getAttribute("src") ?? "";
  const match = /^https:\/\/cdn\.vm7\.io\/cdn-cgi\/image\/([^/]+)\/(.+)$/u.exec(
    src,
  );
  expect(match?.[2]).toBe(HEIC_SOURCE);
  expect(match?.[1]).toContain("format=auto");
  expect(match?.[1]).not.toMatch(/(?:^|,)(?:width|height)=/u);
}

test("an iPhone photo opens at full resolution and downloads its original (image/heic, sidebar first=false)", async () => {
  mockAttachmentChat(context, {
    chatEvents: [
      {
        role: "user",
        content: "Which photo should go on the cover?",
        createdAt: "2026-03-10T00:00:00Z",
        fileParts: [
          {
            type: "file",
            fileId: "file-photo-heic",
            filenameSnapshot: "photo.HEIC",
            contentType: "image/heic",
          },
          {
            type: "file",
            fileId: "file-harbor-jpeg",
            filenameSnapshot: "harbor.jpg",
            contentType: "image/jpeg",
          },
        ],
      },
    ],
  });
  serveSignedFiles();
  const browser = context.mocks.browser.blobDownload();
  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
  });

  click(await findNamedLink("Preview photo.HEIC"));
  const lightbox = await screen.findByTestId("artifact-sidebar");
  await waitFor(() => {
    expectConvertedOriginal(
      within(lightbox).getByTestId("artifact-sidebar-body-image"),
    );
  });

  click(await findNamedButton("Next image artifact", lightbox));
  await waitFor(() => {
    expect(
      within(lightbox).getByTestId("artifact-sidebar-body-image"),
    ).toHaveAttribute("src", JPEG_SOURCE);
  });
  click(await findNamedButton("Previous image artifact", lightbox));
  await waitFor(() => {
    expectConvertedOriginal(
      within(lightbox).getByTestId("artifact-sidebar-body-image"),
    );
  });

  const sidebar = await screen.findByTestId("artifact-sidebar");
  await waitFor(() => {
    expectConvertedOriginal(
      within(sidebar).getByTestId("artifact-sidebar-body-image"),
    );
  });
  click(await findNamedButton("Download artifact", sidebar));
  click(await findNamedMenuItem("Download"));

  await waitFor(() => {
    expect(
      browser.downloads.map(({ url, filename }) => {
        return { url, filename };
      }),
    ).toStrictEqual([{ url: HEIC_DOWNLOAD, filename: "photo.HEIC" }]);
  });
});

test("an inaccessible HEIC artifact keeps its access error in the image viewer", async () => {
  const reference = artifactReferencePath(
    "a7000000-0000-4000-a000-000000000c51",
    "photo.HEIC",
  );
  mockAttachmentChat(context, {
    chatEvents: [
      {
        role: "assistant",
        content: `Here is the [iPhone photo](${reference}) from the shoot.`,
        runId: ATTACHMENT_RUN_ID,
        runEventId: "heic-reference-event",
        sequenceNumber: 1,
        createdAt: "2026-03-10T00:00:01Z",
      },
    ],
  });
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    return respond(403, {
      error: { code: "FORBIDDEN", message: "Artifact access denied" },
    });
  });
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });

  click(await findNamedLink("iPhone photo"));

  const viewer = await screen.findByTestId("artifact-sidebar");
  await expect(
    within(viewer).findByRole("heading", {
      name: "You can’t view this artifact",
    }),
  ).resolves.toBeInTheDocument();
});

const { installCapabilityChat } = createChatCapabilityHelpers(context);

const ORIGINAL =
  "https://cdn.vm7.io/artifacts/tests/chat-attachments/photo.BMP";

test("assistant BMP images display the original in the thread and lightbox", async () => {
  installCapabilityChat({
    events: completedConversation(
      `Here is the scan you asked for.\n\n![photo.BMP](${ORIGINAL})`,
    ),
  });

  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });

  const inline = await waitFor(() => {
    const image = document.querySelector<HTMLImageElement>(
      `[data-role='assistant'] img[alt="photo.BMP"]`,
    );
    expect(image).toHaveAttribute("src", ORIGINAL);
    return image as HTMLImageElement;
  });

  click(inline.closest("a, button") ?? inline);

  const lightbox = await screen.findByTestId("artifact-sidebar");
  await waitFor(() => {
    expect(
      within(lightbox).getByRole("img", { name: "photo.BMP" }),
    ).toHaveAttribute("src", ORIGINAL);
  });
});

test("inline artifact images navigate within a folded assistant run while external images open in a new tab", async () => {
  const first = artifactFile("step-one.png", { contentType: "image/png" });
  const second = artifactFile("step-two.png", { contentType: "image/png" });
  const externalImage = "https://outside.example.org/banner.png";
  const externalLink = "https://outside.example.org/diagram.png";
  mockAttachmentChat(context, {
    chatEvents: [
      {
        role: "assistant",
        content: "Preparing the screenshots...",
        runId: ATTACHMENT_RUN_ID,
        runEventId: "folded-progress-1",
        sequenceNumber: 1,
        createdAt: "2026-03-10T00:00:01Z",
      },
      {
        role: "assistant",
        content: "Still rendering...",
        runId: ATTACHMENT_RUN_ID,
        runEventId: "folded-progress-2",
        sequenceNumber: 2,
        createdAt: "2026-03-10T00:00:02Z",
      },
      {
        role: "assistant",
        content: [
          `![first shot](${first.url})`,
          `![second shot](${second.url})`,
          `![external banner](${externalImage})`,
          `[Remote diagram](${externalLink})`,
        ].join("\n\n"),
        runId: ATTACHMENT_RUN_ID,
        runEventId: "folded-final-3",
        sequenceNumber: 3,
        createdAt: "2026-03-10T00:00:03Z",
      },
    ],
  });
  mockMessageArtifactDetails(context, () => {
    return [first, second];
  });

  await setupPage({ context, path: "/chats/" + ATTACHMENT_THREAD_ID });

  const externalImg = await waitFor(() => {
    const img = document.querySelector<HTMLImageElement>(
      `[data-role="assistant"] img[alt="external banner"]`,
    );
    expect(img).toBeInTheDocument();
    return img!;
  });
  const externalAnchor = externalImg.closest("a");
  expect(externalAnchor).toHaveAttribute("href", externalImage);
  expect(externalAnchor).toHaveAttribute("target", "_blank");
  expect(externalAnchor?.getAttribute("rel")?.split(" ")).toStrictEqual(
    expect.arrayContaining(["noopener", "noreferrer"]),
  );

  const remoteLink = await findNamedLink("Remote diagram");
  expect(remoteLink).toHaveAttribute("href", externalLink);
  expect(remoteLink).toHaveAttribute("target", "_blank");
  expect(remoteLink.getAttribute("rel")?.split(" ")).toStrictEqual(
    expect.arrayContaining(["noopener", "noreferrer"]),
  );

  // Clicking external images or image links must not open the artifact sidebar.
  const preventNative = (event: MouseEvent) => {
    event.preventDefault();
  };
  externalAnchor!.addEventListener("click", preventNative);
  remoteLink.addEventListener("click", preventNative);
  click(externalAnchor!);
  click(remoteLink);
  expect(screen.queryByTestId("artifact-sidebar")).toBeNull();

  const firstInline = await waitFor(() => {
    const img = document.querySelector<HTMLImageElement>(
      `[data-role="assistant"] img[alt="first shot"]`,
    );
    expect(img).toBeInTheDocument();
    return img!;
  });
  click(firstInline.closest("a, button") ?? firstInline);

  const sidebar = await screen.findByTestId("artifact-sidebar");
  const firstPreview = await within(sidebar).findByRole("group", {
    name: "step-one.png preview",
  });
  expect(queryNamedButton("Previous image artifact", sidebar)).toBeNull();
  await expect(
    findNamedButton("Next image artifact", sidebar),
  ).resolves.toBeEnabled();

  firstPreview.focus();
  await userEvent.keyboard("{ArrowRight}");
  const secondPreview = await within(sidebar).findByRole("group", {
    name: "step-two.png preview",
  });
  expect(secondPreview).toBeVisible();
  expect(queryNamedButton("Next image artifact", sidebar)).toBeNull();
  await expect(
    findNamedButton("Previous image artifact", sidebar),
  ).resolves.toBeEnabled();

  await userEvent.keyboard("{ArrowLeft}");
  await expect(
    within(sidebar).findByRole("group", { name: "step-one.png preview" }),
  ).resolves.toBeVisible();
});
