import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { chatThreadArtifactsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import {
  artifactSummary,
  buttonNamed,
  fileArtifactDetail,
  NAVIGATION_ARTIFACT_THREAD_ID,
} from "./chat-navigation-artifact-test-helpers.ts";
import {
  context,
  RESOURCE_ARTIFACT_ID,
  setupOverflowResources,
  setupResources,
} from "./chat-resources-test-helpers.ts";

function rejectLegacyList() {
  context.mocks.api(chatThreadArtifactsContract.list, () => {
    throw new Error("Directory resources must not request Run-grouped files");
  });
}

test("Browse directory summaries and open their detail without Run-grouped file metadata", async () => {
  let userOpenedArtifact = false;
  const report = artifactSummary(RESOURCE_ARTIFACT_ID, "file", "report.pdf");
  await setupResources({
    sourceUrl: false,
    mock: () => {
      rejectLegacyList();
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
          if (!userOpenedArtifact) {
            throw new Error(
              "Browsing summaries must not hydrate artifact details",
            );
          }
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
            : respond(404, { error: { message: "Artifact not found" } });
        },
      );
    },
  });
  const resources = await screen.findByRole("region", { name: "Resources" });
  await within(resources).findByText("report.pdf");
  // Old APIs omit sourceUrl: summaries remain usable without a detail lookup,
  // and their otherwise-unknown URL remains an ordinary message link.
  expect(within(resources).getByText("Report").closest("a")).toHaveAttribute(
    "href",
    "https://files.example.test/report.pdf",
  );
  expect(within(resources).getByText("Current guide")).toBeInTheDocument();

  userOpenedArtifact = true;
  click(buttonNamed("report.pdf", resources));
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

test("Deduplicate both source and hosted alias links using only summaries", async () => {
  await setupResources({
    aliasUrl: "https://report.sites.okou.ai/",
    mock: () => {
      rejectLegacyList();
      context.mocks.api(artifactCatalogContract.get, () => {
        throw new Error("Link deduplication must not hydrate artifact details");
      });
    },
  });
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
  await setupResources({ sourceUrl: false, mock: rejectLegacyList });
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
