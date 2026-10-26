import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { screen, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  buttonNamed,
  mockArtifactConversation,
  NAVIGATION_ARTIFACT_THREAD_ID,
} from "./chat-navigation-artifact-test-helpers.ts";

const context = testContext();
const FILE_URL = "https://files.example.test/json-preview.json";

async function openAttachment(options: {
  readonly source: string;
  readonly sidebar?: boolean;
  readonly response?: ResponseInit;
}) {
  context.mocks.api(webFilesContract.fileUrl, ({ respond }) => {
    return respond(200, {
      downloadUrl: new URL("?download=1", FILE_URL).href,
      url: FILE_URL,
      publicUrl: null,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
  });
  context.mocks.http.get(FILE_URL, () => {
    return HttpResponse.text(options.source, options.response);
  });
  mockArtifactConversation(context, {
    catalog: [],
    chatEvents: [
      {
        id: "json-user-message",
        createdAt: "2026-09-01T12:00:00.000Z",
        role: "user",
        content: "Review this JSON",
        fileParts: [
          {
            type: "file",
            fileId: "json-upload-file",
            filenameSnapshot: "review.json",
            contentType: "application/json",
          },
        ],
        runId: "json-upload-run",
        seqId: 1,
      },
      {
        id: "json-completed",
        createdAt: "2026-09-01T12:00:01.000Z",
        role: "assistant",
        content: null,
        runId: "json-upload-run",
        runLifecycleEvent: "completed",
        seqId: 2,
      },
    ],
  });
  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    host: "app.okou.ai",
    featureSwitches: {
      [FeatureSwitchKey.ArtifactSidebarPreview]: options.sidebar ?? true,
    },
  });
  click(await screen.findByLabelText("Open json preview for review.json"));
  return screen.findByTestId(
    options.sidebar === false ? "attachment-lightbox" : "artifact-sidebar",
  );
}

test.each([true, false])(
  "A private chat JSON attachment uses the tree with sidebar=%s",
  async (sidebar) => {
    const source = '{"items":[{"id":9223372036854775807}],"empty":{}}';
    const preview = await openAttachment({ source, sidebar });
    const tree = await within(preview).findByTestId("json-preview");
    click(buttonNamed('Expand "items"', tree));
    click(buttonNamed("Expand [0]", tree));
    expect(within(tree).getByText("9223372036854775807")).toBeInTheDocument();
    expect(within(tree).getByText("{}")).toBeInTheDocument();
    click(buttonNamed("Source", tree));
    expect(tree.querySelector("pre")?.textContent).toBe(source);
  },
);

test("A ranged attachment cannot present a complete-looking JSON prefix as a full tree", async () => {
  const source = '{"looks":"complete"}';
  const preview = await openAttachment({
    source,
    response: {
      status: 206,
      headers: {
        "Content-Range": `bytes 0-${String(source.length - 1)}/100000`,
      },
    },
  });
  const tree = await within(preview).findByTestId("json-preview");
  expect(buttonNamed("Tree", tree)).toBeDisabled();
  expect(within(tree).getByRole("status")).toHaveTextContent(
    "Only part of this file is loaded",
  );
  expect(tree.querySelector("pre")?.textContent).toBe(source);
});
