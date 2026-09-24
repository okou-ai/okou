import {
  artifactReferencePath,
  artifactReferencesContract,
} from "@okouai/api-contracts/contracts/artifact-references";
import { artifactSharesContract } from "@okouai/api-contracts/contracts/artifact-shares";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { beforeEach, expect, test, vi } from "vitest";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  testContext,
  warmMermaidParser,
} from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
beforeEach(() => {
  context.mocks.api(artifactSharesContract.status, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Artifact not found" },
    });
  });
  context.mocks.api(artifactReferencesContract.publicUrl, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Artifact unavailable" },
    });
  });
});

warmMermaidParser();
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
  colorThemes = false,
}: {
  path?: string;
  filename?: string;
  contentType?: string;
  url?: string;
  colorThemes?: boolean;
} = {}) {
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
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
  });
  await setupPage({
    context,
    path,
    host: "app.okou.ai",
    featureSwitches: {
      [FeatureSwitchKey.PrivateArtifacts]: true,
      [FeatureSwitchKey.GradientColorThemes]: colorThemes,
    },
  });
}

test("an image link stays in the app and reuses the lightbox preview and zoom controls", async () => {
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
  expect(
    screen.getByRole("heading", { name: "launch.png" }),
  ).toBeInTheDocument();
  expect(document.title).toBe("launch.png | Okou");
  await expect(
    screen.findByTestId("artifact-dialog-image-zoom-controls"),
  ).resolves.toBeInTheDocument();
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
});

test("Share copies the current app address without changing sharing or copying a signature", async () => {
  const path = imagePath;
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
  await expect(screen.findByText("Link copied")).resolves.toBeInTheDocument();
  expect(shareChanges).toStrictEqual([]);
  expect(queryAllByRoleFast("menuitem")).toHaveLength(0);
});

test("downloads resolve references and save the original filename and bytes", async () => {
  const path = `/share/artifacts/${artifactId}?source=shared#detail`;
  const browser = context.mocks.browser.blobDownload();
  context.mocks.http.get("https://artifacts.example.com/launch.png", () => {
    return HttpResponse.text("original image bytes", {
      headers: { "Content-Type": "image/png" },
    });
  });
  await openViewer({
    path,
  });
  click(action("button", "Download options"));
  await waitFor(() => {
    expect(action("menuitem", "Download")).toBeInTheDocument();
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
  expect(frame).toHaveAttribute("referrerpolicy", "origin");
  const href = action("link", "Continue with Okou").getAttribute("href");
  expect(href).not.toBeNull();
  const handoff = new URL(href ?? "");
  expect(handoff.origin).toBe("https://app.okou.ai");
  expect(handoff.pathname).toBe("/");
  expect(handoff.searchParams.get("prompt")).toBe(
    `Help me work with this artifact: https://app.okou.ai${artifactReferencePath(artifactId, "index.html")}#slide-2`,
  );
});

test("an external HTML preview receives no app or artifact referrer", async () => {
  await openViewer({
    filename: "index.html",
    contentType: "text/html",
    url: "https://preview.okou.app.untrusted.example/index.html",
  });
  await expect(
    screen.findByTitle("index.html preview"),
  ).resolves.toHaveAttribute("referrerpolicy", "no-referrer");
});

test.each([
  [403, true],
  [404, false],
] as const)(
  "unavailable links offer recovery without disclosing content: status %s, viewer %s",
  async (status, privateArtifacts) => {
    context.mocks.browser.matchMedia(true);
    context.mocks.data.userPreferences({ colorTheme: "blue-horizon" });
    context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
      return respond(status, {
        error: { code: "NOT_FOUND", message: "Artifact unavailable" },
      });
    });
    await setupPage({
      context,
      path: imagePath,
      host: "app.okou.ai",
      auth: {
        user: {
          id: "recipient",
          fullName: "Alex Rivera",
          email: "alex@example.test",
        },
      },
      featureSwitches: {
        [FeatureSwitchKey.PrivateArtifacts]: privateArtifacts,
        [FeatureSwitchKey.GradientColorThemes]: true,
      },
    });

    expect(
      screen.getByRole("heading", { name: "You can’t view this artifact" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Artifacts" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("attachment-lightbox-image"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("main").querySelector("iframe")).toBeNull();
    expect(document.title).toBe("Artifacts | Okou");
    expect(screen.queryByText("launch.png")).not.toBeInTheDocument();
    expect(action("button", "Switch account")).toBeEnabled();
    expect(action("button", "Try again")).toBeEnabled();
    expect(action("link", "Back to Okou")).toHaveAttribute("href", "/");
    expect(queryAllByRoleFast("button")).toHaveLength(2);
    // One status covers every denial, so a signed-in visitor is told both
    // possibilities rather than the signed-out guess about privacy.
    expect(
      screen.getByText(
        /It may not exist, or it may be shared with a different account or organization\./u,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/It may be private or no longer available\./u),
    ).not.toBeInTheDocument();
    await expect(
      screen.findByText("Signed in as alex@example.test"),
    ).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute("data-theme", "dark");
      expect(document.documentElement).toHaveAttribute(
        "data-color-theme",
        "blue-horizon",
      );
      expect(document.documentElement).toHaveAttribute(
        "data-gradient-color-themes",
      );
    });
  },
);

async function openUnavailableArtifact(path = imagePath) {
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Artifact unavailable" },
    });
  });
  await setupPage({ context, path, host: "app.okou.ai" });
  expect(
    screen.getByRole("heading", { name: "You can’t view this artifact" }),
  ).toBeInTheDocument();
}

test("switching accounts keeps the artifact URL and leaves the current session signed in", async () => {
  await openUnavailableArtifact(`${imagePath}?source=shared#detail`);
  click(action("button", "Switch account"));
  await waitFor(() => {
    expect(mockedClerk.openSignIn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        fallbackRedirectUrl: `https://app.okou.ai${imagePath}?source=shared#detail`,
        forceRedirectUrl: `https://app.okou.ai${imagePath}?source=shared#detail`,
      }),
    );
  });
  expect(mockedClerk.signOut).not.toHaveBeenCalled();
});

test("A shared Markdown artifact displays its diagram", async () => {
  const browser = context.mocks.browser.blobDownload();
  const url = "https://artifacts.example.com/plan.md";
  context.mocks.http.get(url, () => {
    return HttpResponse.text(
      "# Shared plan\n\n```mermaid\nflowchart LR\n  Shared --> Preview\n```",
    );
  });
  await openViewer({
    path: artifactReferencePath(artifactId, "plan.md"),
    filename: "plan.md",
    contentType: "text/markdown",
    url,
  });

  await expect(screen.findByText("Shared plan")).resolves.toBeInTheDocument();
  const image = await screen.findByRole("img", { name: "Diagram" });
  const imageUrl = image.getAttribute("src");
  if (!imageUrl) {
    throw new Error("Expected the shared diagram image URL");
  }
  expect(browser.blobForUrl(imageUrl)?.type).toBe("image/svg+xml");
  expect(action("button", "Expand diagram")).toBeEnabled();

  click(action("button", "Expand diagram"));

  const dialog = await screen.findByRole("dialog");
  // The expanded copy mounts its own image, so it owns a separate object URL
  // for the same rendered diagram.
  const expanded = await within(dialog).findByTestId(
    "attachment-lightbox-image",
  );
  const expandedUrl = expanded.getAttribute("src");
  if (!expandedUrl) {
    throw new Error("Expected the expanded diagram to have a source");
  }
  expect(browser.blobForUrl(expandedUrl)?.type).toBe("image/svg+xml");
  expect(within(dialog).getByText("diagram.svg")).toBeInTheDocument();
  // A diagram drawn in this browser has no address worth copying.
  expect(
    queryAllByRoleFast("button", dialog).map((button) => {
      return button.getAttribute("aria-label") ?? button.textContent?.trim();
    }),
  ).not.toContain("Copy link");
});

test("the viewer names who can reach the artifact without opening the share menu", async () => {
  context.mocks.api(artifactSharesContract.status, ({ respond }) => {
    return respond(200, {
      ownerUrl: `https://app.okou.ai${imagePath}`,
      shareId: artifactId,
      audience: "public",
      organization: { id: "org_test", name: "Acme" },
      selectedTarget: null,
      selectedVersion: null,
      candidateVersion: null,
      url: `https://app.okou.ai${imagePath}`,
      shortUrl: `https://app.okou.ai${imagePath}`,
    });
  });
  await openViewer();

  // The audience is a standing fact about the artifact, so it belongs beside
  // the kind rather than behind a menu. The subtitle composes the two from
  // separate nodes, so the match is on the rendered line.
  await expect(
    screen.findByText((_content, element) => {
      return (
        element?.tagName === "P" &&
        element.textContent === "Image · Public access"
      );
    }),
  ).resolves.toBeVisible();
});
