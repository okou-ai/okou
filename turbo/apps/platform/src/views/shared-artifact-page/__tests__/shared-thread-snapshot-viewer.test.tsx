import { artifactDownloadsContract } from "@okouai/api-contracts/contracts/artifact-downloads";
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
const origin = "https://app.okou.ai";

function getControl(role: "button" | "menuitem", name: string) {
  const control = queryAllByRoleFast(role).find((item) => {
    return (
      item.getAttribute("aria-label") === name ||
      item.textContent?.trim() === name
    );
  });
  if (!control) {
    throw new Error(`Missing ${role} named ${name}`);
  }
  return control;
}

async function downloadFromViewer() {
  click(getControl("button", "Download options"));
  await waitFor(() => {
    expect(getControl("menuitem", "Download")).toBeEnabled();
  });
  click(getControl("menuitem", "Download"));
}

test("An anonymous reader shares the stable snapshot and downloads newly authorized bytes", async () => {
  const path = "/artifacts/abcdef1234.png#detail";
  const preview = "https://files.example.test/preview/launch-map.png";
  const initial = "https://files.example.test/download/initial.png";
  const renewed = "https://files.example.test/download/renewed.png";
  let authorizedDownload = initial;
  const clipboard = context.mocks.browser.clipboardWriteText();
  const browser = context.mocks.browser.blobDownload();

  context.mocks.api(
    artifactReferencesContract.publicUrl,
    ({ params, respond }) => {
      expect(params.reference).toBe("abcdef1234.png");
      return respond(200, {
        url: preview,
        downloadUrl: authorizedDownload,
        sharedThreadSnapshot: true,
        preview: { filename: "launch-map.png", contentType: "image/png" },
      });
    },
  );

  await setupPage({ context, path, host: "app.okou.ai", auth: null });

  const image = await screen.findByRole("img", { name: "launch-map.png" });
  expect(image).toHaveAttribute("src", `${preview}#detail`);
  expect(window.location.href).toBe(`${origin}${path}`);
  click(getControl("button", "Share"));
  await expect(screen.findByText("Link copied")).resolves.toBeInTheDocument();
  expect(clipboard.writes).toStrictEqual([`${origin}${path}`]);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByText("Anyone with the link")).not.toBeInTheDocument();

  authorizedDownload = renewed;
  await downloadFromViewer();
  await waitFor(() => {
    expect(browser.downloads).toStrictEqual([
      { filename: "launch-map.png", url: renewed, blob: null },
    ]);
  });
  expect(image).toHaveAttribute("src", `${preview}#detail`);
  expect(window.location.href).toBe(`${origin}${path}`);
});

test("An anonymous HTML snapshot preserves its slide fragment, sandbox and download credential", async () => {
  const path = "/artifacts/abcdef1234.html#slide-2";
  const preview = "https://sh-launch.okou.app/index.html?access=preview";
  const downloadUrl =
    "https://sh-launch.okou.app/download.html?access=download";
  const browser = context.mocks.browser.blobDownload();
  context.mocks.api(artifactReferencesContract.publicUrl, ({ respond }) => {
    return respond(200, {
      url: preview,
      downloadUrl,
      sharedThreadSnapshot: true,
      preview: { filename: "launch.html", contentType: "text/html" },
    });
  });
  context.mocks.api(artifactDownloadsContract.files, ({ respond }) => {
    return respond(403, {
      error: { code: "FORBIDDEN", message: "Publication listing unavailable" },
    });
  });

  await setupPage({ context, path, host: "app.okou.ai", auth: null });

  await waitFor(() => {
    const frame = screen.getByRole("main").querySelector("iframe");
    expect(frame).toHaveAttribute("src", `${preview}#slide-2`);
    expect(frame).toHaveAttribute("sandbox", "allow-same-origin allow-scripts");
    expect(frame).toHaveAttribute("referrerpolicy", "origin");
  });
  await downloadFromViewer();

  await waitFor(() => {
    expect(browser.downloads).toStrictEqual([
      { filename: "launch.html", url: downloadUrl, blob: null },
    ]);
  });
});
