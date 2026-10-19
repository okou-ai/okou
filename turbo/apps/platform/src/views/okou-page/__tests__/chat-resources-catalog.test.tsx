import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { screen, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import {
  artifactSummary,
  buttonNamed,
  fileArtifactDetail,
  NAVIGATION_ARTIFACT_THREAD_ID,
} from "./chat-navigation-artifact-test-helpers.ts";
import { privateAttachmentUrl } from "./chat-attachment-test-helpers.ts";
import {
  context,
  RESOURCE_ARTIFACT_ID,
  setupOverflowResources,
  setupResources,
} from "./chat-resources-test-helpers.ts";

function artifactEntryNamed(title: string, container: HTMLElement) {
  const button = within(container).getByText(title).closest("button");
  if (!button) {
    throw new Error(`Artifact entry not found: ${title}`);
  }
  return button;
}

test("Browse directory artifacts with permanently optional source URLs and open their detail", async () => {
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
  // Shared snapshots legitimately omit source/alias URLs. Their directory
  // entries remain usable, and unknown URLs remain ordinary message links.
  expect(within(resources).getByText("Report").closest("a")).toHaveAttribute(
    "href",
    "https://files.example.test/report.pdf",
  );
  expect(within(resources).getByText("Current guide")).toBeInTheDocument();

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
});

test.each([
  {
    kind: "hosted-site",
    aliasUrl: "https://report.sites.okou.ai/",
    title: "report.sites.okou.ai",
  },
  {
    kind: "presentation",
    aliasUrl: "https://report.sites.okou.ai/",
    title: "index.html",
  },
  { kind: "hosted-site", aliasUrl: undefined, title: "index.html" },
] as const)(
  "Render the $kind resource title as $title",
  async ({ kind, aliasUrl, title }) => {
    const artifact = {
      ...artifactSummary(RESOURCE_ARTIFACT_ID, kind, "index.html"),
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

test("Deduplicate both source and hosted alias links using only summaries", async () => {
  await setupResources({ aliasUrl: "https://report.sites.okou.ai/" });
  const resources = await screen.findByRole("region", { name: "Resources" });
  await within(resources).findByText("report.pdf");
  const links = within(resources).getByRole("region", { name: "Links" });
  expect(within(links).queryByText("Report")).not.toBeInTheDocument();
  expect(within(links).queryByText("Hosted alias")).not.toBeInTheDocument();
  expect(within(links).getByText("Current guide")).toBeInTheDocument();
  expect(within(links).getByText("Reference")).toBeInTheDocument();
});

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

test("Expose resources beyond the catalog's default page and retain expansion after loading them", async () => {
  const { panel } = await setupOverflowResources(65, {
    paginated: true,
    withLinks: false,
  });
  const artifacts = within(panel).getByRole("region", { name: "Artifacts" });
  click(buttonNamed("Expand", artifacts));
  await within(artifacts).findByText("report-60.pdf");
  expect(
    within(artifacts).queryByText("report-61.pdf"),
  ).not.toBeInTheDocument();
  click(buttonNamed("Load more", artifacts));
  await within(artifacts).findByText("report-65.pdf");
  expect(within(artifacts).getAllByRole("listitem")).toHaveLength(65);
  expect(
    queryAllByRoleFast("button", artifacts).some((button) => {
      return button.textContent?.trim() === "Load more";
    }),
  ).toBeFalsy();
  click(buttonNamed("Collapse", artifacts));
  expect(within(artifacts).getAllByRole("listitem")).toHaveLength(3);
  click(buttonNamed("Expand", artifacts));
  await within(artifacts).findByText("report-65.pdf");
});
