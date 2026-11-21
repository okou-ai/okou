import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import {
  artifactCatalogContract,
  type ArtifactDetail,
} from "@okouai/api-contracts/contracts/artifact-catalog";
import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { mockClerkSessionTransitioning } from "../../../__tests__/mock-auth.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  artifact,
  getButtonByName,
  queryButtonByName,
} from "../../artifacts-page/__tests__/artifact-catalog-test-helpers.ts";
import { fileArtifactDetail } from "../../okou-page/__tests__/chat-navigation-artifact-test-helpers.ts";
import { findNamedButton } from "../../okou-page/__tests__/chat-attachment-test-helpers.ts";
import {
  sharedThread,
  SHARED_THREAD_ID,
} from "../../shared-thread-page/__tests__/shared-thread-test-helpers.ts";

const context = testContext();
const catalogId = "30000000-0000-4000-9000-000000000023";
const fileId = "40000000-0000-4000-9000-000000000023";
const filePath = "/artifacts/survey0023.png";
const threadPath = `/share/threads/${SHARED_THREAD_ID}`;
const title = "Coastal survey";
function missing() {
  return { error: { code: "NOT_FOUND", message: "Resource unavailable" } };
}
function serveImage() {
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    return respond(200, {
      url: "https://media.example.test/survey.png",
      downloadUrl: "https://media.example.test/survey.download",
      filename: title + ".png",
      contentType: "image/png",
      expiresAt: "2099-01-01T00:00:00Z",
      target: { kind: "file", id: fileId },
    });
  });
}
function serveOwnedArtifact(kind: "file" | "thread") {
  const summary = artifact({ title, id: catalogId });
  let detail: ArtifactDetail;
  if (kind === "file") {
    serveImage();
    context.mocks.api(
      artifactReferencesContract.ownerArtifact,
      ({ params, respond }) => {
        return params.reference === "survey0023.png"
          ? respond(200, { artifactId: catalogId })
          : respond(404, missing());
      },
    );
    detail = fileArtifactDetail(summary, {
      fileId,
      filename: title + ".png",
      contentType: "image/png",
      url: "https://media.example.test/survey.png",
    });
  } else {
    context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
      return respond(200, sharedThread({ title }));
    });
    detail = {
      ...summary,
      kind: "shared-thread",
      sharedThreadId: SHARED_THREAD_ID,
      sharedThread: { id: SHARED_THREAD_ID },
    };
  }
  context.mocks.api(
    artifactCatalogContract.get,
    ({ params, query, respond }) => {
      const matches =
        kind === "file"
          ? params.artifactId === catalogId
          : params.artifactId === SHARED_THREAD_ID &&
            query.sourceKind === "shared-thread";
      return matches ? respond(200, detail) : respond(404, missing());
    },
  );
  const catalog = { deleted: false };
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, {
      artifacts: catalog.deleted ? [] : [detail],
      nextCursor: null,
    });
  });
  return catalog;
}
function openConfirmation() {
  return screen.findByRole("dialog", { name: `Delete ${title}?` });
}

const pages = [
  { kind: "file", id: "001", refresh: "006", path: filePath },
  { kind: "thread", id: "004", refresh: "007", path: threadPath },
] as const;

test.each(pages)(
  "shared-artifact-deletion-$id cancels then removes the owned $kind",
  async ({ kind, path }) => {
    const catalog = serveOwnedArtifact(kind);
    const finish = context.mocks.deferred<void>();
    context.mocks.api(
      artifactCatalogContract.delete,
      async ({ params, respond }) => {
        if (params.artifactId !== catalogId) {
          return respond(404, missing());
        }
        await finish.promise;
        catalog.deleted = true;
        return respond(200, { deleted: true });
      },
    );
    await setupPage({ context, path });
    const trigger = await findNamedButton("Delete");
    click(trigger);
    const first = await openConfirmation();
    expect(first).toHaveTextContent(
      kind === "thread"
        ? "Its shared link will stop working."
        : "This removes the artifact and disables its Okou links.",
    );
    click(getButtonByName("Cancel", first));
    await waitFor(() => {
      expect(trigger).toHaveFocus();
    });
    expect(first).not.toBeInTheDocument();
    expect(location.pathname).toBe(path);
    click(trigger);
    const second = await openConfirmation();
    click(getButtonByName("Delete", second));
    await waitFor(() => {
      expect(getButtonByName("Deleting…", second)).toBeDisabled();
    });
    expect(getButtonByName("Cancel", second)).toBeDisabled();
    finish.resolve();
    await expect(
      screen.findByText("No artifacts found"),
    ).resolves.toBeInTheDocument();
    expect(location.pathname).toBe("/artifacts");
  },
);

test("shared-artifact-deletion-005 retries an unavailable deletion from its open confirmation", async () => {
  const catalog = serveOwnedArtifact("file");
  let available = false;
  context.mocks.api(artifactCatalogContract.delete, ({ params, respond }) => {
    if (!available) {
      return respond(503, {
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "Could not delete artifact",
        },
      });
    }
    if (params.artifactId !== catalogId) {
      return respond(404, missing());
    }
    catalog.deleted = true;
    return respond(200, { deleted: true });
  });
  await setupPage({ context, path: filePath });
  click(await findNamedButton("Delete"));
  const dialog = await openConfirmation();
  click(getButtonByName("Delete", dialog));
  await expect(
    screen.findByText("Could not delete artifact"),
  ).resolves.toBeInTheDocument();
  const retry = getButtonByName("Delete", dialog);
  expect(retry).toBeEnabled();
  expect(location.pathname).toBe(filePath);
  available = true;
  click(retry);
  await expect(
    screen.findByText("No artifacts found"),
  ).resolves.toBeInTheDocument();
  expect(location.pathname).toBe("/artifacts");
});

test.each(pages)(
  "shared-artifact-deletion-$refresh restores keyboard deletion after the same $kind owner renews their session token",
  async ({ kind, path }) => {
    const catalog = serveOwnedArtifact(kind);
    context.mocks.api(
      artifactCatalogContract.delete,
      ({ request, params, respond }) => {
        if (
          params.artifactId !== catalogId ||
          request.headers.get("authorization") !== "Bearer renewed"
        ) {
          return respond(403, missing());
        }
        catalog.deleted = true;
        return respond(200, { deleted: true });
      },
    );
    const user = { id: "coast-owner", fullName: "Survey owner" };
    const sessionId = "survey-session";
    await setupPage({
      context,
      path,
      auth: { user, session: { id: sessionId, token: "original" } },
    });
    click(await findNamedButton("Delete"));
    const dialog = await openConfirmation();
    act(() => {
      mockClerkSessionTransitioning(true);
    });
    click(getButtonByName("Cancel", dialog));
    await waitFor(() => {
      expect(dialog).not.toBeInTheDocument();
    });
    act(() => {
      context.mocks.clerk().user(user, { id: sessionId, token: "renewed" });
      mockClerkSessionTransitioning(false);
    });
    await waitFor(() => {
      expect(getButtonByName("Delete")).toHaveFocus();
    });
    await userEvent.keyboard("{Enter}");
    const reopened = await openConfirmation();
    click(getButtonByName("Delete", reopened));
    await expect(
      screen.findByText("No artifacts found"),
    ).resolves.toBeInTheDocument();
  },
);

test("shared-artifact-deletion-008 withdraws Delete when an owner becomes a read-only recipient", async () => {
  serveOwnedArtifact("file");
  const denied = context.mocks.deferred<void>();
  const pending = context.mocks.deferred<void>();
  context.mocks.api(
    artifactReferencesContract.ownerArtifact,
    async ({ request, respond }) => {
      if (request.headers.get("authorization") === "Bearer recipient") {
        if (!pending.settled()) {
          pending.resolve();
        }
        await denied.promise;
        return respond(404, missing());
      }
      return respond(200, { artifactId: catalogId });
    },
  );
  await setupPage({ context, path: filePath });
  await expect(findNamedButton("Delete")).resolves.toBeEnabled();
  const clerk = context.mocks.clerk();
  act(() => {
    clerk.user(
      { id: "reader", fullName: "Reader" },
      { id: "reader-session", token: "recipient" },
    );
    clerk.stateChanged();
  });
  await pending.promise;
  denied.resolve();
  await waitFor(() => {
    expect(queryButtonByName("Delete")).toBeUndefined();
  });
  await expect(findNamedButton("Share")).resolves.toBeEnabled();
});
