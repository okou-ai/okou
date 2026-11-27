import {
  artifactCatalogContract,
  chatArtifactCatalogChangedEvent,
} from "@okouai/api-contracts/contracts/artifact-catalog";
import {
  artifactReferencePath,
  artifactReferencesContract,
} from "@okouai/api-contracts/contracts/artifact-references";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { act, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  artifactFile,
  mockAttachmentChat,
  privateAttachmentUrl,
  publicArtifactUrl,
} from "./chat-attachment-test-helpers.ts";
import {
  quoteSelectedPassage,
  selectPassage,
  type CapturedChatSend,
} from "./chat-capability-test-helpers.ts";
import {
  artifactSummary,
  buttonNamed,
  fileArtifactDetail,
  NAVIGATION_ARTIFACT_RUN_ID,
  NAVIGATION_ARTIFACT_THREAD_ID,
  openResourceArtifact,
} from "./chat-navigation-artifact-test-helpers.ts";
import { openResources } from "./chat-resources-test-helpers.ts";

const context = testContext();
const ARTIFACT_ID = "e0000000-0000-4000-a000-000000000960";
const FILE_ID = "e0000000-0000-4000-a000-000000000961";
const UNRELATED_ID = "e0000000-0000-4000-a000-000000000963";
const TITLE = "Release plan";
const FILENAME = "release-plan.md";
const RENAMED_FILENAME = "reviewed-release-plan.md";
const UNRELATED_TITLE = "Unrelated upload.pdf";
const PASSAGE = "Review the original launch plan carefully.";
const BODY_URL = "https://files.example.test/immutable-release-plan.md";
const TOPIC = chatArtifactCatalogChangedEvent(NAVIGATION_ARTIFACT_THREAD_ID);

async function setupPublication(
  entry: "message" | "raw" | "catalog",
  source: "authenticated" | "reference" | "public" = "authenticated",
  initialGrant:
    "healthy" | "unavailable" | "expired" | "body-unavailable" = "healthy",
) {
  const url =
    source === "authenticated"
      ? `${privateAttachmentUrl(FILE_ID)}&filename=${FILENAME}`
      : source === "reference"
        ? artifactReferencePath(FILE_ID, FILENAME)
        : BODY_URL;
  const messageFilename =
    source === "authenticated" ? FILENAME : url.split("/").at(-1)!;
  const original = artifactFile(FILENAME, {
    id: FILE_ID,
    artifactId: ARTIFACT_ID,
    contentType: "text/markdown",
    url,
  });
  let selectedFile = original;
  let oldResolverUnavailable = initialGrant === "unavailable";
  let expiredGrant = initialGrant === "expired";
  let oldBodyUnavailable = initialGrant === "body-unavailable";
  const summary = artifactSummary(ARTIFACT_ID, "file", TITLE);
  const catalog = [summary];
  const artifacts = [original];
  const sent = context.mocks.deferred<CapturedChatSend>();
  context.mocks.browser.matchMedia((query) => {
    return query === "(min-width: 80rem)";
  });
  mockAttachmentChat(context, {
    threadId: NAVIGATION_ARTIFACT_THREAD_ID,
    artifactRunId: NAVIGATION_ARTIFACT_RUN_ID,
    artifacts,
    chatEvents: [
      {
        id: "immutable-release-plan-message",
        role: "assistant",
        content:
          entry === "message"
            ? `![${FILENAME}](${url})`
            : entry === "raw"
              ? `Please [Read the release plan](${url}) before publishing.`
              : "The release plan is ready.",
        runId: NAVIGATION_ARTIFACT_RUN_ID,
        seqId: 1,
        createdAt: "2026-09-01T12:00:00.000Z",
      },
    ],
    onSendRequest: (body) => {
      sent.resolve(body);
    },
  });
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: [...catalog], nextCursor: null });
  });
  context.mocks.api(artifactCatalogContract.get, ({ params, respond }) => {
    return params.artifactId === ARTIFACT_ID
      ? respond(
          200,
          fileArtifactDetail(summary, {
            fileId: selectedFile.id,
            filename: selectedFile.filename,
            contentType: selectedFile.contentType,
            url: selectedFile.url,
          }),
        )
      : respond(404, {
          error: { code: "ARTIFACT_NOT_FOUND", message: "Artifact not found" },
        });
  });
  context.mocks.api(webFilesContract.fileUrl, ({ query, respond }) => {
    if (query.file_id === FILE_ID && oldResolverUnavailable) {
      return respond(503, { error: { message: "Preview grant unavailable" } });
    }
    const grant = expiredGrant
      ? {
          url: new URL("?expired=1", BODY_URL).href,
          expiresAt: "2000-01-01T00:00:00.000Z",
        }
      : { url: BODY_URL, expiresAt: "2099-01-01T00:00:00.000Z" };
    expiredGrant = false;
    return respond(200, {
      ...grant,
      downloadUrl: new URL("?download=1", grant.url).href,
      publicUrl: null,
    });
  });
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    return oldResolverUnavailable
      ? respond(503, { error: { message: "Preview grant unavailable" } })
      : respond(200, {
          url: BODY_URL,
          downloadUrl: new URL("?download=1", BODY_URL).href,
          expiresAt: "2099-01-01T00:00:00.000Z",
          filename: FILENAME,
          contentType: "text/markdown",
          target: { kind: "file", id: FILE_ID },
        });
  });
  context.mocks.http.get(BODY_URL, ({ request }) => {
    // Successful reads always return the same immutable bytes.
    return oldBodyUnavailable ||
      new URL(request.url).searchParams.has("expired")
      ? new HttpResponse(null, { status: 503 })
      : HttpResponse.text(`# Release plan\n\n${PASSAGE}`);
  });
  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
  });
  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription(TOPIC)).toBeTruthy();
    expect(context.mocks.ably.hasSubscription("artifact:changed")).toBeTruthy();
  });

  return {
    sent,
    open: async () => {
      if (entry === "catalog") {
        await openResourceArtifact(TITLE);
      } else if (entry === "raw") {
        click(await screen.findByText("Read the release plan"));
      } else {
        click(
          await screen.findByLabelText(
            `Open markdown preview for ${messageFilename}`,
          ),
        );
      }
      const sidebar = await screen.findByTestId("artifact-sidebar");
      await within(sidebar).findByText(PASSAGE);
      if (entry === "catalog") {
        await closeResources();
      }
      return sidebar;
    },
    publishUnrelated: async () => {
      oldBodyUnavailable = true;
      // The catalog case isolates detail reload -> body refetch: its resolver
      // stays healthy and returns the identical URL throughout publication.
      oldResolverUnavailable = entry !== "catalog";
      catalog.push(artifactSummary(UNRELATED_ID, "file", UNRELATED_TITLE));
      artifacts.push(
        artifactFile(UNRELATED_TITLE, {
          id: UNRELATED_ID,
          artifactId: UNRELATED_ID,
          contentType: "application/pdf",
          url: publicArtifactUrl(UNRELATED_TITLE),
        }),
      );
      await act(() => {
        context.mocks.ably.trigger(TOPIC, { artifactId: UNRELATED_ID });
      });
    },
    restoreTransport: () => {
      oldResolverUnavailable = false;
      oldBodyUnavailable = false;
    },
    renameMetadata: async () => {
      selectedFile = { ...original, filename: RENAMED_FILENAME };
      await act(() => {
        context.mocks.ably.trigger("artifact:changed", {
          artifactId: UNRELATED_ID,
        });
      });
    },
  };
}

async function closeResources() {
  click(buttonNamed("Artifacts and chats"));
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Artifacts and chats" }),
    ).not.toBeInTheDocument();
  });
}

async function closePreview() {
  click(buttonNamed("Close artifact", screen.getByTestId("artifact-sidebar")));
  await waitFor(() => {
    expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
  });
}

async function quoteAndSend(passage: string) {
  await selectPassage(passage);
  await quoteSelectedPassage();
  await waitFor(() => {
    expect(buttonNamed("Send")).toBeEnabled();
  });
  click(buttonNamed("Send"));
}

function expectQuotedFile(
  send: CapturedChatSend,
  passage: string,
  fileId: string,
  filename: string,
) {
  expect(send.threadId).toBe(NAVIGATION_ARTIFACT_THREAD_ID);
  expect(
    send.userMessage?.parts.filter((part) => {
      return part.type === "feedback";
    }),
  ).toStrictEqual([
    {
      type: "feedback",
      quote: passage,
      note: [],
      source: {
        type: "artifact",
        fileId,
        filenameSnapshot: filename,
        artifactId: ARTIFACT_ID,
      },
    },
  ]);
}

test.each([
  { entry: "message", source: "authenticated" },
  { entry: "message", source: "reference" },
  { entry: "raw", source: "reference" },
] as const)(
  "An unrelated upload preserves the $source Markdown $entry preview and quote identity",
  async ({ entry, source }) => {
    const publication = await setupPublication(entry, source);
    await publication.open();
    const resources = await openResources();
    await within(resources).findByText(TITLE);

    await publication.publishUnrelated();
    // A new catalog row proves the publication was consumed, not merely sent.
    await within(resources).findByText(UNRELATED_TITLE);
    expect(
      within(screen.getByTestId("artifact-sidebar")).getByText(PASSAGE),
    ).toBeInTheDocument();
    await closeResources();
    publication.restoreTransport();
    await closePreview();
    await publication.open();
    await quoteAndSend(PASSAGE);
    expectQuotedFile(
      await publication.sent.promise,
      PASSAGE,
      FILE_ID,
      FILENAME,
    );
  },
);

test("Opening a private file with an expired grant renews the same file", async () => {
  const publication = await setupPublication(
    "message",
    "authenticated",
    "expired",
  );
  const sidebar = await publication.open();
  expect(within(sidebar).getByText(PASSAGE)).toBeInTheDocument();
  await quoteAndSend(PASSAGE);
  expectQuotedFile(await publication.sent.promise, PASSAGE, FILE_ID, FILENAME);
});

test.each([
  { entry: "message", failure: "unavailable" },
  { entry: "catalog", failure: "unavailable" },
  { entry: "message", failure: "body-unavailable" },
  { entry: "catalog", failure: "body-unavailable" },
] as const)(
  "Reopening a $failure $entry preview retries the same immutable file",
  async ({ entry, failure }) => {
    const publication = await setupPublication(entry, "authenticated", failure);
    if (entry === "catalog") {
      await openResourceArtifact(TITLE);
    } else {
      click(
        await screen.findByLabelText(`Open markdown preview for ${FILENAME}`),
      );
    }
    const sidebar = await screen.findByTestId("artifact-sidebar");
    await expect(
      within(sidebar).findByText(/preview unavailable\./i),
    ).resolves.toBeInTheDocument();
    if (entry === "catalog") {
      await closeResources();
    }

    publication.restoreTransport();
    await closePreview();
    await publication.open();
    await quoteAndSend(PASSAGE);
    expectQuotedFile(
      await publication.sent.promise,
      PASSAGE,
      FILE_ID,
      FILENAME,
    );
  },
);

test("Reopening a failed public catalog preview retries the same immutable file", async () => {
  const publication = await setupPublication(
    "catalog",
    "public",
    "body-unavailable",
  );
  await openResourceArtifact(TITLE);
  const sidebar = await screen.findByTestId("artifact-sidebar");
  await expect(
    within(sidebar).findByText(/preview unavailable\./i),
  ).resolves.toBeInTheDocument();
  await closeResources();

  publication.restoreTransport();
  await closePreview();
  await publication.open();
  await quoteAndSend(PASSAGE);
  expectQuotedFile(await publication.sent.promise, PASSAGE, FILE_ID, FILENAME);
});

test("Catalog Markdown retains its body across unrelated catalog and global notifications while metadata reloads", async () => {
  const publication = await setupPublication("catalog");
  await publication.open();
  const resources = await openResources();
  await within(resources).findByText(TITLE);

  await publication.publishUnrelated();
  await within(resources).findByText(UNRELATED_TITLE);
  expect(
    within(screen.getByTestId("artifact-sidebar")).getByText(PASSAGE),
  ).toBeInTheDocument();
  await closeResources();

  await publication.renameMetadata();
  const sidebar = screen.getByTestId("artifact-sidebar");
  // The changed detail is the global notification's observable completion.
  await within(sidebar).findByText(RENAMED_FILENAME);
  expect(within(sidebar).getByText(PASSAGE)).toBeInTheDocument();
  publication.restoreTransport();
  await closePreview();
  await publication.open();
  await quoteAndSend(PASSAGE);
  expectQuotedFile(
    await publication.sent.promise,
    PASSAGE,
    FILE_ID,
    RENAMED_FILENAME,
  );
});
