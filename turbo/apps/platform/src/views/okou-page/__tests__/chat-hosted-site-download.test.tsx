// @vitest-environment-options {"url":"https://app.okou.ai/","settings":{"disableIframePageLoading":true,"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { test, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { unzipSync, strFromU8 } from "fflate";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { click } from "../../../__tests__/page-helper.ts";
import { findAction } from "./connector-integrations-test-helpers.ts";
import { conversation, assistantRow } from "./attachment-preview-boundaries.ts";
import {
  artifactFile,
  findNamedMenuItem,
} from "./chat-attachment-test-helpers.ts";
import {
  publication,
  servePublication,
  entryHtml,
  stylesheet,
  catPng,
} from "./hosted-download-boundaries.ts";
const context = testContext();
async function downloadFromLink(
  path: string,
  kind?: "presentation-html" | "hosted-site",
  image = false,
) {
  const url = new URL(path, publication).href;
  const title = "Quarterly launch report";
  const name = image ? "cat.png" : "launch-site.html";
  const label = image ? "View field photo" : "View publication";
  await conversation(context, {
    chatEvents: [assistantRow("[" + label + "](" + url + ")")],
    artifacts: [
      artifactFile(name, {
        url,
        title: kind ? title : undefined,
        artifactKind: kind,
        contentType: image ? "image/png" : "text/html",
      }),
    ],
  });
  click(await findAction("link", label));
  const panel = await screen.findByTestId("attachment-lightbox");
  click(await findAction("button", "Download options", panel));
  click(await findNamedMenuItem("Download"));
  return panel;
}
test.each([
  ["chat-hosted-site-download-001", "/"],
  ["chat-hosted-site-download-002", "/notes/spring?locale=en#results"],
] as const)(
  "%s saves the complete published directory from its chat link",
  async (_id, path) => {
    const browser = context.mocks.browser.blobDownload();
    servePublication(context);
    await downloadFromLink(path);
    await waitFor(() => {
      return expect(browser.downloads[0]?.filename).toBe("launch-site.zip");
    });
    const zip = unzipSync(
      new Uint8Array(await browser.downloads[0]!.blob!.arrayBuffer()),
    );
    expect(Object.keys(zip).sort()).toStrictEqual([
      "assets/cat.png",
      "assets/site.css",
      "index.html",
    ]);
    expect(strFromU8(zip["index.html"]!)).toBe(entryHtml);
    expect(strFromU8(zip["assets/site.css"]!)).toBe(stylesheet);
    expect(Array.from(zip["assets/cat.png"]!)).toStrictEqual(
      Array.from(catPng),
    );
  },
);
test.each([
  ["chat-hosted-site-download-008", "hosted-site", "website"],
  ["chat-hosted-site-download-009", "presentation-html", "presentation"],
] as const)(
  "%s preserves the title, HTML and product classification",
  async (_id, kind, product) => {
    const browser = context.mocks.browser.blobDownload(),
      analytics = context.mocks.posthog();
    servePublication(context, "single");
    const panel = await downloadFromLink("/", kind);
    expect(panel).toHaveTextContent("Quarterly launch report");
    await waitFor(() => {
      return expect(browser.downloads[0]?.filename).toBe("launch-site.html");
    });
    await expect(browser.downloads[0]!.blob!.text()).resolves.toBe(entryHtml);
    expect(analytics.events).toContainEqual(
      expect.objectContaining({
        name: "artifact_action_clicked",
        properties: {
          action: "download",
          surface: "dialog",
          artifact_type: product,
        },
      }),
    );
  },
);
test.each([
  ["chat-hosted-site-download-010", "server-error"],
  ["chat-hosted-site-download-011", "broken-css"],
] as const)(
  "%s reports a failed publication without saving a partial file",
  async (_id, failure) => {
    const browser = context.mocks.browser.blobDownload();
    servePublication(context, failure);
    await downloadFromLink("/");
    await expect(
      screen.findByText("Download failed"),
    ).resolves.toBeInTheDocument();
    expect(browser.downloads).toStrictEqual([]);
  },
);
test("chat-hosted-site-download-013 the public page remains downloadable after its manifest returns not found", async () => {
  const browser = context.mocks.browser.blobDownload();
  servePublication(context, "missing");
  await downloadFromLink("/");
  await waitFor(() => {
    return expect(browser.downloads[0]?.filename).toBe("launch-site.html");
  });
  await expect(browser.downloads[0]!.blob!.text()).resolves.toBe(entryHtml);
});
test.each([
  ["chat-hosted-site-download-014", "/assets/cat.png", "directory"],
  ["chat-hosted-site-download-016", "/image/", "image-route"],
] as const)(
  "%s saves the requested image bytes alone",
  async (_id, path, mode) => {
    const browser = context.mocks.browser.blobDownload();
    servePublication(context, mode);
    await downloadFromLink(path, undefined, true);
    await waitFor(() => {
      return expect(
        browser.downloads.map((d) => {
          return d.filename;
        }),
      ).toStrictEqual(["cat.png"]);
    });
    expect(
      new Uint8Array(await browser.downloads[0]!.blob!.arrayBuffer()),
    ).toStrictEqual(catPng);
  },
);
