import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { test, expect } from "vitest";
import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import {
  artifactSummary,
  imageArtifactDetail,
  artifactRun,
  mockArtifactConversation,
  NAVIGATION_ARTIFACT_THREAD_ID,
} from "./chat-navigation-artifact-test-helpers.ts";
const context = testContext();
const title = "Private courtyard",
  filename = "Private courtyard.png",
  fileId = "fafecafe-0123-4000-a000-002233445599",
  artifactId = "edbb2135-582d-4ec1-900e-228134211234",
  reference = "b3c8p9t7xu.png";
const locationUrl = "https://app.okou.ai/artifacts/" + reference,
  authorized =
    "https://artwork.r2.cloudflarestorage.com/private/courtyard.png?X-Amz-Signature=local-fixture";
function privateArtwork() {
  const reply = context.mocks.deferred<void>(),
    asked = context.mocks.deferred<void>();
  const summary = {
    ...artifactSummary(artifactId, "image", title),
    thumbnail: { url: locationUrl },
  };
  const detail = imageArtifactDetail(summary, {
    fileId,
    filename,
    url: locationUrl,
  });
  mockArtifactConversation(context, {
    catalog: [summary],
    details: new Map([[artifactId, detail]]),
    artifactRuns: () => {
      return [
        artifactRun({
          fileId,
          artifactId,
          filename,
          contentType: "image/png",
          url: locationUrl,
        }),
      ];
    },
  });
  context.mocks.api(
    artifactReferencesContract.resolve,
    async ({ params, respond }) => {
      if (params.reference !== reference) {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "Unknown artwork" },
        });
      }
      if (!asked.settled()) {
        asked.resolve();
      }
      await reply.promise;
      return respond(200, {
        url: authorized,
        downloadUrl: authorized,
        downloadAllowed: true,
        expiresAt: "2099-01-01T00:00:00Z",
        filename,
        contentType: "image/png",
        target: { kind: "file", id: fileId },
      });
    },
  );
  return { asked, reply };
}
async function open() {
  await setupPage({
    context,
    host: "app.okou.ai",
    path: "/chats/" + NAVIGATION_ARTIFACT_THREAD_ID,
  });
}
function thumbnail(row: HTMLElement, width: number) {
  const image = row.querySelector("img");
  expect(image).toBeInTheDocument();
  expect(image?.src).toContain("/cdn-cgi/image/");
  expect(
    image?.src.split("/cdn-cgi/image/")[1]?.split("/")[0]?.split(","),
  ).toContain("width=" + width);
  expect(image?.src).toContain("/" + authorized);
}
test("Private courtyard is available from the chat's artifacts after an empty workspace search for its title", async () => {
  const grant = privateArtwork();
  grant.reply.resolve();
  await open();
  click(await findFastControl("button", "Search workspace"));
  const dialog = await screen.findByRole("dialog");
  const box = within(dialog).getByRole("combobox");
  await fill(box, title);
  await expect(
    within(dialog).findByText("No results found"),
  ).resolves.toBeVisible();
  expect(within(dialog).queryByRole("option")).toBeNull();
  fireEvent.keyDown(box, { key: "Escape" });
  click(await findFastControl("button", "Artifacts and chats"));
  const catalog = await screen.findByRole("dialog", {
    name: "Artifacts and chats",
  });
  await expect(within(catalog).findByText(title)).resolves.toBeVisible();
});

test("thread-resource-thumbnails-001 The private image from the conversation’s resource list opens with its authorized source", async () => {
  const grant = privateArtwork();
  await open();
  click(await findFastControl("button", "Artifacts and chats"));
  const panel = await screen.findByRole("dialog", {
    name: "Artifacts and chats",
  });
  const resource = await within(panel).findByText(title);
  expect(resource.closest("button")?.querySelector("img")).toBeNull();
  click(resource);
  await grant.asked.promise;
  const preview = await screen.findByTestId("artifact-sidebar");
  click(await findFastControl("button", "Back to all artifacts", preview));
  const returned = await screen.findByTestId("thread-sidebar-artifacts");
  const entry = (await within(returned).findByText(title)).closest("button")!;
  expect(entry).toBeVisible();
  expect(
    entry.querySelector('[data-testid="artifact-catalog-thumbnail"]'),
  ).toBeNull();
  grant.reply.resolve();
  await waitFor(() => {
    return thumbnail(entry, 640);
  });
  click(entry);
  const original = await screen.findByTestId("artifact-sidebar");
  await waitFor(() => {
    expect(
      Array.from(original.querySelectorAll("img")).map((img) => {
        return img.src;
      }),
    ).toContain(authorized);
  });
});
