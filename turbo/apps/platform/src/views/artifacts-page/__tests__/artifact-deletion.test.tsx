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
const REPORT = artifact({
  id: "a0000000-0000-4000-a000-000000000f01",
  title: "report.txt",
});

/** Serves report.txt as a stored text file the owner can open. */
function serveReportDetail(): void {
  const url = "https://files.example.test/catalog/report.txt";
  context.mocks.api(artifactCatalogContract.get, ({ params, respond }) => {
    expect(params.artifactId).toBe(REPORT.id);
    return respond(
      200,
      fileArtifactDetail(REPORT, {
        filename: "report.txt",
        contentType: "text/plain",
        fileId: "a0000000-0000-4000-a000-000000000f02",
        url,
      }),
    );
  });
  context.mocks.http.get(url, () => {
    return HttpResponse.text("Quarterly report");
  });
}

/** The catalog the API serves; deleting an artifact removes it. */
function serveCatalog(initial: readonly ArtifactSummary[]): {
  artifacts: ArtifactSummary[];
} {
  const server = { artifacts: [...initial] };
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: server.artifacts, nextCursor: null });
  });
  return server;
}

function removeFrom(server: { artifacts: ArtifactSummary[] }, id: string) {
  server.artifacts = server.artifacts.filter((item) => {
    return item.id !== id;
  });
}

async function openReport(): Promise<{
  preview: HTMLElement;
  trigger: HTMLElement;
}> {
  click(await findArtifactAction("report.txt"));
  const preview = await screen.findByRole("dialog", {
    name: "report.txt preview",
  });
  const trigger = await waitFor(() => {
    const found = getButtonByName("Delete", preview);
    expect(found).toBeEnabled();
    return found;
  });
  return { preview, trigger };
}

/** The catalog card stays in the page while a modal hides it from roles. */
function reportCard(): Element | null {
  return getCatalogViewport().querySelector(
    'button[aria-label="Preview report.txt"]',
  );
}

async function findConfirmation(): Promise<HTMLElement> {
  return await screen.findByRole("dialog", { name: "Delete report.txt?" });
}

test("preview cancellation and deletion keep the catalog consistent (sidebar=false)", async () => {
  const server = serveCatalog([REPORT]);
  serveReportDetail();
  const requested = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  context.mocks.api(
    artifactCatalogContract.delete,
    async ({ params, respond }) => {
      requested.resolve();
      await release.promise;
      removeFrom(server, params.artifactId);
      return respond(200, { deleted: true });
    },
  );
  await setupPage({
    context,
    path: "/artifacts",
    featureSwitches: { [FeatureSwitchKey.ArtifactSidebarPreview]: false },
  });
  const { trigger } = await openReport();
  const user = userEvent.setup({ delay: null });

  click(trigger);
  const cancelled = await findConfirmation();
  expect(cancelled).toHaveTextContent(
    "Copies already downloaded or saved to other services will remain.",
  );
  click(getButtonByName("Cancel", cancelled));
  await waitFor(() => {
    expect(cancelled).not.toBeInTheDocument();
  });
  expect(trigger).toHaveFocus();

  await user.keyboard("{Enter}");
  const escaped = await findConfirmation();
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(escaped).not.toBeInTheDocument();
  });
  expect(trigger).toHaveFocus();

  click(trigger);
  const confirmation = await findConfirmation();
  click(getButtonByName("Delete", confirmation));
  await requested.promise;

  await waitFor(() => {
    expect(getButtonByName("Deleting…", confirmation)).toBeDisabled();
  });
  expect(getButtonByName("Cancel", confirmation)).toBeDisabled();
  expect(queryButtonByName("Close", confirmation)).toBeUndefined();
  await user.keyboard("{Escape}");
  expect(confirmation).toBeInTheDocument();
  expect(reportCard()).toBeInTheDocument();

  release.resolve();

  await expect(
    screen.findByText("Artifact deleted"),
  ).resolves.toBeInTheDocument();
  await expect(
    screen.findByText("No artifacts found"),
  ).resolves.toBeInTheDocument();
  expect(reportCard()).toBeNull();
  await waitFor(() => {
    expect(getCatalogViewport()).toHaveFocus();
  });
});

test("a failed deletion can be cancelled, reopened, and retried", async () => {
  const server = serveCatalog([REPORT]);
  serveReportDetail();
  const attempts = { failNext: true };
  context.mocks.api(artifactCatalogContract.delete, ({ params, respond }) => {
    if (attempts.failNext) {
      attempts.failNext = false;
      return respond(503, {
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "Could not delete artifact",
        },
      });
    }
    removeFrom(server, params.artifactId);
    return respond(200, { deleted: true });
  });
  await setupPage({ context, path: "/artifacts" });
  const first = await openReport();
  click(first.trigger);
  const failed = await findConfirmation();

  click(getButtonByName("Delete", failed));

  await expect(
    screen.findByText("Could not delete artifact"),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(getButtonByName("Delete", failed)).toBeEnabled();
  });
  expect(screen.queryByText("Artifact deleted")).not.toBeInTheDocument();
  expect(reportCard()).toBeInTheDocument();
  click(getButtonByName("Cancel", failed));
  await waitFor(() => {
    expect(failed).not.toBeInTheDocument();
  });
  expect(first.trigger).toHaveFocus();

  click(getButtonByName("Close", first.preview));
  await waitFor(() => {
    expect(first.preview).not.toBeInTheDocument();
  });
  const second = await openReport();
  click(second.trigger);
  click(getButtonByName("Delete", await findConfirmation()));

  await expect(
    screen.findByText("No artifacts found"),
  ).resolves.toBeInTheDocument();
  expect(reportCard()).toBeNull();
});

test("deleting a later-page artifact discards stale pages when the catalog refreshes", async () => {
  const keep = artifact({
    id: "a0000000-0000-4000-a000-000000000f11",
    title: "keep-this.txt",
  });
  const server = { reportDeleted: false };
  context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
    if (server.reportDeleted) {
      return respond(200, { artifacts: [keep], nextCursor: null });
    }
    return respond(
      200,
      query.cursor === "later"
        ? { artifacts: [REPORT], nextCursor: null }
        : { artifacts: [keep], nextCursor: "later" },
    );
  });
  serveReportDetail();
  context.mocks.api(artifactCatalogContract.delete, ({ respond }) => {
    server.reportDeleted = true;
    return respond(200, { deleted: true });
  });
  await setupPage({ context, path: "/artifacts" });
  await findArtifactAction("keep-this.txt");

  // Scrolling to the end of the catalog loads its next page.
  fireEvent.scroll(getCatalogViewport());
  const report = await findArtifactAction("report.txt");
  const { trigger } = await openReport();
  click(trigger);
  click(getButtonByName("Delete", await findConfirmation()));

  await expect(
    screen.findByText("Artifact deleted"),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(report).not.toBeInTheDocument();
  });
  expect(
    within(getCatalogViewport()).queryByText("report.txt"),
  ).not.toBeInTheDocument();
  expect(getButtonByName("Preview keep-this.txt")).toBeEnabled();
});
