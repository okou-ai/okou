import { HttpResponse } from "msw";
import {
  type ArtifactSummary,
  artifactCatalogContract,
} from "@okouai/api-contracts/contracts/artifact-catalog";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  artifact,
  findArtifactAction,
  getButtonByName,
  getCatalogViewport,
  queryButtonByName,
} from "./artifact-catalog-test-helpers.ts";

import { findNamedMenuItem } from "../../okou-page/__tests__/chat-attachment-test-helpers.ts";

const context = testContext();
const report = artifact();

function mockPreview(summary: ArtifactSummary = report) {
  context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
    return summary.kind === "hosted-site"
      ? respond(200, {
          ...summary,
          kind: "hosted-site",
          site: {
            id: "f0000000-0000-4000-a000-000000000001",
            slug: "test-site",
            publicSlug: "test-site",
            url: "https://files.example.test/site",
            deploymentVersion: 1,
            entrypoint: "index.html",
            spaFallback: false,
          },
        })
      : respond(200, {
          ...summary,
          kind: "file",
          file: {
            id: "f0000000-0000-4000-a000-000000000001",
            filename: summary.title,
            contentType: "text/plain",
            size: 12,
            url: "https://files.example.test/report.txt",
            previewImageUrl: null,
          },
        });
  });
  context.mocks.http.get("https://files.example.test/report.txt", () => {
    return HttpResponse.text("Report content");
  });
}

async function openSharedConversationDeletion() {
  await expect(findArtifactAction(report.title)).resolves.toBeInTheDocument();
  click(getButtonByName(`More actions for ${report.title}`));
  const menu = await screen.findByRole("menu");
  const item = queryAllByRoleFast("menuitem", menu).find((element) => {
    return element.textContent?.trim() === "Delete";
  });
  if (!item) {
    throw new Error("Expected the shared-conversation delete action");
  }
  click(item);
  return await screen.findByRole("dialog", { name: `Delete ${report.title}?` });
}

function currentPreview() {
  return (
    screen.queryByTestId("attachment-lightbox") ??
    screen.queryByTestId("artifact-sidebar")
  );
}

async function openDeletion() {
  if (!currentPreview()) {
    click(await findArtifactAction(report.title));
  }
  await waitFor(() => {
    expect(currentPreview()).toBeInTheDocument();
  });
  const preview = currentPreview()!;
  await waitFor(() => {
    expect(
      getButtonByName("More artifact actions", preview),
    ).toBeInTheDocument();
  });
  click(getButtonByName("More artifact actions", preview));
  click(await findNamedMenuItem("Delete"));
  return await screen.findByRole("dialog", { name: `Delete ${report.title}?` });
}

test.each([false, true])(
  "the deletion switch hides artifact management actions (sidebar=%s)",
  async (sidebar) => {
    mockPreview();
    context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
      return respond(200, { artifacts: [report], nextCursor: null });
    });
    await setupPage({
      context,
      path: "/artifacts?tab=file",
      featureSwitches: {
        [FeatureSwitchKey.ArtifactDeletion]: false,
        [FeatureSwitchKey.ArtifactSidebarPreview]: sidebar,
      },
    });
    await expect(findArtifactAction(report.title)).resolves.toBeInTheDocument();
    expect(
      queryButtonByName(`More actions for ${report.title}`),
    ).toBeUndefined();
    click(await findArtifactAction(report.title));
    const preview = await screen.findByTestId(
      sidebar ? "artifact-sidebar" : "attachment-lightbox",
    );
    expect(queryButtonByName("More artifact actions", preview)).toBeUndefined();
    expect(queryButtonByName("Delete", preview)).toBeUndefined();
  },
);

test.each([false, true])(
  "preview cancellation and deletion keep the catalog consistent (sidebar=%s)",
  async (sidebar) => {
    const user = userEvent.setup();
    mockPreview();
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
      featureSwitches: {
        [FeatureSwitchKey.ArtifactDeletion]: true,
        [FeatureSwitchKey.ArtifactSidebarPreview]: sidebar,
      },
    });
    const cancelled = await openDeletion();
    expect(
      within(cancelled).getByText(/Copies already downloaded/),
    ).toBeInTheDocument();
    click(getButtonByName("Cancel", cancelled));
    await waitFor(() => {
      return expect(
        screen.queryByRole("dialog", { name: `Delete ${report.title}?` }),
      ).not.toBeInTheDocument();
    });
    await waitFor(() => {
      const preview =
        screen.queryByTestId("attachment-lightbox") ??
        screen.getByTestId("artifact-sidebar");
      expect(getButtonByName("More artifact actions", preview)).toHaveFocus();
    });
    await user.keyboard("{Enter}");
    const keyboardItem = await findNamedMenuItem("Delete");
    await waitFor(() => {
      return expect(keyboardItem).toHaveFocus();
    });
    await user.keyboard("{Enter}");
    const keyboardDialog = await screen.findByRole("dialog", {
      name: `Delete ${report.title}?`,
    });
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(keyboardDialog).not.toBeInTheDocument();
      expect(
        getButtonByName("More artifact actions", currentPreview()!),
      ).toHaveFocus();
    });
    const dialog = await openDeletion();
    click(getButtonByName("Delete", dialog));
    await deleting.promise;
    await waitFor(() => {
      return expect(getButtonByName("Deleting…", dialog)).toBeDisabled();
    });
    expect(getButtonByName("Cancel", dialog)).toBeDisabled();
    expect(queryButtonByName("Close", dialog)).toBeUndefined();
    await user.keyboard("{Escape}");
    expect(dialog).toBeInTheDocument();
    expect(currentPreview()).toBeInTheDocument();
    expect(
      document.querySelector(`button[data-artifact-id="${report.id}"]`),
    ).toBeInTheDocument();
    expect(screen.queryByText("Artifact deleted")).not.toBeInTheDocument();
    finish.resolve();
    await expect(
      screen.findByText("Artifact deleted"),
    ).resolves.toBeInTheDocument();
    await expect(
      screen.findByText("No artifacts found"),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByText(report.title)).not.toBeInTheDocument();
    await waitFor(() => {
      return expect(document.querySelector("main")).toHaveFocus();
    });
  },
);

test("a failed deletion can be cancelled, reopened, and retried", async () => {
  mockPreview();
  let removed = false;
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, {
      artifacts: removed ? [] : [report],
      nextCursor: null,
    });
  });
  let unavailable = true;
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
  await setupPage({
    context,
    path: "/artifacts?tab=file",
    featureSwitches: { [FeatureSwitchKey.ArtifactDeletion]: true },
  });
  const dialog = await openDeletion();
  click(getButtonByName("Delete", dialog));
  await expect(
    screen.findByText("Could not delete artifact"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText("Artifact deleted")).not.toBeInTheDocument();
  expect(
    document.querySelector(`button[data-artifact-id="${report.id}"]`),
  ).toBeInTheDocument();
  expect(getButtonByName("Delete", dialog)).toBeEnabled();
  click(getButtonByName("Cancel", dialog));
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
    expect(
      getButtonByName("More artifact actions", currentPreview()!),
    ).toHaveFocus();
  });
  const preview = currentPreview()!;
  click(getButtonByName("Close", preview));
  await waitFor(() => {
    expect(preview).not.toBeInTheDocument();
  });
  const reopened = await openDeletion();
  click(getButtonByName("Delete", reopened));
  await expect(
    screen.findByText("Artifact deleted"),
  ).resolves.toBeInTheDocument();
  await expect(
    screen.findByText("No artifacts found"),
  ).resolves.toBeInTheDocument();
});

test("deleting a shared conversation explains that its shared link will stop working", async () => {
  let removed = false;
  const conversation = artifact({ kind: "shared-thread" });
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, {
      artifacts: removed ? [] : [conversation],
      nextCursor: null,
    });
  });
  context.mocks.api(artifactCatalogContract.delete, ({ respond }) => {
    removed = true;
    return respond(200, { deleted: true });
  });
  await setupPage({
    context,
    path: "/artifacts?tab=shared-thread",
    featureSwitches: { [FeatureSwitchKey.ArtifactDeletion]: true },
  });
  const dialog = await openSharedConversationDeletion();
  expect(
    within(dialog).getByText(/Its shared link will stop working/),
  ).toBeInTheDocument();
  click(getButtonByName("Delete", dialog));
  await expect(
    screen.findByText("Artifact deleted"),
  ).resolves.toBeInTheDocument();
  await expect(
    screen.findByText("No artifacts found"),
  ).resolves.toBeInTheDocument();
});

test("deleting a later-page artifact discards stale pages when the catalog refreshes", async () => {
  mockPreview();
  const first = artifact({
    id: "a0000000-0000-4000-a000-000000000002",
    title: "keep-this.txt",
  });
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
  await setupPage({
    context,
    path: "/artifacts?tab=file",
    featureSwitches: { [FeatureSwitchKey.ArtifactDeletion]: true },
  });
  await expect(findArtifactAction(first.title)).resolves.toBeInTheDocument();
  fireEvent.scroll(getCatalogViewport());
  const dialog = await openDeletion();
  click(getButtonByName("Delete", dialog));
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: `Delete ${report.title}?` }),
    ).not.toBeInTheDocument();
  });
  await expect(findArtifactAction(first.title)).resolves.toBeInTheDocument();
  expect(screen.queryByText(report.title)).not.toBeInTheDocument();
});

test("a new publication can reappear under the same catalog identity", async () => {
  const website = artifact({ kind: "hosted-site" });
  mockPreview(website);
  let removed = false;
  context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
    return respond(200, {
      artifacts: !removed && query.kind === "hosted-site" ? [website] : [],
      nextCursor: null,
    });
  });
  context.mocks.api(artifactCatalogContract.delete, ({ respond }) => {
    removed = true;
    return respond(200, { deleted: true });
  });
  await setupPage({
    context,
    path: "/artifacts?tab=hosted-site",
    featureSwitches: { [FeatureSwitchKey.ArtifactDeletion]: true },
  });
  const dialog = await openDeletion();
  click(getButtonByName("Delete", dialog));
  await expect(
    screen.findByText("No artifacts found"),
  ).resolves.toBeInTheDocument();
  // A subsequent server publication, observed through a fresh catalog request.
  removed = false;
  click(getButtonByName("Show file artifacts"));
  await waitFor(() => {
    expect(getButtonByName("Show file artifacts")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
  click(getButtonByName("Show website artifacts"));
  await expect(findArtifactAction(report.title)).resolves.toBeInTheDocument();
});
