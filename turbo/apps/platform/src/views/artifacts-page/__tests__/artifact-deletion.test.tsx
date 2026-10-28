import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
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

const context = testContext();
const report = artifact();

async function openDeletion() {
  await expect(findArtifactAction(report.title)).resolves.toBeInTheDocument();
  click(getButtonByName(`More actions for ${report.title}`));
  const menu = await screen.findByRole("menu");
  const item = queryAllByRoleFast("menuitem", menu).find((element) => {
    return element.textContent?.trim() === "Delete";
  });
  if (!item) {
    throw new Error("Expected the artifact delete menu item");
  }
  click(item);
  return await screen.findByRole("dialog", { name: `Delete ${report.title}?` });
}

test("the deletion switch hides artifact management actions", async () => {
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: [report], nextCursor: null });
  });
  await setupPage({
    context,
    path: "/artifacts?tab=file",
    featureSwitches: { [FeatureSwitchKey.ArtifactDeletion]: false },
  });
  await expect(findArtifactAction(report.title)).resolves.toBeInTheDocument();
  expect(queryButtonByName(`More actions for ${report.title}`)).toBeUndefined();
});

test("cancel preserves an artifact and confirmation waits for deletion before removing it", async () => {
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
    featureSwitches: { [FeatureSwitchKey.ArtifactDeletion]: true },
  });
  const cancelled = await openDeletion();
  expect(
    within(cancelled).getByText(/Copies already downloaded/),
  ).toBeInTheDocument();
  click(getButtonByName("Cancel", cancelled));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  await waitFor(() => {
    expect(getButtonByName(`More actions for ${report.title}`)).toHaveFocus();
  });
  const dialog = await openDeletion();
  click(getButtonByName("Delete", dialog));
  await deleting.promise;
  await waitFor(() => {
    return expect(getButtonByName("Deleting…", dialog)).toBeDisabled();
  });
  expect(getButtonByName("Cancel", dialog)).toBeDisabled();
  expect(screen.getByText(report.title)).toBeInTheDocument();
  finish.resolve();
  await expect(
    screen.findByText("No artifacts found"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText(report.title)).not.toBeInTheDocument();
  await waitFor(() => {
    return expect(document.querySelector("main")).toHaveFocus();
  });
});

test("a failed deletion keeps confirmation open and can be retried", async () => {
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
  expect(screen.getByText(report.title)).toBeInTheDocument();
  expect(getButtonByName("Delete", dialog)).toBeEnabled();
  click(getButtonByName("Delete", dialog));
  await expect(
    screen.findByText("No artifacts found"),
  ).resolves.toBeInTheDocument();
});

test("deleting a saved shared conversation explains that its original link remains", async () => {
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
  const dialog = await openDeletion();
  expect(
    within(dialog).getByText(
      /The original conversation and its shared link will stay available/,
    ),
  ).toBeInTheDocument();
  click(getButtonByName("Delete", dialog));
  await expect(
    screen.findByText("No artifacts found"),
  ).resolves.toBeInTheDocument();
});

test("deleting a later-page artifact discards stale pages when the catalog refreshes", async () => {
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
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  await expect(findArtifactAction(first.title)).resolves.toBeInTheDocument();
  expect(screen.queryByText(report.title)).not.toBeInTheDocument();
});

test("a new publication can reappear under the same catalog identity", async () => {
  const website = artifact({ kind: "hosted-site" });
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
