import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { artifactSharesContract } from "@okouai/api-contracts/contracts/artifact-shares";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  ATTACHMENT_THREAD_ID,
  findNamedLink,
  findNamedButton,
  mockAttachmentChat,
} from "../../okou-page/__tests__/chat-attachment-test-helpers.ts";

const context = testContext();
const FILE_ID = "f0000000-0000-4000-a000-000000000941";
const IMAGE_PATH = "/artifacts/snapimage1.png";
const IMAGE_REF = `https://app.okou.ai${IMAGE_PATH}`;
const R2_ORIGIN = `https://${"a".repeat(32)}.r2.cloudflarestorage.com`;
const IMAGE_URL = `${R2_ORIGIN}/snapshots/photo.png?X-Amz-Signature=preview`;
const DOWNLOAD_URL = `${R2_ORIGIN}/snapshots/photo.png?X-Amz-Signature=download`;
const EXPIRES_AT = "2099-01-01T00:00:00Z";

function action(role: "button" | "menuitem", name: string) {
  const element = queryAllByRoleFast(role).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.trim() === name
    );
  });
  if (!element) {
    throw new Error(`Missing ${role}: ${name}`);
  }
  return element;
}

test.each([false, true])(
  "a snapshot viewer copies its full reference and downloads newly authorized bytes (signed in: %s)",
  async (signedIn) => {
    const clipboard = context.mocks.browser.clipboardWriteText();
    const browser = context.mocks.browser.blobDownload();
    const replace = context.mocks.browser.locationReplace();
    let download = false;
    context.mocks.api(artifactReferencesContract.publicUrl, ({ respond }) => {
      return respond(200, {
        url: IMAGE_URL,
        expiresAt: EXPIRES_AT,
        sharedThreadSnapshot: true,
        preview: { filename: "photo.png", contentType: "image/png" },
      });
    });
    context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
      return respond(200, {
        url: download ? DOWNLOAD_URL : IMAGE_URL,
        expiresAt: EXPIRES_AT,
        sharedThreadSnapshot: true,
        filename: "photo.png",
        contentType: "image/png",
        target: { kind: "file", id: FILE_ID },
      });
    });
    context.mocks.http.get(
      `${R2_ORIGIN}/snapshots/photo.png`,
      ({ request }) => {
        return new URL(request.url).searchParams.get("X-Amz-Signature") ===
          "download"
          ? HttpResponse.text("snapshot image bytes", {
              headers: { "Content-Type": "image/png" },
            })
          : new HttpResponse(null, { status: 403 });
      },
    );
    await setupPage({
      context,
      path: `${IMAGE_PATH}#detail`,
      host: "app.okou.ai",
      ...(!signedIn ? { auth: null } : {}),
      // Shared snapshots remain viewable for recipients outside the owner's rollout.
      featureSwitches: { [FeatureSwitchKey.PrivateArtifacts]: false },
    });

    await expect(
      screen.findByTestId("attachment-lightbox-image"),
    ).resolves.toHaveAttribute("src", `${IMAGE_URL}#detail`);
    expect(
      screen.getByRole("heading", { name: "photo.png" }),
    ).toBeInTheDocument();
    expect(replace.calls).toStrictEqual([]);
    click(action("button", "Share"));
    await expect(screen.findByText("Link copied")).resolves.toBeInTheDocument();
    expect(clipboard.writes).toStrictEqual([`${IMAGE_REF}#detail`]);
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();

    download = true;
    click(action("button", "Download options"));
    await waitFor(() => {
      expect(action("menuitem", "Download")).toBeInTheDocument();
    });
    click(action("menuitem", "Download"));
    await waitFor(() => {
      expect(browser.downloads).toHaveLength(1);
    });
    expect(browser.downloads[0]?.filename).toBe("photo.png");
    await expect(browser.downloads[0]?.blob?.text()).resolves.toBe(
      "snapshot image bytes",
    );
    expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
      "src",
      `${IMAGE_URL}#detail`,
    );
  },
);

test("an anonymous HTML snapshot keeps its temporary credential and slide fragment inside the viewer", async () => {
  const url = `https://ps-${"a".repeat(48)}.okou.app/`;
  context.mocks.api(artifactReferencesContract.publicUrl, ({ respond }) => {
    return respond(200, {
      url,
      expiresAt: EXPIRES_AT,
      sharedThreadSnapshot: true,
      preview: { filename: "index.html", contentType: "text/html" },
    });
  });
  await setupPage({
    context,
    path: "/artifacts/snaphtml01.html#slide-2",
    host: "app.okou.ai",
    auth: null,
    featureSwitches: { [FeatureSwitchKey.PrivateArtifacts]: false },
  });

  const frame = await screen.findByTitle("index.html preview");
  expect(frame).toHaveAttribute("src", `${url}#slide-2`);
  expect(frame).toHaveAttribute("referrerpolicy", "origin");
  expect(frame).toHaveAttribute("sandbox", "allow-same-origin allow-scripts");
});

test("a snapshot pasted into an ordinary thread cannot expose source permissions even to its owner", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  mockAttachmentChat(context, {
    chatEvents: [
      {
        id: "snapshot-message",
        role: "assistant",
        content: `[Snapshot](${IMAGE_REF})`,
        runId: "snapshot-run",
        runEventId: "snapshot-output",
        sequenceNumber: 1,
        createdAt: "2026-09-18T00:00:00Z",
      },
    ],
  });
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    return respond(200, {
      url: IMAGE_URL,
      expiresAt: EXPIRES_AT,
      sharedThreadSnapshot: true,
      filename: "photo.png",
      contentType: "image/png",
      target: { kind: "file", id: FILE_ID },
    });
  });
  context.mocks.api(artifactSharesContract.status, ({ respond }) => {
    return respond(200, {
      ownerUrl: "https://app.okou.ai/artifacts/ownerfile1.png",
      shareId: null,
      audience: "private",
      organization: { id: "org_test", name: "Acme" },
      selectedTarget: null,
      selectedVersion: null,
      candidateVersion: 1,
      url: null,
    });
  });
  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.PrivateArtifacts]: true },
  });

  const link = await findNamedLink("Snapshot");
  click(link);
  await expect(
    screen.findByTestId("attachment-lightbox-image"),
  ).resolves.toHaveAttribute("src", IMAGE_URL);
  const share = await findNamedButton("Share");
  click(share);
  await expect(screen.findByText("Link copied")).resolves.toBeInTheDocument();
  expect(clipboard.writes).toStrictEqual([IMAGE_REF]);
  expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
});
