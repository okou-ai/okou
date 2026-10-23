// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { HostedSiteBannerActions } from "@okouai/ui/components/ui/artifact-banner";
import assets from "./site-banner-assets.json";

const siteUrl = "https://demo.okou.app/";

beforeEach(() => {
  const banner = document.createElement("div");
  banner.id = "okou-site-banner";
  banner.dataset.siteUrl = siteUrl;
  document.body.append(banner);
  banner.attachShadow({ mode: "open" }).innerHTML = renderToString(
    createElement(HostedSiteBannerActions, {
      continueUrl: "https://app.okou.ai/",
      downloadUrl: "https://app.okou.ai/artifacts?downloadSite=demo",
    }),
  );
  // Execute the same isolated browser entry point delivered with the banner.
  window.eval(assets.script);
});

afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function controls() {
  const root = document.getElementById("okou-site-banner")!.shadowRoot!;
  return {
    share: root.querySelector<HTMLButtonElement>('button[aria-label="Share"]')!,
    status: root.querySelector<HTMLElement>('[role="status"]')!,
  };
}

it("copies the site link with visible feedback and keeps Share available for another copy", async () => {
  const copied: string[] = [];
  vi.spyOn(navigator.clipboard, "writeText").mockImplementation((value) => {
    copied.push(value);
    return Promise.resolve();
  });
  const { share, status } = controls();
  share.click();
  await vi.waitFor(() => {
    expect(status.textContent).toBe("Link copied");
  });
  expect(status.hidden).toBe(false);
  expect(share.getAttribute("aria-label")).toBe("Share");
  expect(copied).toStrictEqual([siteUrl]);
  share.click();
  await vi.waitFor(() => {
    expect(copied).toStrictEqual([siteUrl, siteUrl]);
  });
});

it("shows a visible error when the browser refuses clipboard access", async () => {
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
    new DOMException("Clipboard access denied", "NotAllowedError"),
  );
  const { share, status } = controls();
  share.click();
  await vi.waitFor(() => {
    expect(status.textContent).toBe("Could not copy link");
  });
  expect(status.hidden).toBe(false);
  expect(share.getAttribute("aria-label")).toBe("Share");
});
