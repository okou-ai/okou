import { artifactFavoritesContract } from "@okouai/api-contracts/contracts/artifact-favorites";
import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getButtonByName,
  queryButtonByName,
} from "../../artifacts-page/__tests__/artifact-catalog-test-helpers.ts";
import {
  sharedThread,
  SHARED_THREAD_ID,
} from "../../shared-thread-page/__tests__/shared-thread-test-helpers.ts";

const context = testContext();
const CATALOG_ID = "a0000000-0000-4000-a000-000000000002";
const FILE_ID = "b0000000-0000-4000-a000-000000000002";
const path = "/artifacts/70000000000040008000000000000022.png";
const filename = "Shared survey.png";
const features = Object.freeze({
  [FeatureSwitchKey.ArtifactLibrary]: true,
  [FeatureSwitchKey.Star]: true,
});

function publicImage(snapshot = false) {
  context.mocks.api(artifactReferencesContract.publicUrl, ({ respond }) => {
    return respond(200, {
      url: "https://files.example.test/survey.png",
      downloadUrl: "https://files.example.test/survey-original.png",
      ...(snapshot ? { sharedThreadSnapshot: true } : {}),
      preview: { filename, contentType: "image/png" },
    });
  });
}

function getFavoriteMenuItem(name: string, menu: HTMLElement): HTMLElement {
  const item = queryAllByRoleFast("menuitem", menu).find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!item) {
    throw new Error(`Expected favorite action "${name}"`);
  }
  return item;
}

test("A signed-in shared-artifact reader favorites the catalog identity from the existing more menu", async () => {
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    return respond(200, {
      target: { kind: "file", id: FILE_ID },
      filename,
      contentType: "image/png",
      url: "https://files.example.test/survey.png",
      downloadUrl: "https://files.example.test/survey-original.png",
      expiresAt: "2099-01-01T00:00:00Z",
    });
  });
  context.mocks.api(artifactFavoritesContract.resolve, ({ query, respond }) => {
    expect(query.url).toBe(`https://app.okou.ai${path}`);
    return respond(200, { artifactId: CATALOG_ID, favorited: false });
  });
  context.mocks.api(artifactFavoritesContract.create, ({ body, respond }) => {
    expect(body).toStrictEqual({ artifactId: CATALOG_ID });
    return respond(200, { artifactId: CATALOG_ID, favorited: true });
  });
  await setupPage({
    context,
    host: "app.okou.ai",
    path,
    featureSwitches: features,
  });
  await expect(
    screen.findByRole("img", { name: filename }),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(getButtonByName("More artifact actions")).toBeEnabled();
  });
  click(getButtonByName("More artifact actions"));
  let menu = await screen.findByRole("menu");
  click(getFavoriteMenuItem("Add to favorites", menu));
  await expect(
    screen.findByText("Added to favorites"),
  ).resolves.toBeInTheDocument();
  expect(location.pathname).toBe(path);
  click(getButtonByName("More artifact actions"));
  menu = await screen.findByRole("menu");
  expect(
    getFavoriteMenuItem("Remove from favorites", menu),
  ).toBeInTheDocument();
});

test.each([
  { signedIn: false, snapshot: false },
  { signedIn: true, snapshot: true },
])(
  "Public previews preserve access without favorite actions for signed-out visitors or nested snapshots: %j",
  async ({ signedIn, snapshot }) => {
    publicImage(snapshot);
    if (signedIn) {
      context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "Use the public snapshot" },
        });
      });
    }
    await setupPage({
      context,
      host: "app.okou.ai",
      path,
      auth: signedIn ? undefined : null,
      featureSwitches: features,
    });
    await expect(
      screen.findByRole("img", { name: filename }),
    ).resolves.toBeInTheDocument();
    expect(queryButtonByName("More artifact actions")).toBeUndefined();
    expect(getButtonByName("Share")).toBeEnabled();
  },
);

test("A shared conversation favorites the whole conversation from its header menu", async () => {
  const sharedPath = `/share/threads/${SHARED_THREAD_ID}`;
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(200, sharedThread({ title: "Shared launch review" }));
  });
  context.mocks.api(artifactFavoritesContract.resolve, ({ query, respond }) => {
    expect(query.url).toBe(`https://app.okou.ai${sharedPath}`);
    return respond(200, { artifactId: CATALOG_ID, favorited: false });
  });
  context.mocks.api(artifactFavoritesContract.create, ({ body, respond }) => {
    expect(body).toStrictEqual({ artifactId: CATALOG_ID });
    return respond(200, { artifactId: CATALOG_ID, favorited: true });
  });
  await setupPage({
    context,
    host: "app.okou.ai",
    path: sharedPath,
    featureSwitches: features,
  });
  await expect(
    screen.findByRole("heading", { name: "Shared launch review" }),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(getButtonByName("More artifact actions")).toBeEnabled();
  });
  click(getButtonByName("More artifact actions"));
  const menu = await screen.findByRole("menu");
  click(getFavoriteMenuItem("Add to favorites", menu));
  await expect(
    screen.findByText("Added to favorites"),
  ).resolves.toBeInTheDocument();
  expect(location.pathname).toBe(sharedPath);
});
