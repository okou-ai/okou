import { writeHostedPublicationZip } from "@okouai/core/hosted-publication-zip";
import {
  HOSTED_SITE_FILES_PATH,
  HOSTED_SITE_FILE_DOWNLOAD_PATH,
  hostedSiteDownloadManifestSchema,
} from "@okouai/api-contracts/contracts/hosted-site-download";

const banner = document.getElementById("okou-site-banner");
const root = banner?.shadowRoot;
const share = root?.querySelector<HTMLButtonElement>(
  "[data-okou-banner-share]",
);
const fullscreen = root?.querySelector<HTMLButtonElement>(
  "[data-okou-banner-fullscreen]",
);
const download = root?.querySelector<HTMLButtonElement>(
  "[data-okou-banner-download]",
);
const status = root?.querySelector<HTMLElement>("[data-okou-banner-status]");
const message = root?.querySelector<HTMLElement>("[data-okou-banner-message]");
let notificationTimer: ReturnType<typeof setTimeout> | undefined;
let activeDownload: AbortController | undefined;
const downloadCleanup = new Set<() => void>();

function notify(text: string, error = false) {
  if (!status || !message) return;
  clearTimeout(notificationTimer);
  status.toggleAttribute("data-error", error);
  message.textContent = text;
  status.hidden = false;
  notificationTimer = setTimeout(() => {
    status.hidden = true;
  }, 3000);
}

window.addEventListener("pagehide", () => {
  clearTimeout(notificationTimer);
  if (status) status.hidden = true;
  activeDownload?.abort();
  for (const release of downloadCleanup) release();
});

function saveDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  const release = () => {
    clearTimeout(timer);
    anchor.remove();
    URL.revokeObjectURL(url);
    downloadCleanup.delete(release);
  };
  // Safari may consume the bytes after click returns, as in the App downloader.
  const timer = setTimeout(release, 60_000);
  downloadCleanup.add(release);
  anchor.click();
}

function downloadAddress(value: string): URL {
  const url = new URL(value);
  if (
    url.origin !== location.origin ||
    url.pathname !== HOSTED_SITE_FILE_DOWNLOAD_PATH
  ) {
    throw new Error("Invalid Site download address");
  }
  return url;
}

function readDownload(
  url: string | URL,
  signal: AbortSignal,
): Promise<Response> {
  return fetch(url, {
    credentials: "same-origin",
    redirect: "error",
    cache: "no-store",
    signal,
  });
}

async function downloadPublication(signal: AbortSignal) {
  const response = await readDownload(
    new URL(HOSTED_SITE_FILES_PATH, location.origin),
    signal,
  );
  if (!response.ok) throw new Error("Site download unavailable");
  const publication = hostedSiteDownloadManifestSchema.parse(
    await response.json(),
  );
  signal.throwIfAborted();
  const members = publication.files.map((file) => {
    return {
      ...file,
      deliveryUrl: downloadAddress(file.downloadUrl).href,
    };
  });
  if (members.length === 1) {
    const member = members[0]!;
    const file = await readDownload(member.deliveryUrl, signal);
    if (!file.ok) throw new Error("Site file unavailable");
    const blob = await file.blob();
    signal.throwIfAborted();
    saveDownload(blob, member.path.slice(member.path.lastIndexOf("/") + 1));
    return;
  }
  const chunks: Uint8Array[] = [];
  const complete = await writeHostedPublicationZip(
    {
      members,
      baseUrl: location.origin,
      read: readDownload,
      write: (chunk) => {
        chunks.push(chunk);
      },
    },
    signal,
  );
  signal.throwIfAborted();
  if (!complete) throw new Error("Site file unavailable");
  saveDownload(
    new Blob(chunks as BlobPart[], { type: "application/zip" }),
    `${publication.publicSlug}.zip`,
  );
}

download?.addEventListener("click", async () => {
  const controller = new AbortController();
  activeDownload = controller;
  download.disabled = true;
  download.setAttribute("aria-busy", "true");
  try {
    await downloadPublication(controller.signal);
  } catch {
    if (!controller.signal.aborted) notify("Download failed", true);
  } finally {
    activeDownload = undefined;
    download.disabled = false;
    download.removeAttribute("aria-busy");
  }
});

share?.addEventListener("click", () => {
  const siteUrl = banner?.dataset.siteUrl;
  if (!siteUrl) return;
  if (!navigator.clipboard) {
    notify("Could not copy link", true);
    return;
  }
  return navigator.clipboard.writeText(siteUrl).then(
    () => {
      notify("Link copied");
    },
    () => {
      notify("Could not copy link", true);
    },
  );
});

fullscreen?.addEventListener("click", () => {
  if (typeof document.documentElement.requestFullscreen !== "function") {
    notify("Fullscreen is unavailable", true);
    return;
  }
  return document.documentElement.requestFullscreen().catch(() => {
    notify("Fullscreen is unavailable", true);
  });
});
