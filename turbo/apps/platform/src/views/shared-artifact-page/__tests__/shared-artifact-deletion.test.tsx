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
import { act, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { emitMockedClerkEvent } from "../../../__tests__/mock-auth.ts";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const sourceId = "f0000000-0000-4000-a000-000000000910";
const catalogId = "a0000000-0000-4000-a000-000000000910";
const filename = "launch.png";
const title = "Launch plan";
const fileUrl = "https://files.example.test/launch.png";
type PageKind = "file" | "shared-thread";

function findButton(name: string, container: ParentNode = document.body) {
  return queryAllByRoleFast("button", container).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.trim() === name
    );
  });
}

function button(name: string, container: ParentNode = document.body) {
  const match = findButton(name, container);
  if (!match) {
    throw new Error(`Missing button: ${name}`);
  }
  return match;
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
    return {
      ...summary,
      kind,
      sharedThreadId: sourceId,
      sharedThread: { id: sourceId },
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
      url: fileUrl,
      previewImageUrl: null,
    },
  };
}

function mockSharedPage(kind: PageKind) {
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(200, { id: sourceId, title, messages: [] });
  });
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    return respond(200, {
      url: fileUrl,
      downloadUrl: fileUrl,
      expiresAt: "2099-01-01T00:00:00Z",
      filename,
      contentType: "image/png",
      target: { kind: "file", id: sourceId },
    });
  });
  context.mocks.api(artifactReferencesContract.publicUrl, ({ respond }) => {
    return respond(200, {
      url: fileUrl,
      downloadUrl: fileUrl,
      preview: { filename, contentType: "image/png" },
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
  context.mocks.api(artifactCatalogContract.get, ({ params, respond }) => {
    expect(params.artifactId).toBe(
      kind === "shared-thread" ? sourceId : catalogId,
    );
    return respond(200, detail(kind));
  });
}

async function openOwnerPage(kind: PageKind) {
  const path = mockSharedPage(kind);
  mockOwner(kind);
  await setupPage({ context, path, host: "app.okou.ai" });
  return path;
}

async function openDeletion() {
  await waitFor(() => {
    expect(button("Delete")).toBeEnabled();
  });
  const trigger = button("Delete");
  click(trigger);
  const dialog = await screen.findByRole("dialog", {
    name: `Delete ${title}?`,
  });
  return { dialog, trigger };
}

async function cancelThenReopenDeletion(kind: PageKind) {
  const finish = context.mocks.deferred<void>();
  context.mocks.api(
    artifactCatalogContract.delete,
    async ({ params, respond }) => {
      expect(params.artifactId).toBe(catalogId);
      await finish.promise;
      return respond(200, { deleted: true });
    },
  );
  const path = await openOwnerPage(kind);
  const { dialog: cancelled, trigger } = await openDeletion();
  click(button("Cancel", cancelled));
  await waitFor(() => {
    expect(cancelled).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
  expect(window.location.pathname).toBe(path);

  const { dialog } = await openDeletion();
  return {
    dialog,
    async confirm() {
      click(button("Delete", dialog));
      await waitFor(() => {
        expect(button("Deleting…", dialog)).toBeDisabled();
      });
      expect(button("Cancel", dialog)).toBeDisabled();
      finish.resolve();
    },
  };
}

test("The owner can cancel and then delete a shared file", async () => {
  const deletion = await cancelThenReopenDeletion("file");
  await deletion.confirm();

  await expect(
    screen.findByText("No artifacts found"),
  ).resolves.toBeInTheDocument();
  expect(window.location.pathname).toBe("/artifacts");
});

test("The owner can cancel and then delete a shared conversation whose link stops working", async () => {
  const deletion = await cancelThenReopenDeletion("shared-thread");
  expect(deletion.dialog).toHaveTextContent(
    "Its shared link will stop working.",
  );
  await deletion.confirm();

  await expect(
    screen.findByText("No artifacts found"),
  ).resolves.toBeInTheDocument();
  expect(window.location.pathname).toBe("/artifacts");
});

test("A failed shared file deletion stays open for a successful retry", async () => {
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
  const path = await openOwnerPage("file");
  const { dialog } = await openDeletion();

  click(button("Delete", dialog));
  await expect(
    screen.findByText("Could not delete artifact"),
  ).resolves.toBeInTheDocument();
  expect(dialog).toBeInTheDocument();
  expect(button("Delete", dialog)).toBeEnabled();
  expect(window.location.pathname).toBe(path);

  click(button("Delete", dialog));
  await expect(
    screen.findByText("No artifacts found"),
  ).resolves.toBeInTheDocument();
  expect(window.location.pathname).toBe("/artifacts");
});

test.each(["file", "shared-thread"] as const)(
  "Cancelling %s deletion during a token refresh returns focus to Delete",
  async (kind) => {
    await openOwnerPage(kind);
    const { dialog } = await openDeletion();
    const refresh = context.mocks.deferred<void>();
    context.mocks.api(artifactCatalogContract.get, async ({ respond }) => {
      await refresh.promise;
      return respond(200, detail(kind));
    });

    await act(() => {
      emitMockedClerkEvent();
    });
    click(button("Cancel", dialog));
    await waitFor(() => {
      expect(dialog).not.toBeInTheDocument();
    });

    refresh.resolve();
    await waitFor(() => {
      expect(button("Delete")).toHaveFocus();
    });
  },
);

test("A read-only recipient can share a file but not delete it", async () => {
  const path = mockSharedPage("file");
  let ownershipDenied = false;
  context.mocks.api(artifactReferencesContract.ownerArtifact, ({ respond }) => {
    ownershipDenied = true;
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Artifact unavailable" },
    });
  });
  await setupPage({ context, path, host: "app.okou.ai" });

  await waitFor(() => {
    expect(ownershipDenied).toBeTruthy();
    expect(button("Share")).toBeEnabled();
  });
  expect(findButton("Delete")).toBeUndefined();
});
