import {
  artifactCatalogContract,
  type ArtifactSummary,
} from "@okouai/api-contracts/contracts/artifact-catalog";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { fileArtifactDetail } from "../../okou-page/__tests__/chat-navigation-artifact-test-helpers.ts";
import {
  artifact,
  findArtifactAction,
  getButtonByName,
  getCatalogViewport,
  queryButtonByName,
} from "./artifact-catalog-test-helpers.ts";

const context = testContext();
const reportTitle = "report.txt";
const reportUrl = "https://files.example.test/report.txt";

function mockReportPreview(report: ArtifactSummary) {
  context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
    return respond(
      200,
      fileArtifactDetail(report, {
        contentType: "text/plain",
        fileId: "f0000000-0000-4000-a000-000000000001",
        filename: reportTitle,
        url: reportUrl,
      }),
    );
  });
  context.mocks.http.get(reportUrl, () => {
    return HttpResponse.text("Report content");
  });
}

function currentPreview() {
  return (
    screen.queryByTestId("attachment-lightbox") ??
    screen.queryByTestId("artifact-sidebar")
  );
}

function catalogEntry(report: ArtifactSummary) {
  return document.querySelector(`button[data-artifact-id="${report.id}"]`);
}

async function openDeletion() {
  if (!currentPreview()) {
    click(await findArtifactAction(reportTitle));
  }
  const preview = await waitFor(() => {
    const element = currentPreview();
    if (!element) {
      throw new Error("Expected the artifact preview");
    }
    expect(getButtonByName("Delete", element)).toBeEnabled();
    return element;
  });
  click(getButtonByName("Delete", preview));
  return screen.findByRole("dialog", { name: `Delete ${reportTitle}?` });
}

function expectPreviewDeleteFocused() {
  const preview = currentPreview();
  if (!preview) {
    throw new Error("Expected the artifact preview");
  }
  expect(getButtonByName("Delete", preview)).toHaveFocus();
}

test("Cancelling, dismissing and then deleting from a preview keeps the catalog consistent", async () => {
  const user = userEvent.setup();
  const report = artifact({ title: reportTitle });
  mockReportPreview(report);
  let removed = false;
  const deleting = context.mocks.deferred<void>();
  const finish = context.mocks.deferred<void>();
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, {
      artifacts: removed ? [] : [report],
      nextCursor: null,
    });
  });
  context.mocks.api(
    artifactCatalogContract.delete,
    async ({ params, respond }) => {
      expect(params.artifactId).toBe(report.id);
      deleting.resolve();
      await finish.promise;
      removed = true;
      return respond(200, { deleted: true });
    },
  );
  await setupPage({
    context,
    path: "/artifacts?tab=file",
    featureSwitches: { [FeatureSwitchKey.ArtifactSidebarPreview]: false },
  });

  const cancelled = await openDeletion();
  expect(
    within(cancelled).getByText(/Copies already downloaded/u),
  ).toBeInTheDocument();
  click(getButtonByName("Cancel", cancelled));
  await waitFor(() => {
    expect(cancelled).not.toBeInTheDocument();
    expectPreviewDeleteFocused();
  });

  await user.keyboard("{Enter}");
  const keyboardDialog = await screen.findByRole("dialog", {
    name: `Delete ${reportTitle}?`,
  });
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(keyboardDialog).not.toBeInTheDocument();
    expectPreviewDeleteFocused();
  });

  const dialog = await openDeletion();
  click(getButtonByName("Delete", dialog));
  await deleting.promise;
  await waitFor(() => {
    expect(getButtonByName("Deleting…", dialog)).toBeDisabled();
  });
  expect(getButtonByName("Cancel", dialog)).toBeDisabled();
  expect(queryButtonByName("Close", dialog)).toBeUndefined();
  await user.keyboard("{Escape}");
  expect(dialog).toBeInTheDocument();
  expect(dialog).toHaveAccessibleName(`Delete ${reportTitle}?`);
  expect(catalogEntry(report)).toBeInTheDocument();

  finish.resolve();
  await expect(
    screen.findByText("Artifact deleted"),
  ).resolves.toBeInTheDocument();
  await expect(
    screen.findByText("No artifacts found"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText(reportTitle)).not.toBeInTheDocument();
  await waitFor(() => {
    expect(document.querySelector("main")).toHaveFocus();
  });
});

test("A failed deletion can be cancelled, reopened and retried", async () => {
  const report = artifact({ title: reportTitle });
  mockReportPreview(report);
  let removed = false;
  let unavailable = true;
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, {
      artifacts: removed ? [] : [report],
      nextCursor: null,
    });
  });
  context.mocks.api(artifactCatalogContract.delete, ({ respond }) => {
    if (unavailable) {
      unavailable = false;
      return respond(503, {
        error: { code: "NOT_CONFIGURED", message: "Could not delete artifact" },
      });
    }
    removed = true;
    return respond(200, { deleted: true });
  });
  await setupPage({ context, path: "/artifacts?tab=file" });

  const dialog = await openDeletion();
  click(getButtonByName("Delete", dialog));
  await expect(
    screen.findByText("Could not delete artifact"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText("Artifact deleted")).not.toBeInTheDocument();
  expect(catalogEntry(report)).toBeInTheDocument();
  expect(getButtonByName("Delete", dialog)).toBeEnabled();

  click(getButtonByName("Cancel", dialog));
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
    expectPreviewDeleteFocused();
  });
  const preview = currentPreview();
  if (!preview) {
    throw new Error("Expected the artifact preview");
  }
  click(getButtonByName("Close", preview));
  await waitFor(() => {
    expect(preview).not.toBeInTheDocument();
  });

  const reopened = await openDeletion();
  click(getButtonByName("Delete", reopened));
  await expect(
    screen.findByText("No artifacts found"),
  ).resolves.toBeInTheDocument();
  expect(catalogEntry(report)).not.toBeInTheDocument();
});

test("Deleting a later-page artifact discards the stale page when the catalog refreshes", async () => {
  const report = artifact({ title: reportTitle });
  const first = artifact({
    id: "a0000000-0000-4000-a000-000000000002",
    title: "keep-this.txt",
  });
  mockReportPreview(report);
  let removed = false;
  context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
    return respond(
      200,
      query.cursor
        ? { artifacts: removed ? [] : [report], nextCursor: null }
        : { artifacts: [first], nextCursor: "next-page" },
    );
  });
  context.mocks.api(artifactCatalogContract.delete, ({ respond }) => {
    removed = true;
    return respond(200, { deleted: true });
  });
  await setupPage({ context, path: "/artifacts?tab=file" });
  await expect(findArtifactAction(first.title)).resolves.toBeInTheDocument();

  fireEvent.scroll(getCatalogViewport());
  const dialog = await openDeletion();
  click(getButtonByName("Delete", dialog));

  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
  await expect(findArtifactAction(first.title)).resolves.toBeInTheDocument();
  expect(screen.queryByText(reportTitle)).not.toBeInTheDocument();
});
