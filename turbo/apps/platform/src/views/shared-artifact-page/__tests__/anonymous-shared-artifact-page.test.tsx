import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const path = "/artifacts/abcdef1234.png?source=chat#detail";
const shareUrl = `https://app.okou.ai${path}`;

function control(role: "button" | "menuitem", name: string) {
  const candidate = queryAllByRoleFast(role, document.body).find((item) => {
    return (
      item.getAttribute("aria-label") === name ||
      item.textContent?.trim() === name
    );
  });
  if (!candidate) {
    throw new Error(`Missing ${role} named ${name}`);
  }
  return candidate;
}

async function openSharedArtifact() {
  await setupPage({ context, auth: null, host: "app.okou.ai", path });
}

test("A signed-out reader can preview, share and download a public image", async () => {
  const previewUrl = "https://files.example.test/launch-map.png";
  const downloadUrl = "https://files.example.test/download/launch-map.png";
  const clipboard = context.mocks.browser.clipboardWriteText();
  const browser = context.mocks.browser.blobDownload();
  context.mocks.api(
    artifactReferencesContract.publicUrl,
    ({ params, respond }) => {
      expect(params.reference).toBe("abcdef1234.png");
      return respond(200, {
        url: previewUrl,
        downloadUrl,
        preview: { filename: "launch-map.png", contentType: "image/png" },
      });
    },
  );

  await openSharedArtifact();

  const image = await screen.findByRole("img", { name: "launch-map.png" });
  expect(image).toHaveAttribute("src", `${previewUrl}#detail`);
  expect(
    screen.getByRole("heading", { name: "launch-map.png" }),
  ).toBeInTheDocument();
  expect(document.title).toBe("launch-map.png | Okou");
  expect(window.location.href).toBe(shareUrl);
  expect(screen.queryByTestId("clerk-sign-in")).not.toBeInTheDocument();

  click(control("button", "Share"));
  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual([shareUrl]);
  });

  click(control("button", "Download options"));
  await waitFor(() => {
    expect(control("menuitem", "Download")).toBeEnabled();
  });
  click(control("menuitem", "Download"));
  await waitFor(() => {
    expect(browser.downloads).toMatchObject([
      { filename: "launch-map.png", url: downloadUrl },
    ]);
  });
  expect(window.location.href).toBe(shareUrl);
});

test("An unavailable artifact stays on its page until the reader chooses to sign in", async () => {
  const navigation = context.mocks.browser.locationAssign();
  context.mocks.api(artifactReferencesContract.publicUrl, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Artifact not found" },
    });
  });

  await openSharedArtifact();

  await expect(
    screen.findByRole("heading", { name: "You can’t view this artifact" }),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: "Artifacts" }),
  ).toBeInTheDocument();
  const access = screen.getByRole("main");
  expect(access).toHaveTextContent("It may be private or no longer available.");
  expect(access).not.toHaveTextContent("shared with a different account");
  expect(
    screen.queryByTestId("attachment-lightbox-image"),
  ).not.toBeInTheDocument();
  expect(access.querySelector("iframe")).toBeNull();
  expect(screen.queryByTestId("clerk-sign-in")).not.toBeInTheDocument();
  expect(window.location.href).toBe(shareUrl);
  expect(navigation.calls).toHaveLength(0);

  click(control("button", "Sign in"));
  await waitFor(() => {
    expect(navigation.calls).toHaveLength(1);
  });
  const destination = new URL(navigation.calls[0] ?? "", window.location.href);
  expect(destination.pathname).toBe("/sign-in");
  expect(
    new URLSearchParams(destination.hash.slice(3)).get("redirect_url"),
  ).toBe(shareUrl);
});
