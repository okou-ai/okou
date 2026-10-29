import {
  artifactCatalogContract,
  type ArtifactDetail,
} from "@okouai/api-contracts/contracts/artifact-catalog";
import {
  artifactReferencePath,
  artifactReferencesContract,
} from "@okouai/api-contracts/contracts/artifact-references";
import { artifactSharesContract } from "@okouai/api-contracts/contracts/artifact-shares";
import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { act, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { emitMockedClerkEvent } from "../../../__tests__/mock-auth.ts";

const context = testContext();
const sourceId = "f0000000-0000-4000-a000-000000000910";
const catalogId = "a0000000-0000-4000-a000-000000000910";
const filename = "launch.png";
const title = "Launch plan";
const url = "https://files.example.test/launch.png";
type PageKind = "file" | "html" | "shared-thread";

beforeEach(() => {
  context.mocks.api(artifactReferencesContract.ownerArtifact, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Artifact unavailable" },
    });
  });
  context.mocks.api(artifactSharesContract.status, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Artifact unavailable" },
    });
  });
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: [], nextCursor: null });
  });
});

function button(name: string, container: ParentNode = document.body) {
  const result = queryAllByRoleFast("button", container).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.trim() === name
    );
  });
  if (!result) {
    throw new Error(`Missing button: ${name}`);
  }
  return result;
}

function detail(kind: PageKind): ArtifactDetail {
  const summary = {
    id: catalogId,
    title,
    thumbnail: null,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
  };
  if (kind === "shared-thread") {
    return { ...summary, kind, sharedThread: { id: sourceId } };
  }
  if (kind === "html") {
    return {
      ...summary,
      kind: "hosted-site",
      site: {
        id: "b0000000-0000-4000-a000-000000000910",
        slug: "launch",
        publicSlug: "launch",
        url: "https://launch.okou.app",
        deploymentVersion: 1,
        entrypoint: "index.html",
        spaFallback: false,
      },
    };
  }
  return {
    ...summary,
    kind: "file",
    file: {
      id: sourceId,
      filename,
      contentType: "image/png",
      size: 12,
      url,
      previewImageUrl: null,
    },
  };
}

function mockPage(kind: PageKind, snapshot = false) {
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(200, { id: sourceId, title, messages: [] });
  });
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    if (kind === "html") {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Artifact unavailable" },
      });
    }
    return respond(200, {
      url,
      downloadUrl: url,
      expiresAt: "2099-01-01T00:00:00Z",
      filename,
      contentType: "image/png",
      target: { kind: "file", id: sourceId },
      ...(snapshot ? { sharedThreadSnapshot: true } : {}),
    });
  });
  context.mocks.api(artifactReferencesContract.publicUrl, ({ respond }) => {
    return respond(200, {
      url,
      downloadUrl: url,
      preview: {
        filename,
        contentType: kind === "html" ? "text/html" : "image/png",
      },
    });
  });
  return kind === "shared-thread"
    ? `/share/threads/${sourceId}`
    : artifactReferencePath(sourceId, filename);
}

function mockOwner(kind: PageKind) {
  context.mocks.api(
    artifactReferencesContract.ownerArtifact,
    ({ params, respond }) => {
      expect(params.reference.split(".")[0]).toBe(sourceId.replaceAll("-", ""));
      return respond(200, { artifactId: catalogId });
    },
  );
  context.mocks.api(
    artifactCatalogContract.get,
    ({ params, query, respond }) => {
      expect(params.artifactId).toBe(
        kind === "shared-thread" ? sourceId : catalogId,
      );
      expect(query.sourceKind).toBe(
        kind === "shared-thread" ? kind : undefined,
      );
      return respond(200, detail(kind));
    },
  );
}

async function openDeletion() {
  await waitFor(() => {
    expect(button("Delete")).toBeInTheDocument();
  });
  const trigger = button("Delete");
  click(trigger);
  const dialog = await screen.findByRole("dialog", {
    name: `Delete ${title}?`,
  });
  return { dialog, trigger };
}

test.each([
  ["file", false],
  ["file", true],
  ["html", false],
  ["shared-thread", false],
] as const)(
  "the owner can cancel and delete a %s from its shared page (legacy=%s)",
  async (kind, legacy) => {
    const referencePath = mockPage(kind);
    const path = legacy ? `/share/artifacts/${sourceId}` : referencePath;
    mockOwner(kind);
    const finish = context.mocks.deferred<void>();
    context.mocks.api(
      artifactCatalogContract.delete,
      async ({ params, respond }) => {
        expect(params.artifactId).toBe(catalogId);
        await finish.promise;
        return respond(200, { deleted: true });
      },
    );
    await setupPage({
      context,
      path,
      host: "app.okou.ai",
      featureSwitches: { [FeatureSwitchKey.ArtifactDeletion]: true },
    });
    const { dialog: cancelled, trigger } = await openDeletion();
    click(button("Cancel", cancelled));
    await waitFor(() => {
      expect(cancelled).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    });
    expect(window.location.pathname).toBe(path);
    const { dialog } = await openDeletion();
    click(button("Delete", dialog));
    await waitFor(() => {
      expect(button("Deleting…", dialog)).toBeDisabled();
    });
    expect(button("Cancel", dialog)).toBeDisabled();
    finish.resolve();
    await expect(
      screen.findByText("No artifacts found"),
    ).resolves.toBeInTheDocument();
    expect(window.location.pathname).toBe("/artifacts");
  },
);

test("a failed deletion keeps the shared page and allows retry", async () => {
  const path = mockPage("file");
  mockOwner("file");
  let unavailable = true;
  context.mocks.api(artifactCatalogContract.delete, ({ respond }) => {
    if (unavailable) {
      unavailable = false;
      return respond(503, {
        error: { code: "NOT_CONFIGURED", message: "Could not delete artifact" },
      });
    }
    return respond(200, { deleted: true });
  });
  await setupPage({
    context,
    path,
    featureSwitches: { [FeatureSwitchKey.ArtifactDeletion]: true },
  });
  const { dialog } = await openDeletion();
  click(button("Delete", dialog));
  await expect(
    screen.findByText("Could not delete artifact"),
  ).resolves.toBeInTheDocument();
  expect(window.location.pathname).toBe(path);
  expect(dialog).toBeInTheDocument();
  expect(button("Delete", dialog)).toBeEnabled();
  click(button("Delete", dialog));
  await expect(
    screen.findByText("No artifacts found"),
  ).resolves.toBeInTheDocument();
  expect(window.location.pathname).toBe("/artifacts");
});

test.each(["file", "shared-thread"] as const)(
  "cancelling %s deletion after a token refresh restores the owner action's focus",
  async (kind) => {
    const path = mockPage(kind);
    mockOwner(kind);
    await setupPage({
      context,
      path,
      featureSwitches: { [FeatureSwitchKey.ArtifactDeletion]: true },
    });
    const { dialog } = await openDeletion();
    const finish = context.mocks.deferred<void>();
    context.mocks.api(artifactCatalogContract.get, async ({ respond }) => {
      await finish.promise;
      return respond(200, detail(kind));
    });
    await act(() => {
      emitMockedClerkEvent();
    });
    click(button("Cancel", dialog));
    await waitFor(() => {
      expect(dialog).not.toBeInTheDocument();
    });
    finish.resolve();
    await waitFor(() => {
      expect(button("Delete")).toHaveFocus();
    });
  },
);

test.each(["file", "shared-thread"] as const)(
  "a read-only recipient cannot delete a %s",
  async (kind) => {
    const path = mockPage(kind);
    context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Artifact not found" },
      });
    });
    await setupPage({
      context,
      path,
      featureSwitches: { [FeatureSwitchKey.ArtifactDeletion]: true },
    });
    expect(button("Share")).toBeInTheDocument();
    expect(screen.queryByLabelText("Delete")).not.toBeInTheDocument();
  },
);

test.each(["signed-out", "disabled", "snapshot"] as const)(
  "the %s artifact viewer does not offer deletion",
  async (scenario) => {
    const path = mockPage("file", scenario === "snapshot");
    await setupPage({
      context,
      path,
      ...(scenario === "signed-out" ? { auth: null } : {}),
      featureSwitches: {
        [FeatureSwitchKey.ArtifactDeletion]: scenario !== "disabled",
      },
    });
    await expect(
      screen.findByTestId("attachment-lightbox-image"),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByLabelText("Delete")).not.toBeInTheDocument();
  },
);
