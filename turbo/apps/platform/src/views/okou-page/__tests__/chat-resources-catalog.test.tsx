import {
  artifactCatalogContract,
  chatArtifactCatalogChangedEvent,
} from "@okouai/api-contracts/contracts/artifact-catalog";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { privateAttachmentUrl } from "./chat-attachment-test-helpers.ts";
import {
  artifactSummary,
  buttonNamed,
  fileArtifactDetail,
  NAVIGATION_ARTIFACT_THREAD_ID,
} from "./chat-navigation-artifact-test-helpers.ts";
import {
  createChatResourcesHelpers,
  openResources,
  RESOURCE_ARTIFACT_ID,
} from "./chat-resources-test-helpers.ts";

const context = testContext();
const { setupOverflowResources, setupResources } =
  createChatResourcesHelpers(context);
const REPORT_URL = "https://files.example.test/report.pdf";

function artifactEntryNamed(title: string, container: HTMLElement) {
  const titleElement = Array.from(
    container.querySelectorAll<HTMLElement>('[data-slot="hover-scroll-title"]'),
  ).find((element) => {
    return element.textContent === title;
  });
  const button = titleElement?.closest("button");
  if (!button) {
    throw new Error(`Artifact entry not found: ${title}`);
  }
  return button;
}

function artifactTitles(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll<HTMLElement>('[data-slot="hover-scroll-title"]'),
  ).map((element) => {
    return element.textContent ?? "";
  });
}

function expectUniqueArtifacts(container: HTMLElement, count: number) {
  const titles = artifactTitles(container);
  expect(queryAllByRoleFast("listitem", container)).toHaveLength(count);
  expect(titles).toHaveLength(count);
  expect(new Set(titles).size).toBe(count);
}

async function openArtifactRegion() {
  const resources = await screen.findByRole("dialog", {
    name: "Artifacts and chats",
  });
  const artifacts = within(resources).getByRole("region", {
    name: "Artifacts",
  });
  await within(artifacts).findByText("report.pdf");
  return artifacts;
}

test("Browse artifacts without source URLs in the popover and sidebar without showing message links", async () => {
  const user = userEvent.setup({ delay: null });
  const report = artifactSummary(RESOURCE_ARTIFACT_ID, "file", "report.pdf");
  let catalogAvailable = true;
  let previewFilename = "download-report.pdf";
  await setupResources({
    open: false,
    sourceUrl: false,
    mock: () => {
      context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
        if (
          !catalogAvailable &&
          query.chatThreadId === NAVIGATION_ARTIFACT_THREAD_ID
        ) {
          return respond(500, {
            error: {
              message: "The artifact catalog is temporarily unavailable",
            },
          });
        }
        return respond(200, {
          artifacts:
            query.chatThreadId === NAVIGATION_ARTIFACT_THREAD_ID
              ? [report]
              : [],
          nextCursor: null,
        });
      });
      context.mocks.api(
        artifactCatalogContract.get,
        ({ params, query, respond }) => {
          expect(query.chatThreadId).toBe(NAVIGATION_ARTIFACT_THREAD_ID);
          return params.artifactId === report.id
            ? respond(
                200,
                fileArtifactDetail(report, {
                  fileId: "b0000000-0000-4000-a000-000000000999",
                  filename: previewFilename,
                  contentType: "application/pdf",
                  url: "https://files.example.test/download-report.pdf",
                }),
              )
            : respond(404, {
                error: { code: "NOT_FOUND", message: "Artifact not found" },
              });
        },
      );
    },
  });
  await waitFor(() => {
    expect(
      context.mocks.ably.hasSubscription(
        chatArtifactCatalogChangedEvent(NAVIGATION_ARTIFACT_THREAD_ID),
      ),
    ).toBeTruthy();
  });
  const resources = await openResources();
  await within(resources).findByText("report.pdf");
  const entry = artifactEntryNamed("report.pdf", resources);
  const clip = entry.querySelector<HTMLElement>("[data-title-reveal]");
  const text = clip?.firstElementChild;
  if (!clip || !text) {
    throw new Error("Expected the resource title clip and text");
  }
  // Deliberate docs/testing.md#external-behavior exception: HappyDOM
  // cannot lay out or paint CSS, so check the control's DOM-to-CSS handoff.
  clip.getBoundingClientRect = () => {
    return new DOMRect(0, 0, 160, 20);
  };
  text.getBoundingClientRect = () => {
    return new DOMRect(0, 0, 234, 20);
  };

  await user.hover(entry);
  expect(clip).toHaveAttribute("data-title-revealing", "");

  click(entry);
  const sidebar = await screen.findByTestId("artifact-sidebar");
  await expect(
    within(sidebar).findByText("download-report.pdf"),
  ).resolves.toBeInTheDocument();
  expect(buttonNamed("Download artifact", sidebar)).toBeInTheDocument();
  await expect(
    within(sidebar).findByTestId("artifact-sidebar-body-pdf"),
  ).resolves.toHaveAttribute(
    "src",
    "https://files.example.test/download-report.pdf#navpanes=0",
  );

  catalogAvailable = false;
  click(buttonNamed("Back to all artifacts", sidebar));
  const artifactList = await screen.findByTestId("thread-sidebar-artifacts");
  await expect(
    within(artifactList).findByText("report.pdf"),
  ).resolves.toBeInTheDocument();
  expect(within(artifactList).queryByRole("tablist")).not.toBeInTheDocument();

  previewFilename = "updated-report.pdf";
  click(buttonNamed("Preview report.pdf", artifactList));
  await expect(
    within(await screen.findByTestId("artifact-sidebar")).findByText(
      "updated-report.pdf",
    ),
  ).resolves.toBeInTheDocument();
});

test("Copy an artifact's on-demand detail URL without opening its preview", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  await setupResources({ sourceUrl: false });
  const artifacts = await openArtifactRegion();

  click(buttonNamed("Copy link", artifacts));

  await expect(screen.findByText("Link copied")).resolves.toBeInTheDocument();
  expect(clipboard.writes).toStrictEqual([REPORT_URL]);
  expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
});

test("Copying a private artifact reports failure without exposing its signed or authenticated URL", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  const report = artifactSummary(RESOURCE_ARTIFACT_ID, "file", "report.pdf");
  const fileId = "b0000000-0000-4000-a000-000000000999";
  const authenticatedUrl = privateAttachmentUrl(fileId);
  await setupResources({
    sourceUrl: false,
    mock: () => {
      context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
        return respond(
          200,
          fileArtifactDetail(report, {
            fileId,
            filename: "report.pdf",
            contentType: "application/pdf",
            url: authenticatedUrl,
          }),
        );
      });
      context.mocks.api(webFilesContract.fileUrl, ({ respond }) => {
        return respond(200, {
          url: "https://storage.example.test/report.pdf?signature=private-preview",
          downloadUrl:
            "https://storage.example.test/report.pdf?signature=private-download",
          expiresAt: "2099-01-01T00:00:00Z",
          publicUrl: null,
        });
      });
    },
  });
  const artifacts = await openArtifactRegion();

  click(buttonNamed("Copy link", artifacts));

  await expect(
    screen.findByText("Could not copy the link"),
  ).resolves.toBeInTheDocument();
  expect(clipboard.writes).toStrictEqual([]);
  expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
  expect(artifactEntryNamed("report.pdf", artifacts)).toBeEnabled();
  expect(document.body.innerHTML).not.toContain("signature=private");
  expect(document.body.innerHTML).not.toContain(authenticatedUrl);
});

test("Show more resources until the last page, then collapse with the same control", async () => {
  const { panel } = await setupOverflowResources(125, {
    paginated: true,
    withLinks: false,
  });
  const artifacts = within(panel).getByRole("region", { name: "Artifacts" });
  expectUniqueArtifacts(artifacts, 3);
  const more = buttonNamed("Show more", artifacts);

  click(more);
  await within(artifacts).findByText("report-60.pdf");
  expect(more).toHaveTextContent("Show more");
  click(more);
  await within(artifacts).findByText("report-120.pdf");
  expectUniqueArtifacts(artifacts, 120);
  expect(more).toHaveTextContent("Show more");
  click(more);
  await within(artifacts).findByText("report-125.pdf");
  expectUniqueArtifacts(artifacts, 125);
  expect(more).toHaveTextContent("Collapse");

  click(more);
  expectUniqueArtifacts(artifacts, 3);
  expect(more).toHaveTextContent("Show more");
  click(more);
  await within(artifacts).findByText("report-125.pdf");
  expectUniqueArtifacts(artifacts, 125);
  expect(more).toHaveTextContent("Collapse");
});

test("Disable show more while loading and keep resource pages unique", async () => {
  const nextPage = context.mocks.deferred<void>();
  const { panel } = await setupOverflowResources(125, {
    withLinks: false,
    mock: (catalog) => {
      context.mocks.api(
        artifactCatalogContract.list,
        async ({ query, respond }) => {
          const offset = query.cursor ? Number(query.cursor) : 0;
          if (query.cursor) {
            await nextPage.promise;
          }
          const end = offset + 60;
          return respond(200, {
            artifacts: catalog.slice(offset, end),
            nextCursor: end < catalog.length ? String(end) : null,
          });
        },
      );
    },
  });
  const artifacts = within(panel).getByRole("region", { name: "Artifacts" });
  const more = buttonNamed("Show more", artifacts);
  click(more);
  await within(artifacts).findByText("report-60.pdf");
  more.focus();

  click(more);
  await within(artifacts).findByRole("status");
  click(more);
  click(more);
  expect(more).toHaveAttribute("aria-disabled", "true");
  expect(more).toHaveAttribute("aria-busy", "true");
  expect(more).toHaveFocus();
  expectUniqueArtifacts(artifacts, 60);

  nextPage.resolve();
  await within(artifacts).findByText("report-120.pdf");
  expectUniqueArtifacts(artifacts, 120);
  expect(more).not.toHaveAttribute("aria-disabled", "true");
  expect(
    within(artifacts).queryByText("report-121.pdf"),
  ).not.toBeInTheDocument();
});

test("Retain loaded resources after a paging failure and retry with show more", async () => {
  let failed = true;
  const { panel } = await setupOverflowResources(65, {
    withLinks: false,
    mock: (catalog) => {
      context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
        if (query.cursor && failed) {
          return respond(500, {
            error: { message: "The next resource page is unavailable" },
          });
        }
        return respond(200, {
          artifacts: query.cursor ? catalog.slice(60) : catalog.slice(0, 60),
          nextCursor: query.cursor ? null : "resources-next-page",
        });
      });
    },
  });
  const artifacts = within(panel).getByRole("region", { name: "Artifacts" });
  const more = buttonNamed("Show more", artifacts);
  click(more);
  await within(artifacts).findByText("report-60.pdf");

  click(more);
  await expect(
    within(artifacts).findByRole("alert"),
  ).resolves.toHaveTextContent("Could not load artifacts");
  expect(within(artifacts).getAllByRole("listitem")).toHaveLength(60);
  expect(more).toBeEnabled();
  expect(more).not.toHaveAttribute("aria-disabled", "true");
  expect(more).toHaveTextContent("Show more");

  failed = false;
  click(more);
  await within(artifacts).findByText("report-65.pdf");
  expect(within(artifacts).getAllByRole("listitem")).toHaveLength(65);
  expect(within(artifacts).queryByRole("alert")).not.toBeInTheDocument();
  expect(more).toHaveTextContent("Collapse");
});

test("Copy the focused resource after moving between open copy tooltips", async () => {
  const user = userEvent.setup();
  const { panel } = await setupOverflowResources(4, { withLinks: false });
  const clipboard = context.mocks.browser.clipboardWriteText();
  const artifacts = within(panel).getByRole("region", { name: "Artifacts" });
  click(buttonNamed("Show more", artifacts));
  await within(artifacts).findByText("report-4.pdf");
  const firstRow = artifactEntryNamed("report-1.pdf", artifacts).closest("li");
  const lastRow = artifactEntryNamed("report-4.pdf", artifacts).closest("li");
  if (!firstRow || !lastRow) {
    throw new Error("Expected both resource rows");
  }
  const firstCopy = buttonNamed("Copy link", firstRow);
  const lastCopy = buttonNamed("Copy link", lastRow);
  firstCopy.focus();
  await expect(screen.findByText("Copy link")).resolves.toBeVisible();
  expect(firstCopy).toHaveAttribute("data-popup-open");

  lastCopy.focus();
  await waitFor(() => {
    expect(lastCopy).toHaveAttribute("data-popup-open");
    expect(firstCopy).not.toHaveAttribute("data-popup-open");
    expect(screen.getAllByText("Copy link")).toHaveLength(1);
  });
  await user.keyboard("{Enter}");

  await expect(screen.findByText("Link copied")).resolves.toBeInTheDocument();
  expect(clipboard.writes).toStrictEqual([
    "https://files.example.test/report-4.pdf",
  ]);
  expect(lastCopy).toHaveFocus();
});

test("Keep gallery paging independent of the resource popover", async () => {
  const { panel } = await setupOverflowResources(65, {
    paginated: true,
    withLinks: false,
  });
  const artifacts = within(panel).getByRole("region", { name: "Artifacts" });
  const more = buttonNamed("Show more", artifacts);
  click(more);
  await within(artifacts).findByText("report-60.pdf");
  click(more);
  await within(artifacts).findByText("report-65.pdf");

  click(artifactEntryNamed("report-1.pdf", artifacts));
  const preview = await screen.findByTestId("artifact-sidebar");
  click(buttonNamed("Back to all artifacts", preview));

  const gallery = await screen.findByTestId("thread-sidebar-artifacts");
  await expect(
    within(gallery).findByRole("heading", { name: "Artifacts 60+" }),
  ).resolves.toBeInTheDocument();
  expect(within(gallery).getByText("report-1.pdf")).toBeInTheDocument();
  expect(within(gallery).queryByText("report-65.pdf")).not.toBeInTheDocument();
});
