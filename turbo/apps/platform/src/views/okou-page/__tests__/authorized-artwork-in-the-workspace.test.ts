import { screen, waitFor, within } from "@testing-library/react";
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
test("thread-resource-thumbnails-002 Workspace search shows the matching private image thumbnail only after its 64-pixel preview is authorized", async () => {
  const { asked, reply } = privateArtwork();
  try {
    await open();
    click(await findFastControl("button", "Search workspace"));
    const search = await screen.findByRole("dialog");
    const field = await within(search).findByRole("combobox");
    await fill(field, "Private");
    const label = await within(search).findByText(title);
    const row = label.closest('[role="option"],button,a')! as HTMLElement;
    await asked.promise;
    expect(row).toBeVisible();
    expect(row.querySelector("img")).toBeNull();
    reply.resolve();
    await waitFor(() => {
      return thumbnail(row, 64);
    });
  } finally {
    if (!reply.settled()) {
      reply.resolve();
    }
  }
});
