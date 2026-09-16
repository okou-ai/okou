import {
  artifactReferencePath,
  artifactReferencesContract,
} from "@okouai/api-contracts/contracts/artifact-references";
import { artifactSharesContract } from "@okouai/api-contracts/contracts/artifact-shares";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
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
    featureSwitches: {
      [FeatureSwitchKey.PrivateArtifacts]: true,
      [FeatureSwitchKey.GradientColorThemes]: colorThemes,
    },
  });
  return resolutions;
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
    await expect(screen.findByText("Link copied")).resolves.toBeInTheDocument();
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

  await expect(
    screen.findByText("Failed to copy link"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText("Link copied")).not.toBeInTheDocument();
});

test("the standalone viewer restores the selected app color theme", async () => {
  context.mocks.data.userPreferences({ colorTheme: "golden-hour" });
  await openViewer({ colorThemes: true });
  await waitFor(() => {
    expect(document.documentElement).toHaveAttribute(
      "data-color-theme",
      "golden-hour",
    );
    expect(document.documentElement).toHaveAttribute(
      "data-gradient-color-themes",
    );
  });
  expect(action("link", "Continue with Okou")).toBeInTheDocument();
});

test.each([
  [
    `/share/artifacts/${artifactId}?source=shared#detail`,
    artifactId.replaceAll("-", ""),
  ],
  ["/artifacts/a1b2c3d4e5.png#detail", "a1b2c3d4e5.png"],
])(
  "downloads resolve references and save the original filename and bytes: %s",
  async (path, reference) => {
    const browser = context.mocks.browser.blobDownload();
    context.mocks.http.get("https://artifacts.example.com/launch.png", () => {
      return HttpResponse.text("original image bytes", {
        headers: { "Content-Type": "image/png" },
      });
    });
    const resolutions = await openViewer({
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
    expect(resolutions).toStrictEqual([reference, reference]);
  },
);

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

test.each([
  [400, true],
  [403, true],
  [404, true],
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

test("a failed account switch can be retried", async () => {
  mockedClerk.openSignIn.mockRejectedValueOnce(
    new Error("Account switch unavailable"),
  );
  await openUnavailableArtifact();
  click(action("button", "Switch account"));
  await expect(
    screen.findByText("Could not open the account switcher. Please try again."),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(action("button", "Switch account")).toBeEnabled();
  });
  click(action("button", "Switch account"));
  await waitFor(() => {
    expect(mockedClerk.openSignIn).toHaveBeenCalledTimes(2);
  });
});

test("retry reloads the current artifact without dropping its query or fragment", async () => {
  const reload = vi
    .spyOn(window.location, "reload")
    .mockImplementation(() => {});
  await openUnavailableArtifact(`${imagePath}?source=shared#detail`);
  click(action("button", "Try again"));
  expect(reload).toHaveBeenCalledExactlyOnceWith();
  expect(window.location.href).toBe(
    `https://app.okou.ai${imagePath}?source=shared#detail`,
  );
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
});
