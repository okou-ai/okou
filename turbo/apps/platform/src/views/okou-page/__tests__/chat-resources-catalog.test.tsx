import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import {
  artifactSummary,
  buttonNamed,
  fileArtifactDetail,
  NAVIGATION_ARTIFACT_THREAD_ID,
} from "./chat-navigation-artifact-test-helpers.ts";
import { privateAttachmentUrl } from "./chat-attachment-test-helpers.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  createChatResourcesHelpers,
  RESOURCE_ARTIFACT_ID,
} from "./chat-resources-test-helpers.ts";

const context = testContext();
const { setupOverflowResources, setupResources } =
  createChatResourcesHelpers(context);

function artifactEntryNamed(title: string, container: HTMLElement) {
  const button = within(container).getByText(title).closest("button");
  if (!button) {
    throw new Error(`Artifact entry not found: ${title}`);
  }
  return button;
}

test("Browse artifacts without source URLs in the popover and sidebar without showing message links", async () => {
  const report = artifactSummary(RESOURCE_ARTIFACT_ID, "file", "report.pdf");
  await setupResources({
    sourceUrl: false,
    mock: () => {
      context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
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
                  filename: "download-report.pdf",
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
  const resources = await screen.findByRole("region", { name: "Resources" });
  await within(resources).findByText("report.pdf");
  click(artifactEntryNamed("report.pdf", resources));
  const sidebar = await screen.findByTestId("artifact-sidebar");
  await within(sidebar).findByText("download-report.pdf");
  expect(buttonNamed("Download artifact", sidebar)).toBeInTheDocument();
  await expect(
    within(sidebar).findByTestId("artifact-sidebar-body-pdf"),
  ).resolves.toHaveAttribute(
    "src",
    "https://files.example.test/download-report.pdf#navpanes=0",
  );

  click(buttonNamed("Back to all artifacts", sidebar));
  const artifactList = await screen.findByTestId("thread-sidebar-artifacts");
  await within(artifactList).findByText("report.pdf");
  expect(
    within(artifactList).getByRole("heading", { name: "Artifacts 1" }),
  ).toBeInTheDocument();
  expect(within(artifactList).queryByRole("tablist")).not.toBeInTheDocument();

  click(buttonNamed("Preview report.pdf", artifactList));
  await within(await screen.findByTestId("artifact-sidebar")).findByText(
    "download-report.pdf",
  );
});

test.each([
  {
    kind: "hosted-site",
    aliasUrl: "https://report.sites.okou.ai/",
    title: "Quarterly report",
  },
  {
    kind: "presentation",
    aliasUrl: "https://report.sites.okou.ai/",
    title: "Report presentation",
  },
  { kind: "hosted-site", aliasUrl: undefined, title: "Private report" },
] as const)(
  "Render the $kind resource title as $title",
  async ({ kind, aliasUrl, title }) => {
    const artifact = {
      ...artifactSummary(RESOURCE_ARTIFACT_ID, kind, title),
      aliasUrl,
    };
    await setupResources({
      mock: () => {
        context.mocks.api(
          artifactCatalogContract.list,
          ({ query, respond }) => {
            return respond(200, {
              artifacts:
                query.chatThreadId === NAVIGATION_ARTIFACT_THREAD_ID
                  ? [artifact]
                  : [],
              nextCursor: null,
            });
          },
        );
      },
    });
    const resources = await screen.findByRole("region", { name: "Resources" });
    await within(resources).findByText(title);
    expect(artifactEntryNamed(title, resources)).toBeInTheDocument();
  },
);

test("Copy an artifact's on-demand detail URL without opening its preview", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  await setupResources({ sourceUrl: false });
  const resources = await screen.findByRole("region", { name: "Resources" });
  const artifacts = within(resources).getByRole("region", {
    name: "Artifacts",
  });
  await within(artifacts).findByText("report.pdf");
  click(buttonNamed("Copy link", artifacts));
  await screen.findByText("Link copied");
  expect(clipboard.writes.at(-1)).toBe("https://files.example.test/report.pdf");
  expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
});

test("Copying a private artifact reports failure without exposing its signed or authenticated URL", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  const report = artifactSummary(RESOURCE_ARTIFACT_ID, "file", "report.pdf");
  const fileId = "b0000000-0000-4000-a000-000000000999";
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
            url: privateAttachmentUrl(fileId),
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
  const resources = await screen.findByRole("region", { name: "Resources" });
  const artifacts = within(resources).getByRole("region", {
    name: "Artifacts",
  });
  await within(artifacts).findByText("report.pdf");
  click(buttonNamed("Copy link", artifacts));
  await screen.findByText("Could not copy the link");
  expect(clipboard.writes).toStrictEqual([]);
  expect(screen.queryByText("Link copied")).not.toBeInTheDocument();
  expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
  expect(artifactEntryNamed("report.pdf", artifacts)).toBeEnabled();
});

test("Copying an unavailable artifact reports failure", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  await setupResources({
    mock: () => {
      context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "Artifact not found" },
        });
      });
    },
  });
  const resources = await screen.findByRole("region", { name: "Resources" });
  const artifacts = within(resources).getByRole("region", {
    name: "Artifacts",
  });
  await within(artifacts).findByText("report.pdf");
  click(buttonNamed("Copy link", artifacts));
  await screen.findByText("Could not copy the link");
  expect(clipboard.writes).toStrictEqual([]);
  expect(screen.queryByText("Link copied")).not.toBeInTheDocument();
});

test("Copying an artifact reports a browser clipboard failure", async () => {
  context.mocks.browser.clipboardExecCommand();
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
    new DOMException("Clipboard unavailable", "NotAllowedError"),
  );
  vi.spyOn(document, "execCommand").mockReturnValue(false);
  await setupResources();
  const resources = await screen.findByRole("region", { name: "Resources" });
  const artifacts = within(resources).getByRole("region", {
    name: "Artifacts",
  });
  await within(artifacts).findByText("report.pdf");
  click(buttonNamed("Copy link", artifacts));
  await screen.findByText("Could not copy the link");
  expect(screen.queryByText("Link copied")).not.toBeInTheDocument();
  expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
});

function resourceViewport(panel: HTMLElement) {
  const viewport = panel.querySelector<HTMLElement>("[data-resource-scroll]");
  if (!viewport) {
    throw new Error("Expected the resource scroll container");
  }
  Object.defineProperties(viewport, {
    clientHeight: { configurable: true, value: 500 },
    scrollHeight: { configurable: true, value: 2500 },
  });
  return viewport;
}

test("Show more resources until the last page, then collapse with the same control", async () => {
  const { panel } = await setupOverflowResources(125, {
    paginated: true,
    withLinks: false,
  });
  const artifacts = within(panel).getByRole("region", { name: "Artifacts" });
  const viewport = resourceViewport(panel);
  fireEvent.scroll(viewport, { target: { scrollTop: 2000 } });
  expect(queryAllByRoleFast("listitem", artifacts)).toHaveLength(3);
  const more = buttonNamed("Show more", artifacts);
  click(more);
  await within(artifacts).findByText("report-60.pdf");
  expect(more).toHaveAttribute("aria-expanded", "true");
  expect(more).toHaveTextContent("Show more");
  expect(within(artifacts).queryByText("Collapse")).not.toBeInTheDocument();
  fireEvent.scroll(viewport, { target: { scrollTop: 2000 } });
  expect(within(artifacts).queryByRole("status")).not.toBeInTheDocument();
  expect(
    within(artifacts).queryByText("report-61.pdf"),
  ).not.toBeInTheDocument();

  click(more);
  await within(artifacts).findByText("report-120.pdf");
  expect(queryAllByRoleFast("listitem", artifacts)).toHaveLength(120);
  expect(more).toHaveTextContent("Show more");
  expect(
    within(artifacts).queryByText("report-121.pdf"),
  ).not.toBeInTheDocument();

  click(more);
  await within(artifacts).findByText("report-125.pdf");
  expect(queryAllByRoleFast("listitem", artifacts)).toHaveLength(125);
  expect(more).toHaveTextContent("Collapse");
  expect(within(artifacts).queryByText("Show more")).not.toBeInTheDocument();
  click(more);
  expect(queryAllByRoleFast("listitem", artifacts)).toHaveLength(3);
  expect(more).toHaveTextContent("Show more");
  click(more);
  await within(artifacts).findByText("report-125.pdf");
  expect(queryAllByRoleFast("listitem", artifacts)).toHaveLength(125);
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
  const viewport = resourceViewport(panel);
  const more = buttonNamed("Show more", artifacts);
  click(more);
  await within(artifacts).findByText("report-60.pdf");
  more.focus();
  click(more);
  await expect(
    within(artifacts).findByRole("status"),
  ).resolves.toHaveTextContent("Loading resources");
  expect(more).toHaveAttribute("aria-disabled", "true");
  expect(more).toHaveAttribute("aria-busy", "true");
  expect(more).toHaveFocus();
  click(more);
  click(more);
  fireEvent.scroll(viewport, { target: { scrollTop: 2000 } });
  expect(within(artifacts).getAllByRole("listitem")).toHaveLength(60);
  expect(within(artifacts).queryByText("Collapse")).not.toBeInTheDocument();

  nextPage.resolve();
  await within(artifacts).findByText("report-120.pdf");
  expect(within(artifacts).getAllByRole("listitem")).toHaveLength(120);
  expect(more).not.toHaveAttribute("aria-disabled", "true");
  expect(more).toHaveFocus();
  expect(more).toHaveTextContent("Show more");
  expect(within(artifacts).queryByRole("status")).not.toBeInTheDocument();
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
  const viewport = resourceViewport(panel);
  const more = buttonNamed("Show more", artifacts);
  click(more);
  await within(artifacts).findByText("report-60.pdf");
  click(more);
  await expect(
    within(artifacts).findByRole("alert"),
  ).resolves.toHaveTextContent("Could not load resources");
  expect(within(artifacts).getAllByRole("listitem")).toHaveLength(60);
  expect(more).toBeEnabled();
  expect(more).toHaveTextContent("Show more");
  expect(within(artifacts).queryByText("Collapse")).not.toBeInTheDocument();

  failed = false;
  fireEvent.scroll(viewport, { target: { scrollTop: 2000 } });
  expect(within(artifacts).getByRole("alert")).toBeInTheDocument();
  click(more);
  await within(artifacts).findByText("report-65.pdf");
  expect(within(artifacts).getAllByRole("listitem")).toHaveLength(65);
  expect(within(artifacts).queryByRole("alert")).not.toBeInTheDocument();
  expect(more).toHaveTextContent("Collapse");
});

test("Copy link tooltips follow resource focus and close when their row collapses", async () => {
  const user = userEvent.setup();
  const clipboard = context.mocks.browser.clipboardWriteText();
  const { panel } = await setupOverflowResources(4, { withLinks: false });
  const artifacts = within(panel).getByRole("region", { name: "Artifacts" });
  const more = buttonNamed("Show more", artifacts);
  click(more);
  await within(artifacts).findByText("report-4.pdf");
  const firstEntry = artifactEntryNamed("report-1.pdf", artifacts);
  const lastEntry = artifactEntryNamed("report-4.pdf", artifacts);
  const firstRow = firstEntry.closest("li");
  const lastRow = lastEntry.closest("li");
  if (!firstRow || !lastRow) {
    throw new Error("Expected both resource rows");
  }
  const firstCopy = buttonNamed("Copy link", firstRow);
  const lastCopy = buttonNamed("Copy link", lastRow);

  await user.hover(firstCopy);
  await expect(screen.findByText("Copy link")).resolves.toBeVisible();
  expect(firstCopy).toHaveAccessibleName("Copy link");
  await user.unhover(firstCopy);
  await waitFor(() => {
    expect(screen.queryByText("Copy link")).not.toBeInTheDocument();
  });

  lastCopy.focus();
  expect(lastCopy).toHaveFocus();
  await expect(screen.findByText("Copy link")).resolves.toBeVisible();
  expect(lastCopy).toHaveAccessibleName("Copy link");

  click(more);
  expect(within(artifacts).getAllByRole("listitem")).toHaveLength(3);
  expect(within(artifacts).queryByText("report-4.pdf")).not.toBeInTheDocument();
  await waitFor(() => {
    expect(screen.queryByText("Copy link")).not.toBeInTheDocument();
  });

  firstCopy.focus();
  expect(firstCopy).toHaveFocus();
  await user.keyboard("{Enter}");
  await screen.findByText("Link copied");
  expect(clipboard.writes).toStrictEqual([
    "https://files.example.test/report-1.pdf",
  ]);
});
