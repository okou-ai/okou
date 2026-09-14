import {
  artifactReferencePath,
  artifactReferencesContract,
} from "@okouai/api-contracts/contracts/artifact-references";
import { artifactSharesContract } from "@okouai/api-contracts/contracts/artifact-shares";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const artifactId = "00000000-0000-4000-8000-000000000010";
const imagePath = artifactReferencePath(artifactId, "launch.png");
const imageUrl = "https://artifacts.example.com/launch.png?signature=private";

function action(role: "button" | "link" | "menuitem", name: string) {
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

async function openViewer({
  path = imagePath,
  filename = "launch.png",
  contentType = "image/png",
  url = imageUrl,
}: {
  path?: string;
  filename?: string;
  contentType?: string;
  url?: string;
} = {}) {
  const resolutions: string[] = [];
  context.mocks.api(
    artifactReferencesContract.resolve,
    ({ params, respond }) => {
      resolutions.push(params.reference);
      return respond(200, {
        url,
        expiresAt: "2099-01-01T00:00:00Z",
        filename,
        contentType,
        target: {
          kind: contentType === "text/html" ? "html" : "file",
          id: artifactId,
        },
      });
    },
  );
  await setupPage({
    context,
    path,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.ArtifactViewer]: true },
  });
  return resolutions;
}

test("an image link stays in the app and reuses the lightbox preview and file details", async () => {
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
    1600,
  );
  vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(
    900,
  );
  const redirect = vi
    .spyOn(window.location, "replace")
    .mockImplementation(() => {});
  await openViewer();

  await expect(
    screen.findByTestId("attachment-lightbox-image"),
  ).resolves.toHaveAttribute("src", imageUrl);
  expect(screen.getByRole("heading", { name: "launch.png" })).toBeVisible();
  expect(document.title).toBe("launch.png | Okou");
  await expect(
    screen.findByTestId("artifact-dialog-image-zoom-controls"),
  ).resolves.toBeVisible();
  expect(redirect).not.toHaveBeenCalled();
  click(action("button", "Zoom in"));
  await waitFor(() => {
    expect(
      Number.parseInt(
        screen.getByTestId("artifact-dialog-image-zoom-level").textContent ??
          "0",
        10,
      ),
    ).toBeGreaterThan(100);
  });
  click(action("button", "Reset zoom"));
  expect(
    screen.getByTestId("artifact-dialog-image-zoom-level"),
  ).toHaveTextContent("100%");

  click(action("button", "File details"));
  await expect(screen.findByText("image/png")).resolves.toBeVisible();
  expect(screen.getByText("File name")).toBeVisible();
});

test.each([imagePath, `/share/artifacts/${artifactId}`])(
  "Share copies the current app address without changing sharing or copying a signature: %s",
  async (path) => {
    const clipboard = context.mocks.browser.clipboardWriteText();
    const shareChanges: string[] = [];
    context.mocks.api(artifactSharesContract.update, ({ body, respond }) => {
      shareChanges.push(body.audience);
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Unavailable" },
      });
    });
    await openViewer({ path: `${path}#detail` });
    click(action("button", "Share"));

    await waitFor(() => {
      expect(clipboard.writes).toStrictEqual([
        `https://app.okou.ai${path}#detail`,
      ]);
    });
    await expect(screen.findByText("Link copied")).resolves.toBeVisible();
    expect(shareChanges).toStrictEqual([]);
    expect(queryAllByRoleFast("menuitem")).toHaveLength(0);
  },
);

test("clipboard failure is reported without claiming that the link was copied", async () => {
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
    new DOMException("Clipboard denied", "NotAllowedError"),
  );
  await openViewer();
  click(action("button", "Share"));

  await expect(screen.findByText("Failed to copy link")).resolves.toBeVisible();
  expect(screen.queryByText("Link copied")).not.toBeInTheDocument();
});

test("downloads resolve a legacy link again and save the original filename and bytes", async () => {
  const browser = context.mocks.browser.blobDownload();
  context.mocks.http.get("https://artifacts.example.com/launch.png", () => {
    return HttpResponse.text("original image bytes", {
      headers: { "Content-Type": "image/png" },
    });
  });
  const resolutions = await openViewer({
    path: `/share/artifacts/${artifactId}?source=shared#detail`,
  });
  click(action("button", "Download options"));
  await waitFor(() => {
    expect(action("menuitem", "Download")).toBeVisible();
  });
  expect(queryAllByRoleFast("menuitem")).toHaveLength(1);
  click(action("menuitem", "Download"));

  await waitFor(() => {
    expect(browser.downloads).toHaveLength(1);
  });
  expect(browser.downloads[0]?.filename).toBe("launch.png");
  await expect(browser.downloads[0]?.blob?.text()).resolves.toBe(
    "original image bytes",
  );
  expect(resolutions).toStrictEqual([
    artifactId.replaceAll("-", ""),
    artifactId.replaceAll("-", ""),
  ]);
});

test("HTML stays on its isolated origin and retains the requested slide", async () => {
  const temporary = `https://ps-${"c".repeat(48)}.okou.app/`;
  await openViewer({
    path: `${artifactReferencePath(artifactId, "index.html")}#slide-2`,
    filename: "index.html",
    contentType: "text/html",
    url: temporary,
  });

  const frame = await screen.findByTitle("index.html preview");
  expect(frame).toHaveAttribute("src", `${temporary}#slide-2`);
  expect(frame).toHaveAttribute("sandbox", "allow-same-origin allow-scripts");
  const href = action("link", "Continue with Okou").getAttribute("href");
  expect(href).not.toBeNull();
  const handoff = new URL(href ?? "");
  expect(handoff.origin).toBe("https://app.okou.ai");
  expect(handoff.pathname).toBe("/");
  expect(handoff.searchParams.get("prompt")).toBe(
    `Help me work with this artifact: https://app.okou.ai${artifactReferencePath(artifactId, "index.html")}#slide-2`,
  );
});

test("PDF page fragments survive embedding in the viewer", async () => {
  await openViewer({
    path: `${artifactReferencePath(artifactId, "report.pdf")}#page=3`,
    filename: "report.pdf",
    contentType: "application/pdf",
    url: "https://artifacts.example.com/report.pdf?signature=private",
  });
  await expect(
    screen.findByTitle("report.pdf preview"),
  ).resolves.toHaveAttribute(
    "src",
    "https://artifacts.example.com/report.pdf?signature=private#page=3",
  );
});

test.each([400, 403, 404] as const)(
  "unavailable links retain the branded shell without content or actions: %s",
  async (status) => {
    context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
      return respond(status, {
        error: { code: "NOT_FOUND", message: "Artifact unavailable" },
      });
    });
    await setupPage({
      context,
      path: imagePath,
      host: "app.okou.ai",
      featureSwitches: { [FeatureSwitchKey.ArtifactViewer]: true },
    });

    expect(
      screen.getByText(
        "This artifact is unavailable or you do not have access.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("heading", { name: "Artifacts" })).toBeVisible();
    expect(
      screen.queryByTestId("attachment-lightbox-image"),
    ).not.toBeInTheDocument();
    expect(document.querySelector("iframe")).toBeNull();
    expect(queryAllByRoleFast("button")).toHaveLength(0);
  },
);
