import { chatThreadArtifactsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { artifact } from "../../artifacts-page/__tests__/artifact-catalog-test-helpers.ts";
import { imageArtifactDetail } from "./chat-navigation-artifact-test-helpers.ts";
import {
  ATTACHMENT_RUN_ID,
  artifactFile,
  findNamedButton,
  findNamedLink,
  findNamedMenuItem,
  getNamedButton,
  queryNamedButton,
} from "./chat-attachment-test-helpers.ts";
import { openMessageFile } from "./chat-artifact-preview-test-helpers.ts";

const context = testContext();

test("chat-artifact-deletion-001 returns focus after Cancel and removes the owner's delete action after confirmation", async () => {
  const summary = artifact({ kind: "image", title: "Cove survey" });
  const file = artifactFile("shore.png", {
    artifactId: summary.id,
    title: summary.title,
    contentType: "image/png",
  });
  const legend = artifactFile("legend.png", {
    contentType: "image/png",
    title: "Survey legend",
  });
  const inventory = context.mocks.deferred<void>();
  let owned = true;
  context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
    return owned
      ? respond(
          200,
          imageArtifactDetail(summary, {
            filename: file.filename,
            fileId: summary.id,
            url: file.url,
          }),
        )
      : respond(404, {
          error: { code: "NOT_FOUND", message: "Artifact removed" },
        });
  });
  context.mocks.api(artifactCatalogContract.delete, ({ params, respond }) => {
    if (params.artifactId !== summary.id) {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Unknown artifact" },
      });
    }
    owned = false;
    return respond(200, { deleted: true });
  });
  const viewer = await openMessageFile(context, file, {
    relatedFiles: [legend],
  });
  context.mocks.api(chatThreadArtifactsContract.list, async ({ respond }) => {
    if (!owned) {
      await inventory.promise;
    }
    return respond(200, {
      runs: [
        { runId: ATTACHMENT_RUN_ID, files: owned ? [file, legend] : [legend] },
      ],
    });
  });
  const more = await findNamedButton("More artifact actions", viewer);
  click(more);
  click(await findNamedMenuItem("Delete"));
  const prompt = { name: "Delete Cove survey?" };
  click(getNamedButton("Cancel", await screen.findByRole("dialog", prompt)));
  await waitFor(() => {
    return expect(more).toHaveFocus();
  });
  expect(within(viewer).getByAltText(file.filename)).toHaveAttribute(
    "src",
    file.url,
  );
  click(more);
  click(await findNamedMenuItem("Delete"));
  click(getNamedButton("Delete", await screen.findByRole("dialog", prompt)));
  await expect(
    screen.findByText("Artifact deleted"),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  // The legend's catalog title is supplied by the same refreshed inventory.
  click(await findNamedLink(legend.filename));
  const legendPreview = await screen.findByTestId("artifact-sidebar");
  await within(legendPreview).findByText("legend.png");
  inventory.resolve();
  await within(legendPreview).findByText("Survey legend");
  click(getNamedButton("Close artifact", legendPreview));
  click(await findNamedLink("Inspect attachment"));
  const reopened = await screen.findByTestId("artifact-sidebar");
  await expect(
    within(reopened).findByAltText(file.filename),
  ).resolves.toHaveAttribute("src", file.url);
  await waitFor(() => {
    return expect(within(reopened).getByAltText(file.filename)).toBeVisible();
  });
  await within(reopened).findByText("shore.png");
  await expect(
    findNamedButton("Download artifact", reopened),
  ).resolves.toBeVisible();
  expect(queryNamedButton("More artifact actions", reopened)).toBeNull();
});

test("chat-artifact-deletion-004 shares a read-only attachment and offers its download", async () => {
  const file = artifactFile("visitor-map.png", {
    artifactId: "20000000-0000-4000-8000-000000000026",
    title: "Visitor map",
    contentType: "image/png",
  });
  const decision = context.mocks.deferred<void>();
  context.mocks.api(artifactCatalogContract.get, async ({ respond }) => {
    await decision.promise;
    return respond(403, {
      error: { code: "FORBIDDEN", message: "Read-only attachment" },
    });
  });
  const clipboard = context.mocks.browser.clipboardWriteText();
  const viewer = await openMessageFile(context, file);
  const share = within(viewer).getByLabelText("Share artifact");
  expect(share).not.toBeVisible();
  decision.resolve();
  await waitFor(() => {
    return expect(share).toBeVisible();
  });
  click(share);
  await waitFor(() => {
    return expect(clipboard.writes).toContain(file.url);
  });
  click(getNamedButton("Download artifact", viewer));
  await expect(findNamedMenuItem("Download")).resolves.toBeEnabled();
  expect(queryNamedButton("More artifact actions", viewer)).toBeNull();
  expect(queryNamedButton("Delete", viewer)).toBeNull();
});
