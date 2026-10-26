// @vitest-environment happy-dom
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { unzipSync, strToU8 } from "fflate";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { HostedSiteBannerActions } from "@okouai/ui/components/ui/artifact-banner";
import assets from "./site-banner-assets.json";

const siteUrl = "https://demo.okou.app/";
const server = setupServer();
beforeAll(() => {
  return server.listen({ onUnhandledRequest: "error" });
});
afterAll(() => {
  return server.close();
});

beforeEach(() => {
  const banner = document.createElement("div");
  banner.id = "okou-site-banner";
  banner.dataset.siteUrl = siteUrl;
  document.body.append(banner);
  banner.attachShadow({ mode: "open" }).innerHTML = renderToString(
    createElement(HostedSiteBannerActions, {
      continueUrl: "https://app.okou.ai/",
    }),
  );
  // Execute the same isolated browser entry point delivered with the banner.
  window.eval(assets.script);
});

afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  document.body.replaceChildren();
  vi.restoreAllMocks();
  server.resetHandlers();
});

function controls() {
  const root = document.getElementById("okou-site-banner")!.shadowRoot!;
  return {
    share: root.querySelector<HTMLButtonElement>('button[aria-label="Share"]')!,
    status: root.querySelector<HTMLElement>('[role="status"]')!,
    download: root.querySelector<HTMLButtonElement>(
      'button[aria-label="Download"]',
    )!,
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

const members = [
  {
    path: "/index.html",
    contentType: "text/html",
    bytes: strToU8("<h1>Original publication</h1>"),
  },
  {
    path: "/assets/site.css",
    contentType: "text/css",
    bytes: strToU8("h1 { color: teal }"),
  },
  {
    path: "/assets/chart.png",
    contentType: "image/png",
    bytes: new Uint8Array([0x89, 0x50, 0xff, 0]),
  },
];

function mockPublication(selected = members) {
  const origin = window.location.origin;
  server.use(
    http.get(new URL("/.okou/files", origin).href, () => {
      return HttpResponse.json({
        publicSlug: "demo",
        files: selected.map((member) => {
          const url = new URL("/.okou/download", origin);
          url.searchParams.set(
            "deploymentId",
            "00000000-0000-4000-8000-000000000001",
          );
          url.searchParams.set("path", member.path);
          return {
            path: member.path,
            contentType: member.contentType,
            downloadUrl: url.href,
          };
        }),
      });
    }),
    http.get(new URL("/.okou/download", origin).href, ({ request }) => {
      const member = selected.find((file) => {
        return file.path === new URL(request.url).searchParams.get("path");
      });
      return member
        ? HttpResponse.arrayBuffer(new Uint8Array(member.bytes).buffer, {
            headers: { "Content-Type": member.contentType },
          })
        : new HttpResponse(null, { status: 404 });
    }),
  );
}

function captureDownloads() {
  const objects = new Map<string, Blob>();
  const downloads: { filename: string; blob: Blob }[] = [];
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    if (!("arrayBuffer" in blob))
      throw new Error("Expected downloadable bytes");
    const url = `blob:download-${objects.size}`;
    objects.set(url, blob);
    return url;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
    objects.delete(url);
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    const blob = objects.get(this.href);
    if (!blob) throw new Error("Download bytes unavailable");
    downloads.push({ filename: this.download, blob });
  });
  return downloads;
}

it("downloads every publication member as a ZIP without leaving the Site", async () => {
  mockPublication();
  const downloads = captureDownloads();
  const { download } = controls();
  const before = location.href;
  download.click();
  await vi.waitFor(() => {
    return expect(downloads).toHaveLength(1);
  });
  expect(downloads[0]!.filename).toBe("demo.zip");
  const bytes = await downloads[0]!.blob.arrayBuffer();
  const archive = unzipSync(new Uint8Array(bytes));
  expect(Object.keys(archive).sort()).toStrictEqual([
    "assets/chart.png",
    "assets/site.css",
    "index.html",
  ]);
  for (const member of members) {
    expect(archive[member.path.slice(1)]).toStrictEqual(member.bytes);
  }
  expect(download.disabled).toBe(false);
  expect(location.href).toBe(before);
});

it("downloads a single-file Site as its original HTML file", async () => {
  mockPublication(members.slice(0, 1));
  const downloads = captureDownloads();
  controls().download.click();
  await vi.waitFor(() => {
    return expect(downloads).toHaveLength(1);
  });
  expect(downloads[0]!.filename).toBe("index.html");
  const bytes = await downloads[0]!.blob.arrayBuffer();
  expect(new Uint8Array(bytes)).toStrictEqual(members[0]!.bytes);
});

it.each(["listing", "member"])(
  "shows download failure without saving partial bytes when a %s is unavailable",
  async (failure) => {
    mockPublication();
    server.use(
      http.get(
        new URL(
          failure === "listing" ? "/.okou/files" : "/.okou/download",
          location.origin,
        ).href,
        () => {
          return new HttpResponse(null, { status: 403 });
        },
      ),
    );
    const downloads = captureDownloads();
    const { download, status } = controls();
    download.click();
    await vi.waitFor(() => {
      return expect(status.textContent).toBe("Download failed");
    });
    expect(status.hidden).toBe(false);
    expect(download.disabled).toBe(false);
    expect(downloads).toStrictEqual([]);
  },
);

it("cancels an in-flight download when the Site is left", async () => {
  const started = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  server.use(
    http.get(new URL("/.okou/files", location.origin).href, () => {
      started.resolve();
      return response.promise;
    }),
  );
  const downloads = captureDownloads();
  const { download, status } = controls();
  download.click();
  await started.promise;
  window.dispatchEvent(new Event("pagehide"));
  response.resolve(new HttpResponse(null, { status: 503 }));
  await vi.waitFor(() => {
    expect(download.disabled).toBe(false);
  });
  expect(downloads).toStrictEqual([]);
  expect(status.hidden).toBe(true);
});
