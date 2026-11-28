import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { resolveApiBase } from "../../../signals/api-base.ts";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { chatArtifactCatalogChangedEvent } from "@okouai/api-contracts/validators/artifact-catalog";
import { screen, within, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  artifactSummary,
  fileArtifactDetail,
  mockArtifactConversation,
  NAVIGATION_ARTIFACT_THREAD_ID as thread,
} from "./chat-navigation-artifact-test-helpers.ts";
import {
  openResources,
  setupResources,
  RESOURCE_ARTIFACT_ID,
} from "./chat-resources-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
const context = testContext();
const videoId = "66668000-0000-4000-8000-000000000015";
async function publishableChat() {
  const clips = [artifactSummary(videoId, "file", "Quarterly update.mp4")];
  mockArtifactConversation(context, { catalog: [], chatEvents: [] });
  let published = false;
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, {
      artifacts: published ? clips : [],
      nextCursor: null,
    });
  });
  await setupPage({ context, path: "/chats/" + thread });
  await waitFor(() => {
    expect(
      context.mocks.ably.hasSubscription(
        chatArtifactCatalogChangedEvent(thread),
      ),
    ).toBeTruthy();
  });
  return () => {
    published = true;
  };
}
test("chat-resources-realtime-004 Only this chat's publication refreshes its open artifact list", async () => {
  const publish = await publishableChat();
  const dialog = await openResources();
  await within(dialog).findByText("No artifacts yet");
  publish();
  const foreignTopic = chatArtifactCatalogChangedEvent(
    "66668000-0000-4000-8000-000000000016",
  );
  expect(context.mocks.ably.hasSubscription(foreignTopic)).toBeFalsy();
  context.mocks.ably.trigger(foreignTopic, {});
  expect(within(dialog).getByText("No artifacts yet")).toBeVisible();
  context.mocks.ably.trigger(chatArtifactCatalogChangedEvent(thread), {});
  await expect(
    within(dialog).findByText("Quarterly update.mp4"),
  ).resolves.toBeVisible();
  expect(within(dialog).queryByText("No artifacts yet")).toBeNull();
});
test.each([
  [
    "chat-resources-catalog-005",
    "https://files.example.test/report.pdf",
    "Link copied",
  ],
  ["chat-resources-catalog-006", "private-file", "Could not copy the link"],
] as const)(
  "%s Copy checks the file detail before exposing a link",
  async (_id, url, notice) => {
    const clipboard = context.mocks.browser.clipboardWriteText();
    const resourceUrl = () => {
      return url === "private-file"
        ? new URL("/api/web/file-url?file_id=" + videoId, resolveApiBase()).href
        : url;
    };
    context.mocks.api(webFilesContract.fileUrl, ({ respond }) => {
      return respond(200, {
        url: "https://example.test/local-preview",
        downloadUrl: "https://example.test/local-download",
        publicUrl: null,
        expiresAt: "2099-01-01T00:00:00.000Z",
        previewImageUrl: null,
      });
    });
    await setupResources(context, {
      sourceUrl: false,
      mock() {
        context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
          return respond(
            200,
            fileArtifactDetail(
              artifactSummary(RESOURCE_ARTIFACT_ID, "file", "report.pdf"),
              {
                fileId: videoId,
                contentType: "application/pdf",
                filename: "report.pdf",
                url: resourceUrl(),
              },
            ),
          );
        });
      },
    });
    const panel = screen.getByRole("dialog", { name: "Artifacts and chats" });
    await within(panel).findByText("report.pdf");
    click(await findFastControl("button", "Copy link", panel));
    await screen.findByText(notice);
    expect(clipboard.writes).toStrictEqual(
      notice === "Link copied" ? [url] : [],
    );
    expect(panel).toBeVisible();
    expect(within(panel).getByText("report.pdf")).toBeVisible();
    expect(document.querySelector('iframe[title="report.pdf"]')).toBeNull();
  },
);

test("Copying a private ZIP from chat resources keeps its canonical artifact link", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  const artifact = artifactSummary(
    RESOURCE_ARTIFACT_ID,
    "file",
    "script-output.zip",
  );
  const reference = "/artifacts/abcdef1234.zip#bundle";
  mockArtifactConversation(context, {
    catalog: [artifact],
    details: new Map([
      [
        artifact.id,
        fileArtifactDetail(artifact, {
          fileId: videoId,
          filename: artifact.title,
          contentType: "application/zip",
          url: reference,
        }),
      ],
    ]),
  });
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    return respond(200, {
      url: "https://files.example.test/private-preview?signature=temporary",
      downloadUrl:
        "https://files.example.test/private-download?signature=temporary",
      expiresAt: "2099-01-01T00:00:00.000Z",
      filename: artifact.title,
      contentType: "application/zip",
      target: { kind: "file", id: videoId },
    });
  });
  await setupPage({ context, path: "/chats/" + thread });
  const panel = await openResources();
  await within(panel).findByText(artifact.title);
  click(await findFastControl("button", "Copy link", panel));
  await expect(screen.findByText("Link copied")).resolves.toBeInTheDocument();
  expect(clipboard.writes).toStrictEqual([
    new URL(reference, window.location.origin).href,
  ]);
  expect(panel).toBeInTheDocument();
});

test("chat-resources-realtime-003 opening resources after a publication shows the latest video in this chat", async () => {
  const old = artifactSummary(crypto.randomUUID(), "file", "First cut.mp4");
  const replacement = artifactSummary(
    crypto.randomUUID(),
    "file",
    "Approved cut.mp4",
  );
  const request = context.mocks.deferred<void>();
  const respondWithCatalog = context.mocks.deferred<void>();
  let latest = old;
  mockArtifactConversation(context, { catalog: [old], chatEvents: [] });
  context.mocks.api(artifactCatalogContract.list, async ({ respond }) => {
    const item = latest;
    if (item.id === replacement.id) {
      if (!request.settled()) {
        request.resolve();
      }
      await respondWithCatalog.promise;
    }
    return respond(200, { artifacts: [item], nextCursor: null });
  });
  await setupPage({ context, path: "/chats/" + thread });
  const topic = chatArtifactCatalogChangedEvent(thread);
  await waitFor(() => {
    return expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
  });
  latest = replacement;
  context.mocks.ably.trigger(topic, {});
  const panel = await openResources();
  await request.promise;
  expect(within(panel).queryByText(replacement.title)).toBeNull();
  respondWithCatalog.resolve();
  await expect(
    within(panel).findByText("Approved cut.mp4"),
  ).resolves.toBeInTheDocument();
  expect(within(panel).queryByText("First cut.mp4")).toBeNull();
});

test("The latest edit reaches a previously opened resource list when its publication arrives while the panel is closed", async () => {
  const update = await publishableChat();
  const first = await openResources();
  await within(first).findByText("No artifacts yet");
  click(await findFastControl("button", "Close artifacts and chats", first));
  await waitFor(() => {
    return expect(first).not.toBeInTheDocument();
  });
  update();
  context.mocks.ably.trigger(chatArtifactCatalogChangedEvent(thread), {});
  const reopened = await openResources();
  await expect(
    within(reopened).findByText("Quarterly update.mp4"),
  ).resolves.toBeInTheDocument();
  expect(within(reopened).queryByText("No artifacts yet")).toBeNull();
});
