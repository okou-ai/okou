import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { artifactSharesContract } from "@okouai/api-contracts/contracts/artifact-shares";
import { artifactReferencePath } from "@okouai/api-contracts/validators/artifact-references";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
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

function control(role: "button" | "link" | "menuitem", name: string) {
  const element = queryAllByRoleFast(role, document.body).find((candidate) => {
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

function mockUnsharedStatus() {
  context.mocks.api(artifactSharesContract.status, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Artifact not found" },
    });
  });
}

async function openImageArtifact(path: string) {
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    return respond(200, {
      downloadUrl: "https://artifacts.example.com/launch.png?download=1",
      url: imageUrl,
      expiresAt: "2099-01-01T00:00:00Z",
      filename: "launch.png",
      contentType: "image/png",
      target: { kind: "file", id: artifactId },
    });
  });
  await setupPage({ context, path, host: "app.okou.ai" });
}

async function openUnavailableArtifact(path: string): Promise<void> {
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Artifact unavailable" },
    });
  });
  context.mocks.api(artifactReferencesContract.publicUrl, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Artifact unavailable" },
    });
  });
  await setupPage({
    context,
    path,
    host: "app.okou.ai",
    auth: {
      user: {
        id: "recipient",
        fullName: "Alex Rivera",
        email: "alex@example.test",
      },
    },
  });
  await expect(
    screen.findByRole("heading", { name: "You can’t view this artifact" }),
  ).resolves.toBeInTheDocument();
}

test("An image artifact link stays in the app with its preview and zoom controls", async () => {
  const navigation = context.mocks.browser.locationReplace();
  mockUnsharedStatus();
  await openImageArtifact(imagePath);

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
  expect(window.location.href).toBe(`https://app.okou.ai${imagePath}`);
  expect(navigation.calls).toHaveLength(0);

  click(control("button", "Zoom in"));
  await waitFor(() => {
    expect(
      Number.parseInt(
        screen.getByTestId("artifact-dialog-image-zoom-level").textContent ??
          "0",
        10,
      ),
    ).toBeGreaterThan(100);
  });
  click(control("button", "Reset zoom"));
  await waitFor(() => {
    expect(
      screen.getByTestId("artifact-dialog-image-zoom-level"),
    ).toHaveTextContent("100%");
  });
});

test("Downloading a legacy shared artifact link uses its attachment URL and original filename", async () => {
  const browser = context.mocks.browser.blobDownload();
  mockUnsharedStatus();
  await openImageArtifact(
    `/share/artifacts/${artifactId}?source=shared#detail`,
  );

  click(control("button", "Download options"));
  await waitFor(() => {
    expect(control("menuitem", "Download")).toBeEnabled();
  });
  click(control("menuitem", "Download"));

  await waitFor(() => {
    expect(browser.downloads).toStrictEqual([
      {
        filename: "launch.png",
        url: "https://artifacts.example.com/launch.png?download=1",
        blob: null,
      },
    ]);
  });
});

test("A signed-in visitor denied with status 404 sees the access page without the artifact", async () => {
  context.mocks.data.userPreferences({ colorTheme: "blue-horizon" });
  await openUnavailableArtifact(imagePath);

  expect(
    screen.getByRole("heading", { name: "Artifacts" }),
  ).toBeInTheDocument();
  const main = screen.getByRole("main");
  expect(main).toHaveTextContent(
    "It may not exist, or it may be shared with a different account or organization.",
  );
  expect(control("button", "Switch account")).toBeEnabled();
  expect(control("link", "Back to Okou")).toHaveAttribute("href", "/");
  await expect(
    screen.findByText("Signed in as alex@example.test"),
  ).resolves.toBeVisible();
  await waitFor(() => {
    expect(document.documentElement).toHaveAttribute(
      "data-color-theme",
      "blue-horizon",
    );
  });
  expect(main).not.toHaveTextContent(
    "It may be private or no longer available.",
  );
  expect(screen.queryByText("launch.png")).not.toBeInTheDocument();
  expect(
    screen.queryByTestId("attachment-lightbox-image"),
  ).not.toBeInTheDocument();
  expect(main.querySelector("iframe")).toBeNull();
});

test("Switching accounts from an unavailable artifact keeps its full URL and the current session", async () => {
  const path = `${imagePath}?source=shared#detail`;
  await openUnavailableArtifact(path);

  click(control("button", "Switch account"));

  await waitFor(() => {
    expect(mockedClerk.openSignIn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        fallbackRedirectUrl: `https://app.okou.ai${path}`,
        forceRedirectUrl: `https://app.okou.ai${path}`,
      }),
    );
  });
  expect(mockedClerk.signOut).not.toHaveBeenCalled();
});

test("The artifact viewer names public access without opening the share menu", async () => {
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
  await openImageArtifact(imagePath);

  await expect(
    screen.findByText((_content, element) => {
      return (
        element?.tagName === "P" &&
        element.textContent === "Image · Public access"
      );
    }),
  ).resolves.toBeVisible();
});
